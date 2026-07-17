import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runApexlang } from "../extensions/lib/apexlang-cli.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-smoke-workspace-"));
const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-smoke-output-"));

try {
  const probe = await runApexlang(
    { action: "workspace_probe" },
    { cwd: fixtureRoot, outputRoot, timeoutMs: 30_000 }
  );
  assert.equal(probe.ok, true, probe.stderr);
  const resolution = JSON.parse(probe.stdout);
  assert.equal(resolution.status, "unresolved");
  assert.equal(await realpath(resolution.session_root), await realpath(fixtureRoot));

  const validation = await runApexlang(
    {
      action: "local_validate",
      app_path: resolve(root, "skills/apexlang/templates/base-app-structure/scaffold-example")
    },
    { cwd: root, outputRoot, timeoutMs: 60_000 }
  );
  assert.equal(validation.ok, true, validation.stderr || validation.stdout);
  assert.match(validation.stdout, /APEXLANG_LOCAL_CHECK_OK/);
  console.log("APEXlang probe and bundled-scaffold validation passed.");
} finally {
  await Promise.all([
    rm(fixtureRoot, { recursive: true, force: true }),
    rm(outputRoot, { recursive: true, force: true })
  ]);
}
