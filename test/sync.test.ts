// Runs all scenarios against the in-memory fake GitHub.
import { test } from "node:test";
import * as os from "os";
import * as path from "path";
import { rmSync } from "fs";
import { FakeGitHub, useFakeGitHub } from "./fake-github";
import { Device } from "./device";
import { Ctx, Files, Remote, scenarios } from "./scenarios";

function fakeRemote(fake: FakeGitHub): Remote {
  return {
    async reset(files: Files) {
      const tree: { [p: string]: string } = {};
      for (const [p, c] of Object.entries(files)) {
        tree[p] = fake.putBlob(Buffer.from(c, "utf8"));
      }
      fake.branch = fake.putCommit(fake.putTree(tree), null);
    },
    async files() {
      const out: Files = {};
      for (const p of Object.keys(fake.headFiles())) {
        out[p] = fake.headContent(p)!;
      }
      return out;
    },
    async commit(changes) {
      fake.commitDirect(changes);
    },
    async head() {
      return fake.branch;
    },
  };
}

const tmpRoot = path.join(os.tmpdir(), "gitless-sync-tests");

for (const scenario of scenarios) {
  test(scenario.name, async () => {
    const fake = new FakeGitHub();
    useFakeGitHub(fake);
    const dir = path.join(tmpRoot, scenario.name.replace(/[^a-z0-9]+/gi, "-"));
    rmSync(dir, { recursive: true, force: true });
    const ctx: Ctx = {
      fake,
      remote: fakeRemote(fake),
      device: (name, settings) =>
        new Device(path.join(dir, name), settings).start(),
    };
    try {
      await scenario.run(ctx);
    } finally {
      useFakeGitHub(null);
    }
  });
}
