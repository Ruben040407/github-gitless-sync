import { test } from "node:test";
import * as assert from "node:assert/strict";
import { decide, planSync, gitBlobSha } from "../src/sync-plan";

const B = (local: string, remote = local) => ({ local, remote });

test("decide: unchanged on both sides does nothing", () => {
  assert.equal(decide(B("a"), "a", "a"), null);
  assert.equal(decide(undefined, null, null), null);
});

test("decide: changed only locally uploads", () => {
  assert.equal(decide(B("a"), "b", "a"), "upload");
  assert.equal(decide(undefined, "b", null), "upload");
});

test("decide: changed only remotely downloads", () => {
  assert.equal(decide(B("a"), "a", "c"), "download");
  assert.equal(decide(undefined, null, "c"), "download");
});

test("decide: deleted remotely and unchanged locally deletes local", () => {
  // The Untitled.md case: the other device still has the file unchanged
  assert.equal(decide(B("a"), "a", null), "delete_local");
});

test("decide: deleted locally and unchanged remotely deletes remote", () => {
  assert.equal(decide(B("a"), null, "a"), "delete_remote");
});

test("decide: deleted locally and already gone remotely just forgets", () => {
  assert.equal(decide(B("a"), null, null), "forget");
});

test("decide: both changed differently is a conflict", () => {
  assert.equal(decide(B("a"), "b", "c"), "conflict");
  // No base (first sync of this version) and different content
  assert.equal(decide(undefined, "b", "c"), "conflict");
});

test("decide: both changed to the same content only records", () => {
  assert.equal(decide(B("a"), "b", "b"), "record");
  assert.equal(decide(undefined, "b", "b"), "record");
});

test("decide: an edit always wins over a deletion", () => {
  assert.equal(decide(B("a"), "b", null), "upload");
  assert.equal(decide(B("a"), null, "c"), "download");
});

test("decide: local and remote SHAs tracked separately", () => {
  // Upload transformed content (remote sha differs from local sha):
  // a second sync must not download or upload anything (issue #37)
  assert.equal(decide({ local: "l1", remote: "r1" }, "l1", "r1"), null);
  assert.equal(decide({ local: "l1", remote: "r1" }, "l2", "r1"), "upload");
  assert.equal(decide({ local: "l1", remote: "r1" }, "l1", "r2"), "download");
});

test("planSync: rename is a delete plus a create", () => {
  const actions = planSync({ "a.md": B("x") }, { "b.md": "x" }, { "a.md": "x" });
  assert.deepEqual(actions, [
    { type: "delete_remote", filePath: "a.md" },
    { type: "upload", filePath: "b.md" },
  ]);
});

test("planSync: missing entries never throw", () => {
  const actions = planSync(
    { "gone.md": B("x") },
    { "new.md": "n" },
    { "remote.md": "r" },
  );
  assert.deepEqual(
    actions.map((a) => a.type),
    ["forget", "upload", "download"],
  );
});

test("gitBlobSha matches git", async () => {
  // echo -n "hello" | git hash-object --stdin
  assert.equal(
    await gitBlobSha(new TextEncoder().encode("hello")),
    "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0",
  );
  // empty blob
  assert.equal(
    await gitBlobSha(new Uint8Array()),
    "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  );
});
