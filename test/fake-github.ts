// In-memory fake of the subset of the GitHub REST API the plugin uses.
// Lets tests run many multi-device scenarios offline and deterministically.
import { createHash } from "crypto";

function blobSha(bytes: Buffer) {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");
}

function objectSha(value: unknown) {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

export class FakeGitHub {
  blobs = new Map<string, Buffer>();
  // Trees are stored flat: path -> blob sha
  trees = new Map<string, { [path: string]: string }>();
  commits = new Map<string, { tree: string; parent: string | null }>();
  branch: string | null = null;
  requests: string[] = [];
  // Number of upcoming branch reads that return the head before the last push
  staleReads = 0;
  previousHead: string | null = null;
  // Called before the ref update, lets tests simulate a concurrent push
  beforeRefUpdate: (() => void) | null = null;

  // Helpers for tests
  headFiles(): { [path: string]: string } {
    if (!this.branch) return {};
    return { ...this.trees.get(this.commits.get(this.branch)!.tree)! };
  }
  headContent(p: string): string | undefined {
    const sha = this.headFiles()[p];
    return sha === undefined ? undefined : this.blobs.get(sha)!.toString("utf8");
  }
  commitCount(): number {
    let n = 0;
    for (let c = this.branch; c; c = this.commits.get(c)!.parent) n++;
    return n;
  }
  putBlob(bytes: Buffer) {
    const sha = blobSha(bytes);
    this.blobs.set(sha, bytes);
    return sha;
  }
  putTree(files: { [path: string]: string }) {
    const sha = objectSha(Object.entries(files).sort());
    this.trees.set(sha, files);
    return sha;
  }
  putCommit(tree: string, parent: string | null) {
    const sha = objectSha({ tree, parent, n: this.commits.size });
    this.commits.set(sha, { tree, parent });
    return sha;
  }
  /** Commits files directly, like an edit made on github.com */
  commitDirect(changes: { [path: string]: string | null }) {
    const files = this.headFiles();
    for (const [p, content] of Object.entries(changes)) {
      if (content === null) delete files[p];
      else files[p] = this.putBlob(Buffer.from(content, "utf8"));
    }
    this.branch = this.putCommit(this.putTree(files), this.branch);
  }

  handle(method: string, route: string, body: any) {
    let m: RegExpMatchArray | null;
    if (method === "GET" && /^branches\/[^/]+$/.test(route)) {
      if (!this.branch) return { status: 404, json: { message: "Branch not found" } };
      let head = this.branch;
      if (this.staleReads > 0 && this.previousHead) {
        // Simulates a cached / lagging read returning the previous head
        this.staleReads--;
        head = this.previousHead;
      }
      const c = this.commits.get(head)!;
      return {
        status: 200,
        json: { commit: { sha: head, commit: { tree: { sha: c.tree } } } },
      };
    }
    if (method === "GET" && (m = route.match(/^compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/))) {
      const isAncestor = (a: string, b: string) => {
        for (let c: string | null = b; c; c = this.commits.get(c)?.parent ?? null) {
          if (c === a) return true;
        }
        return false;
      };
      const [base, head] = [m[1], m[2]];
      if (!this.commits.has(base) || !this.commits.has(head)) return { status: 404, json: {} };
      const status =
        base === head ? "identical"
        : isAncestor(base, head) ? "ahead"
        : isAncestor(head, base) ? "behind"
        : "diverged";
      return { status: 200, json: { status } };
    }
    if (method === "GET" && (m = route.match(/^git\/trees\/([0-9a-f]+)$/))) {
      const t = this.trees.get(m[1]);
      if (!t) return { status: 404, json: {} };
      return {
        status: 200,
        json: {
          sha: m[1],
          truncated: false,
          tree: Object.entries(t).map(([p, sha]) => ({
            path: p,
            mode: "100644",
            type: "blob",
            sha,
          })),
        },
      };
    }
    if (method === "POST" && route === "git/trees") {
      const files = body.base_tree ? { ...this.trees.get(body.base_tree)! } : {};
      for (const item of body.tree) {
        if (item.content !== undefined) {
          files[item.path] = this.putBlob(Buffer.from(item.content, "utf8"));
        } else if (item.sha === null) {
          delete files[item.path];
        } else {
          if (!this.blobs.has(item.sha)) return { status: 422, json: {} };
          files[item.path] = item.sha;
        }
      }
      return { status: 201, json: { sha: this.putTree(files) } };
    }
    if (method === "POST" && route === "git/commits") {
      const sha = this.putCommit(body.tree, body.parents[0]);
      return { status: 201, json: { sha } };
    }
    if (method === "PATCH" && /^git\/refs\/heads\/[^/]+$/.test(route)) {
      this.beforeRefUpdate?.();
      this.beforeRefUpdate = null;
      // Non forced update: must be a fast forward
      let isFastForward = false;
      for (let c: string | null = body.sha; c; c = this.commits.get(c)!.parent) {
        if (c === this.branch) isFastForward = true;
      }
      if (!isFastForward && !body.force) {
        return { status: 422, json: { message: "Update is not a fast forward" } };
      }
      this.previousHead = this.branch;
      this.branch = body.sha;
      return { status: 200, json: {} };
    }
    if (method === "POST" && route === "git/blobs") {
      const sha = this.putBlob(Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8"));
      return { status: 201, json: { sha } };
    }
    if (method === "GET" && (m = route.match(/^git\/blobs\/([0-9a-f]+)$/))) {
      const b = this.blobs.get(m[1]);
      if (!b) return { status: 404, json: {} };
      return { status: 200, json: { sha: m[1], content: b.toString("base64"), encoding: "base64" } };
    }
    if (method === "PUT" && (m = route.match(/^contents\/(.+)$/))) {
      if (this.branch) return { status: 422, json: {} };
      const sha = this.putBlob(Buffer.from(body.content, "base64"));
      this.branch = this.putCommit(this.putTree({ [decodeURIComponent(m[1])]: sha }), null);
      return { status: 201, json: {} };
    }
    return { status: 500, json: { message: `fake: unhandled ${method} ${route}` } };
  }
}

let current: FakeGitHub | null = null;
export function useFakeGitHub(fake: FakeGitHub | null) {
  current = fake;
}

export function handleFakeRequest(options: { url: string; method?: string; body?: string }) {
  if (!current) return null;
  const url = new URL(options.url);
  const route = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+\//, "");
  const method = options.method || "GET";
  current.requests.push(`${method} ${route}`);
  const res = current.handle(method, route, options.body ? JSON.parse(options.body) : null);
  return { ...res, arrayBuffer: new ArrayBuffer(0) };
}
