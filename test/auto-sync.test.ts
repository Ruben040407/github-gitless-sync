import { test } from "node:test";
import * as assert from "node:assert/strict";
import AutoSync from "../src/auto-sync";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("auto sync runs once after the last of many edits", async () => {
  let runs = 0;
  const auto = new AutoSync(async () => {
    runs++;
    return true;
  });
  for (let i = 0; i < 5; i++) {
    auto.schedule(50);
    await sleep(20);
  }
  assert.equal(runs, 0, "keeps waiting while edits come in");
  await sleep(80);
  assert.equal(runs, 1);
  assert.equal(auto.pending, false);
});

test("auto sync retries later if another sync was running", async () => {
  let attempts = 0;
  const auto = new AutoSync(async () => {
    attempts++;
    return attempts > 1; // busy the first time
  });
  auto.schedule(20);
  await sleep(100);
  assert.equal(attempts, 2);
});

test("flush runs a pending sync immediately, and only a pending one", async () => {
  let runs = 0;
  const auto = new AutoSync(async () => {
    runs++;
    return true;
  });
  await auto.flush();
  assert.equal(runs, 0);
  auto.schedule(10_000);
  await auto.flush();
  assert.equal(runs, 1);
  assert.equal(auto.pending, false);
});
