// Bundles the tests with "obsidian" aliased to a Node mock, then runs them.
//   node scripts/test.mjs            unit + scenario tests (offline)
//   node scripts/test.mjs e2e        scenarios against a real GitHub repo (see test/e2e.ts)
import esbuild from "esbuild";
import { spawnSync } from "child_process";
import { readdirSync, rmSync } from "fs";

const e2e = process.argv[2] === "e2e";
const entryPoints = e2e
  ? ["test/e2e.ts"]
  : readdirSync("test")
      .filter((f) => f.endsWith(".test.ts"))
      .map((f) => `test/${f}`);

rmSync(".test-build", { recursive: true, force: true });
await esbuild.build({
  entryPoints,
  outdir: ".test-build",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: "inline",
  alias: { obsidian: "./test/mock-obsidian.ts" },
  logLevel: "warning",
});

const files = readdirSync(".test-build").map((f) => `.test-build/${f}`);
const args = e2e
  ? ["--enable-source-maps", ...files]
  : ["--enable-source-maps", "--test", "--test-concurrency=1", ...files];
const res = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(res.status ?? 1);
