// Multi-device sync scenarios. They run against the in-memory fake GitHub
// (test/sync.test.ts) and against a real GitHub repository (test/e2e.ts).
import * as assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as path from "path";
import { Device } from "./device";
import { GitHubSyncSettings } from "../src/settings/settings";

export type Files = { [path: string]: string };

export interface Remote {
  /** Replaces the whole branch content with these files */
  reset(files: Files): Promise<void>;
  /** All files on the branch, path -> utf8 content */
  files(): Promise<Files>;
  /** Commits changes directly, like an edit made on github.com */
  commit(changes: { [path: string]: string | null }): Promise<void>;
  /** Current branch head commit, null if the repo is empty */
  head(): Promise<string | null>;
}

export interface Ctx {
  remote: Remote;
  device(name: string, settings?: Partial<GitHubSyncSettings>): Promise<Device>;
  fake?: import("./fake-github").FakeGitHub;
}

export interface Scenario {
  name: string;
  run(ctx: Ctx): Promise<void>;
  // Needs the fake to simulate something impossible to trigger on demand
  fakeOnly?: boolean;
  // Needs a repository without any commit
  emptyRepo?: boolean;
}

const INIT = ".gitless-sync";
const LEGACY = ".obsidian/github-sync-metadata.json";

async function syncOk(...devices: Device[]) {
  for (const d of devices) {
    assert.equal(await d.sync(), true, `sync failed on ${d.root}`);
  }
}

/** Remote files without the init marker and legacy metadata */
async function remoteNotes(remote: Remote): Promise<Files> {
  const files = await remote.files();
  delete files[INIT];
  delete files[LEGACY];
  return files;
}

/** Two devices that already share the given notes */
async function pair(ctx: Ctx, files: Files) {
  await ctx.remote.reset(files);
  const a = await ctx.device("A");
  const b = await ctx.device("B");
  await syncOk(a, b);
  assert.deepEqual(await a.notes(), files);
  assert.deepEqual(await b.notes(), files);
  return { a, b };
}

export const scenarios: Scenario[] = [
  {
    name: "empty repo and empty vault: first sync initializes the repo",
    emptyRepo: true,
    async run(ctx) {
      const a = await ctx.device("A");
      await syncOk(a);
      assert.deepEqual(await remoteNotes(ctx.remote), {});
      assert.ok(INIT in (await ctx.remote.files()));
      assert.deepEqual(await a.notes(), {});
      await a.write("first.md", "hello");
      await syncOk(a);
      assert.deepEqual(await remoteNotes(ctx.remote), { "first.md": "hello" });
    },
  },
  {
    name: "empty repo: first sync uploads an existing vault",
    emptyRepo: true,
    async run(ctx) {
      const a = await ctx.device("A");
      await a.write("n1.md", "one");
      await a.write("dir/n2.md", "two");
      await syncOk(a);
      assert.deepEqual(await remoteNotes(ctx.remote), {
        "n1.md": "one",
        "dir/n2.md": "two",
      });
    },
  },
  {
    name: "empty vault: first sync downloads the repo",
    async run(ctx) {
      await ctx.remote.reset({ "a.md": "A", "sub/dir/b.md": "B" });
      const b = await ctx.device("B");
      await syncOk(b);
      assert.deepEqual(await b.notes(), { "a.md": "A", "sub/dir/b.md": "B" });
    },
  },
  {
    name: "edit on A reaches B",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "note.md": "v1" });
      await a.write("note.md", "v2 edited on A");
      await syncOk(a, b);
      assert.equal(b.read("note.md"), "v2 edited on A");
      assert.deepEqual(await remoteNotes(ctx.remote), {
        "note.md": "v2 edited on A",
      });
    },
  },
  {
    name: "two syncs in a row don't revert an edit (issue #37)",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "note.md": "v1" });
      await a.write("note.md", "v2");
      await syncOk(a);
      const head = await ctx.remote.head();
      await syncOk(a, a);
      assert.equal(a.read("note.md"), "v2");
      assert.equal(await ctx.remote.head(), head, "no extra commits");
      await syncOk(b, b);
      assert.equal(b.read("note.md"), "v2");
      assert.equal(await ctx.remote.head(), head);
    },
  },
  {
    name: "sync without changes creates no commit (issue #63)",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "note.md": "v1" });
      const head = await ctx.remote.head();
      await syncOk(a, b, a);
      assert.equal(await ctx.remote.head(), head);
    },
  },
  {
    name: "delete on A is removed on B and kept in B's .trash",
    async run(ctx) {
      const { a, b } = await pair(ctx, {
        "keep.md": "k",
        "dir/gone.md": "g",
      });
      await a.remove("dir/gone.md");
      await syncOk(a, b);
      assert.deepEqual(await b.notes(), { "keep.md": "k" });
      assert.equal(b.exists("dir"), false, "empty folder removed");
      assert.equal(b.read(".trash/dir/gone.md"), "g");
      assert.deepEqual(await remoteNotes(ctx.remote), { "keep.md": "k" });
      // And it stays deleted
      await syncOk(a, b);
      assert.deepEqual(await remoteNotes(ctx.remote), { "keep.md": "k" });
      assert.deepEqual(await a.notes(), { "keep.md": "k" });
    },
  },
  {
    name: "rename and move on A",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "old.md": "content" });
      await a.rename("old.md", "folder/new name.md");
      await syncOk(a, b);
      assert.deepEqual(await b.notes(), { "folder/new name.md": "content" });
      assert.deepEqual(await remoteNotes(ctx.remote), {
        "folder/new name.md": "content",
      });
    },
  },
  {
    name: "case-only rename",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "Note.md": "content" });
      await a.rename("Note.md", "tmp.md");
      await a.rename("tmp.md", "note.md");
      await syncOk(a, b);
      assert.deepEqual(await remoteNotes(ctx.remote), { "note.md": "content" });
      assert.deepEqual(await b.notes(), { "note.md": "content" });
      await syncOk(a, b);
      assert.deepEqual(await remoteNotes(ctx.remote), { "note.md": "content" });
    },
  },
  {
    name: "Untitled.md case: deletion reaches a device with the file unchanged",
    async run(ctx) {
      await ctx.remote.reset({ "Untitled.md": "", "x.md": "x" });
      const pc = await ctx.device("PC");
      const laptop = await ctx.device("laptop");
      const phone = await ctx.device("phone");
      await syncOk(pc, laptop, phone);
      await pc.remove("Untitled.md");
      await syncOk(pc);
      // The phone does other work in between, the laptop stays stale
      await phone.write("p.md", "from phone");
      await syncOk(phone);
      assert.equal(phone.exists("Untitled.md"), false);
      // Stale laptop syncs: the file is deleted there, never re-uploaded
      await syncOk(laptop);
      assert.equal(laptop.exists("Untitled.md"), false);
      await syncOk(pc, laptop, phone, pc);
      const expected = { "x.md": "x", "p.md": "from phone" };
      assert.deepEqual(await remoteNotes(ctx.remote), expected);
      for (const d of [pc, laptop, phone]) {
        assert.deepEqual(await d.notes(), expected);
      }
    },
  },
  {
    name: "file deleted on both devices before syncing doesn't crash",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "x.md": "x", "y.md": "y" });
      await a.remove("x.md");
      await b.remove("x.md");
      await syncOk(a, b, a);
      assert.deepEqual(await remoteNotes(ctx.remote), { "y.md": "y" });
      assert.deepEqual(b.state().files["x.md"], undefined);
    },
  },
  {
    name: "delete on A while B edits: the edit wins, nothing is lost",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "x.md": "v1" });
      await a.remove("x.md");
      await b.write("x.md", "v2 from B");
      await syncOk(a, b, a);
      assert.deepEqual(await remoteNotes(ctx.remote), { "x.md": "v2 from B" });
      assert.equal(a.read("x.md"), "v2 from B");
    },
  },
  {
    name: "simultaneous edits open the conflict view, resolution reaches both",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "x.md": "base\n" });
      await a.write("x.md", "base\nfrom A\n");
      await b.write("x.md", "base\nfrom B\n");
      b.onConflicts = async (conflicts) =>
        conflicts.map((c) => ({
          filePath: c.filePath,
          content: "base\nfrom A\nfrom B\n",
        }));
      await syncOk(a, b);
      assert.equal(b.seenConflicts.length, 1);
      assert.deepEqual(b.seenConflicts[0], [
        {
          filePath: "x.md",
          localContent: "base\nfrom B\n",
          remoteContent: "base\nfrom A\n",
        },
      ]);
      assert.equal(b.read("x.md"), "base\nfrom A\nfrom B\n");
      await syncOk(a, b, a);
      assert.equal(a.read("x.md"), "base\nfrom A\nfrom B\n");
      assert.equal(b.seenConflicts.length, 1, "no second conflict");
      assert.equal(a.seenConflicts.length, 0);
    },
  },
  {
    name: "identical edits on both devices are not a conflict",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "x.md": "v1" });
      await a.write("x.md", "same");
      await b.write("x.md", "same");
      await syncOk(a, b);
      assert.equal(b.seenConflicts.length, 0);
    },
  },
  {
    name: "conflict setting overwriteLocal and overwriteRemote",
    async run(ctx) {
      await ctx.remote.reset({ "x.md": "v1", "y.md": "v1" });
      const a = await ctx.device("A");
      const b = await ctx.device("B", { conflictHandling: "overwriteLocal" });
      const c = await ctx.device("C", { conflictHandling: "overwriteRemote" });
      await syncOk(a, b, c);
      await a.write("x.md", "A");
      await b.write("x.md", "B");
      await syncOk(a, b);
      assert.equal(b.read("x.md"), "A");
      await a.write("y.md", "A");
      await c.write("y.md", "C");
      await syncOk(a, c, a);
      assert.equal(a.read("y.md"), "C");
    },
  },
  {
    name: "edit made on github.com is downloaded (issue #45)",
    async run(ctx) {
      const { a } = await pair(ctx, { "x.md": "v1" });
      await ctx.remote.commit({ "x.md": "edited on web", "web.md": "new" });
      await syncOk(a);
      assert.deepEqual(await a.notes(), {
        "x.md": "edited on web",
        "web.md": "new",
      });
    },
  },
  {
    name: "hidden, workspace, state and config files are never synced",
    async run(ctx) {
      await ctx.remote.reset({ "x.md": "x" });
      const a = await ctx.device("A");
      await a.write(".obsidian/app.json", "{}");
      await a.write(".obsidian/workspace.json", "{}");
      await a.write(".trash/old.md", "old");
      await a.write("dir/.DS_Store", "junk");
      await a.write("n.md", "n");
      await syncOk(a);
      assert.deepEqual(await remoteNotes(ctx.remote), { "x.md": "x", "n.md": "n" });
    },
  },
  {
    name: "config sync enabled syncs config files but not internal ones",
    async run(ctx) {
      await ctx.remote.reset({ "x.md": "x" });
      const a = await ctx.device("A", { syncConfigDir: true });
      await a.write(".obsidian/app.json", '{"a":1}');
      await a.write(".obsidian/workspace.json", "{}");
      await a.write(LEGACY, "{}");
      await syncOk(a);
      const files = await ctx.remote.files();
      assert.equal(files[".obsidian/app.json"], '{"a":1}');
      for (const p of [
        ".obsidian/workspace.json",
        ".obsidian/github-sync-state.json",
        ".obsidian/github-sync.log",
        LEGACY,
      ]) {
        assert.ok(!(p in files), `${p} must not be synced`);
      }
    },
  },
  {
    name: "binary files and exact bytes (BOM, CRLF, unicode) round-trip",
    async run(ctx) {
      await ctx.remote.reset({});
      const a = await ctx.device("A");
      const b = await ctx.device("B");
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255, 254]);
      await fs.writeFile(path.join(a.root, "img.png"), png);
      const text = "﻿line one\r\nlíne twø 🙂\r\n";
      await a.write("bom.md", text);
      await syncOk(a, b);
      assert.deepEqual(await fs.readFile(path.join(b.root, "img.png")), png);
      assert.deepEqual(
        await fs.readFile(path.join(b.root, "bom.md")),
        await fs.readFile(path.join(a.root, "bom.md")),
      );
      const head = await ctx.remote.head();
      await syncOk(a, b);
      assert.equal(await ctx.remote.head(), head, "stable after round-trip");
    },
  },
  {
    name: "cached hashes still notice same-size edits",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "x.md": "aaaa" });
      // Make the file look old so its hash gets cached as trustworthy
      const old = new Date(Date.now() - 60_000);
      await fs.utimes(path.join(a.root, "x.md"), old, old);
      await syncOk(a);
      assert.ok(a.state().cache["x.md"].hashedAt - a.state().cache["x.md"].mtime > 2000);
      await a.write("x.md", "bbbb");
      await syncOk(a, b);
      assert.equal(b.read("x.md"), "bbbb");
    },
  },
  {
    name: "restarting the app keeps the sync state",
    async run(ctx) {
      const { a, b } = await pair(ctx, { "x.md": "v1" });
      await a.remove("x.md");
      await a.start();
      await syncOk(a, b);
      assert.equal(b.exists("x.md"), false);
    },
  },
  {
    name: "migration from v1.0.7: first sync merges without deleting",
    async run(ctx) {
      // Remote as left by v1.0.7: shared metadata that wrongly says
      // Untitled.md still exists and a note that only exists remotely
      const legacyRemote = JSON.stringify({
        lastSync: 1,
        files: {
          "a.md": { path: "a.md", sha: "x", dirty: false, justDownloaded: false, lastModified: 1 },
          "Untitled.md": { path: "Untitled.md", sha: "y", dirty: false, justDownloaded: false, lastModified: 1 },
        },
      });
      await ctx.remote.reset({
        "a.md": "same",
        "b.md": "remote version",
        "d.md": "only remote",
        [LEGACY]: legacyRemote,
      });
      // PC: deleted Untitled.md, edited b.md, created c.md, never synced it
      const pc = await ctx.device("PC");
      const legacyLocal = '{"lastSync":2,"files":{"Untitled.md":{"deleted":true}}}';
      await pc.write(LEGACY, legacyLocal);
      await pc.write("a.md", "same");
      await pc.write("b.md", "local version");
      await pc.write("c.md", "only local");
      await syncOk(pc);
      assert.equal(pc.seenConflicts.length, 1, "b.md differs: ask");
      assert.equal(pc.seenConflicts[0][0].filePath, "b.md");
      assert.deepEqual(await pc.notes(), {
        "a.md": "same",
        "b.md": "local version",
        "c.md": "only local",
        "d.md": "only remote",
      });
      assert.equal(pc.read(LEGACY), legacyLocal, "legacy file left alone");
      const remote = await ctx.remote.files();
      assert.equal(remote[LEGACY], legacyRemote, "legacy file left alone");
      // Laptop still has the stale Untitled.md: it is kept, never deleted
      const laptop = await ctx.device("laptop");
      await laptop.write(LEGACY, "{}");
      await laptop.write("a.md", "same");
      await laptop.write("Untitled.md", "");
      await syncOk(laptop, pc);
      assert.equal(laptop.seenConflicts.length, 0);
      const expected = {
        "a.md": "same",
        "b.md": "local version",
        "c.md": "only local",
        "d.md": "only remote",
        "Untitled.md": "",
      };
      assert.deepEqual(await laptop.notes(), expected);
      assert.deepEqual(await pc.notes(), expected);
      assert.deepEqual(await remoteNotes(ctx.remote), expected);
    },
  },
  {
    name: "push rejected because another device pushed meanwhile is retried",
    fakeOnly: true,
    async run(ctx) {
      const { a } = await pair(ctx, { "x.md": "v1", "y.md": "v1" });
      await a.write("x.md", "from A");
      ctx.fake!.beforeRefUpdate = () =>
        ctx.fake!.commitDirect({ "y.md": "pushed meanwhile" });
      await syncOk(a);
      assert.deepEqual(await remoteNotes(ctx.remote), {
        "x.md": "from A",
        "y.md": "pushed meanwhile",
      });
      assert.equal(a.read("y.md"), "pushed meanwhile");
    },
  },
  {
    name: "stale branch read right after a push doesn't revert (issue #37 root cause)",
    fakeOnly: true,
    async run(ctx) {
      const { a } = await pair(ctx, { "x.md": "v1" });
      await a.write("x.md", "v2");
      await syncOk(a);
      // The next two branch reads return the commit before our push
      ctx.fake!.staleReads = 2;
      await syncOk(a);
      assert.equal(a.read("x.md"), "v2");
      assert.equal(await ctx.remote.files().then((f) => f["x.md"]), "v2");
    },
  },
  {
    name: "failed sync leaves everything untouched and recovers",
    fakeOnly: true,
    async run(ctx) {
      const { a, b } = await pair(ctx, { "x.md": "v1" });
      await a.write("x.md", "v2");
      await b.write("y.md", "new");
      // Every ref update is rejected: the sync must fail without local changes
      const fake = ctx.fake!;
      const handle = fake.handle.bind(fake);
      fake.handle = (m, r, body) =>
        m === "PATCH" ? { status: 500, json: {} } : handle(m, r, body);
      assert.equal(await b.sync(), false);
      fake.handle = handle;
      assert.equal(b.read("x.md"), "v1");
      await syncOk(a, b, a);
      assert.equal(b.read("x.md"), "v2");
      assert.equal(a.read("y.md"), "new");
    },
  },
];
