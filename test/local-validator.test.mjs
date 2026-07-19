import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apexctlPath = resolve(root, "skills/apexlang/tools/apexctl.mjs");
const acceleratedPath = resolve(root, "extensions/lib/apexlang-local-validate.mjs");
const fixturePath = resolve(root, "skills/apexlang/templates/base-app-structure/scaffold-example");

async function readReport(outputRoot, name) {
  return JSON.parse(await readFile(join(outputRoot, "logs", name), "utf8"));
}

test("accelerated local validation preserves Oracle report output", async () => {
  const oracleOutput = await mkdtemp(join(tmpdir(), "pi-apexlang-oracle-local-"));
  const acceleratedOutput = await mkdtemp(join(tmpdir(), "pi-apexlang-fast-local-"));
  try {
    const oracle = await execFileAsync(
      process.execPath,
      [apexctlPath, "apexlang", "validate", "--app-path", fixturePath],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, APEXLANG_OUTPUT_ROOT: oracleOutput, PYTHONDONTWRITEBYTECODE: "1" },
        maxBuffer: 8 * 1024 * 1024
      }
    );
    const accelerated = await execFileAsync(
      process.execPath,
      [acceleratedPath, "--app-path", fixturePath],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, APEXLANG_OUTPUT_ROOT: acceleratedOutput, PYTHONDONTWRITEBYTECODE: "1" },
        maxBuffer: 8 * 1024 * 1024
      }
    );

    assert.equal(accelerated.stdout, oracle.stdout);
    assert.equal(accelerated.stderr, oracle.stderr);
    for (const report of [
      "apexlang-vocab-report.json",
      "apexlang-dsl-report.json",
      "apexlang-validations-report.json"
    ]) {
      assert.deepEqual(
        await readReport(acceleratedOutput, report),
        await readReport(oracleOutput, report),
        `${report} changed under parser acceleration`
      );
    }
  } finally {
    await Promise.all([
      rm(oracleOutput, { recursive: true, force: true }),
      rm(acceleratedOutput, { recursive: true, force: true })
    ]);
  }
});
