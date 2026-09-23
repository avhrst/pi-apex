import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPackagedRuntimeValidation } from "../extensions/lib/apexlang-runtime-validate.mjs";

test("packaged Media List validation uses bundled helpers and preserves blocking gates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-apexlang-runtime-validator-"));
  const previousEnvironment = Object.fromEntries([
    "APEXLANG_OUTPUT_ROOT", "APEXLANG_PACKAGE_ROOT", "APEXLANG_RUNTIME_ROOT", "APEXLANG_EMBEDDED_TOOLS_ROOT"
  ].map((name) => [name, process.env[name]]));
  try {
    process.env.APEXLANG_OUTPUT_ROOT = join(root, "output");
    const appPath = join(root, "app");
    const compilerOracleHome = join(root, "empty-compiler-home");
    await mkdir(appPath);
    await mkdir(compilerOracleHome);
    await writeFile(join(appPath, "page.apx"), [
      "region media (",
      "  type: themeTemplateComponent/mediaList",
      "  componentAppearance {",
      "    display: report",
      "  }",
      "  source {",
      "    location: localDatabase",
      "  }",
      ")",
      ""
    ].join("\n"));
    const validation = await loadPackagedRuntimeValidation();
    const { buildApexlangCommand } = await import("../extensions/lib/apexlang-cli.mjs");
    const command = buildApexlangCommand({
      action: "runtime_validate", app_path: appPath,
      db_connection_name: "fixture_no_database", workspace_name: "TEST_WORKSPACE"
    });
    assert.match(command.scriptPath, /apexlang-runtime-validate\.mjs$/);
    assert.deepEqual(command.args.slice(0, 2), ["runtime", "validate"]);
    const noDatabaseDependencies = {
      runRuntimeRoundtrip: async () => ({ code: 0, payload: { live_check_status: "pass" } }),
      runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
      loadVscodeProblemsEvidence: async () => ({
        status: "not_provided", source: "fixture", unresolved_count: 0, problems: []
      })
    };

    await t.test("loads the packaged grammar helper and blocks unresolved compiler metadata", async () => {
      const contract = await validation.resolveMediaListGrammarContract({ appPath, compilerOracleHome });
      assert.equal(contract.status, "unresolved");
      assert.match(contract.reason, /region\.column did not resolve uniquely/);
      assert.doesNotMatch(contract.reason, /Cannot find module|MODULE_NOT_FOUND/);

      const result = await validation.run({
        appPath,
        compilerOracleHome,
        dbConnectionName: "fixture_no_database",
        artifactDir: join(root, "missing-compiler-reports"),
        _deps: noDatabaseDependencies
      });
      assert.equal(result.code, 1);
      assert.equal(result.payload.live_check_status, "pass");
      assert.equal(result.payload.validation_status, "fail");
      assert.equal(result.payload.import_eligibility, "blocked");
      assert.match(result.payload.blocking_reasons.join("\n"), /Target-build Media List contract is unresolved/);
      assert.doesNotMatch(result.payload.blocking_reasons.join("\n"), /Cannot find module|MODULE_NOT_FOUND/);
    });

    await t.test("runs the packaged Python validator and keeps target-build failures blocking", async () => {
      await writeFile(join(appPath, "page.apx"), "application broken (\r\n)\r\n");
      const result = await validation.run({
        appPath,
        dbConnectionName: "fixture_no_database",
        artifactDir: join(root, "invalid-app-reports"),
        _deps: {
          ...noDatabaseDependencies,
          resolveMediaListGrammarContract: async () => ({
            status: "resolved",
            contract: { compilerContract: { buildID: "fixture", resolvedChildren: [] }, productions: [] }
          })
        }
      });
      assert.equal(result.code, 1);
      assert.equal(result.payload.live_check_status, "pass");
      assert.equal(result.payload.validation_status, "fail");
      assert.equal(result.payload.import_eligibility, "blocked");
      assert.equal(result.payload.validation_sources.target_build_contract.status, "fail");
      assert.match(result.payload.validation_sources.target_build_contract.output, /APEXLANG_DSL_LINT_FAILED/);
      assert.ok(result.payload.blocking_reasons.includes("Target-build component contract validation did not pass."));
      const report = JSON.parse(await readFile(result.payload.artifacts.validation_report_path, "utf8"));
      assert.equal(report.validation_status, "fail");
    });
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
