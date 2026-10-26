// Runs the sync scenarios against a real, throwaway GitHub repository.
// DESTRUCTIVE for that repository: its branch is force-reset for every scenario.
//
//   GITHUB_TOKEN=... E2E_REPO=owner/name node scripts/test.mjs e2e
//
// The repo must exist and be dedicated to these tests. Run it empty the first
// time to also cover the empty-repository scenarios.
import * as os from "os";
import * as path from "path";
import { rmSync } from "fs";
import { Device } from "./device";
import { throttleWrite } from "./mock-obsidian";
import { Ctx, Files, Remote, scenarios } from "./scenarios";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.E2E_REPO;
const only = process.env.E2E_ONLY;
if (!token || !repo || !repo.includes("/")) {
  console.error("Set GITHUB_TOKEN and E2E_REPO=owner/name");
  process.exit(2);
}
const [owner, name] = repo.split("/");
const branch = "main";
const api = `https://api.github.com/repos/${owner}/${name}`;

async function gh(method: string, route: string, body?: unknown) {
  if (method !== "GET") await throttleWrite();
  const res = await fetch(`${api}/${route}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function ok(method: string, route: string, body?: unknown) {
  const res = await gh(method, route, body);
  if (res.status >= 400) {
    throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

async function headCommit(): Promise<string | null> {
  const res = await gh("GET", `branches/${branch}?nocache=${Date.now()}`);
  if (res.status === 404 || res.status === 409) return null;
  if (res.status >= 400) throw new Error(`branch read ${res.status}`);
  return res.json.commit.sha;
}

/** Moves the branch, then waits until GitHub serves the new head everywhere */
async function moveBranch(sha: string, force: boolean) {
  await ok("PATCH", `git/refs/heads/${branch}`, { sha, force });
  // Reads right after a ref update can briefly return the old head
  for (let seen = 0, i = 0; seen < 3 && i < 40; i++) {
    seen = (await headCommit()) === sha ? seen + 1 : 0;
    await new Promise((r) => setTimeout(r, 250));
  }
}

const remote: Remote = {
  async reset(files: Files) {
    const tree = await ok("POST", "git/trees", {
      tree: [
        // Keep at least one file, the API can't create an empty tree commit easily
        { path: ".gitless-sync", mode: "100644", type: "blob", content: "test\n" },
        ...Object.entries(files).map(([p, content]) => ({
          path: p,
          mode: "100644",
          type: "blob",
          content,
        })),
      ],
    });
    const commit = await ok("POST", "git/commits", {
      message: "e2e reset",
      tree: tree.sha,
      parents: [],
    });
    await moveBranch(commit.sha, true);
  },
  async files() {
    const head = await headCommit();
    if (!head) return {};
    const commit = await ok("GET", `git/commits/${head}`);
    const tree = await ok("GET", `git/trees/${commit.tree.sha}?recursive=1`);
    const out: Files = {};
    for (const item of tree.tree) {
      if (item.type !== "blob") continue;
      const blob = await ok("GET", `git/blobs/${item.sha}`);
      out[item.path] = Buffer.from(blob.content, "base64").toString("utf8");
    }
    return out;
  },
  async commit(changes) {
    const head = (await headCommit())!;
    const commit = await ok("GET", `git/commits/${head}`);
    const tree = await ok("POST", "git/trees", {
      base_tree: commit.tree.sha,
      tree: Object.entries(changes).map(([p, content]) =>
        content === null
          ? { path: p, mode: "100644", type: "blob", sha: null }
          : { path: p, mode: "100644", type: "blob", content },
      ),
    });
    const newCommit = await ok("POST", "git/commits", {
      message: "e2e direct edit",
      tree: tree.sha,
      parents: [head],
    });
    await moveBranch(newCommit.sha, false);
  },
  head: headCommit,
};

async function main() {
  const tmpRoot = path.join(os.tmpdir(), "gitless-sync-e2e");
  let repoIsEmpty = (await headCommit()) === null;
  let passed = 0;
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const scenario of scenarios) {
    if (only && !scenario.name.includes(only)) continue;
    if (scenario.fakeOnly || (scenario.emptyRepo && !repoIsEmpty)) {
      skipped.push(scenario.name);
      continue;
    }
    const dir = path.join(tmpRoot, scenario.name.replace(/[^a-z0-9]+/gi, "-"));
    rmSync(dir, { recursive: true, force: true });
    const ctx: Ctx = {
      remote,
      device: (n, settings) =>
        new Device(path.join(dir, n), {
          githubToken: token,
          githubOwner: owner,
          githubRepo: name,
          githubBranch: branch,
          ...settings,
        }).start(),
    };
    const started = Date.now();
    try {
      await scenario.run(ctx);
      passed++;
      console.log(`ok   ${scenario.name} (${Date.now() - started} ms)`);
    } catch (err) {
      failed.push(scenario.name);
      console.log(`FAIL ${scenario.name}\n     ${err}\n     logs in ${dir}`);
    }
    // Only the first scenario can see the repo empty
    repoIsEmpty = false;
  }
  console.log(`\n${passed} passed, ${failed.length} failed, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`skip ${s}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
