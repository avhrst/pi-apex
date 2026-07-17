import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = await mkdtemp(join(tmpdir(), "pi-apexlang-pack-cache-"));

try {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--dry-run", "--json", "--cache", cache],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
  );
  const [packed] = JSON.parse(stdout);
  const paths = new Set(packed.files.map((entry) => entry.path));
  for (const requiredPath of [
    "LICENSE",
    "README.md",
    "extensions/apexlang/index.ts",
    "extensions/lib/apexlang-cli.mjs",
    "skills/apexlang/SKILL.md",
    "skills/apexlang/runtime/runtime.bundle.mjs",
    "skills/apexlang/runtime/internal/python/validate_apexlang.py",
    "skills/apexlang/tools/apexctl.mjs"
  ]) {
    assert.equal(paths.has(requiredPath), true, `${requiredPath} is missing from the npm package`);
  }
  assert.equal([...paths].some((path) => path.startsWith("node_modules/")), false);
  assert.equal(
    [...paths].some((path) => path.includes("/__pycache__/") || /\.py[co]$/.test(path)),
    false,
    "Python bytecode caches must not be published"
  );
  assert.equal(paths.has("test/runner.test.mjs"), false);
  assert.ok(packed.entryCount >= 790, `unexpectedly small package: ${packed.entryCount} entries`);
  console.log(
    `Verified ${packed.filename}: ${packed.entryCount} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked.`
  );
} finally {
  await rm(cache, { recursive: true, force: true });
}
