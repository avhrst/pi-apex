import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHECK_ONLY_CHOICE,
  CREATE_NEW_CHOICE,
  EXPORT_OVERWRITE_GUIDELINE,
  IMPORT_CHOICE,
  MASS_VALIDATION_DISTINCT_FILE_THRESHOLD,
  MASS_VALIDATION_FINDING_THRESHOLD,
  ORDS_SQLCL_COMPATIBILITY,
  ORDS_SQLCL_COMPATIBILITY_GUIDELINE,
  ORDS_SQLCL_COMPATIBILITY_TABLE,
  RPC_DIALOG_TIMEOUT_MS,
  UPDATE_EXISTING_CHOICE,
  createApexlangTool,
  createNewTargetProved,
  detectValidationCompatibilitySignal,
  formatValidationCompatibilityAdvisory,
  liveImportPassed,
  liveValidationPassed,
  renderOrdsSqlclCompatibilityTable,
  default as apexlangExtension
} from "../extensions/apexlang/index.ts";

const TEST_APP_DIGEST = "a".repeat(64);

function stubResult(
  payload,
  {
    ok = true,
    code = ok ? 0 : 1,
    action = "runtime_validate",
    outputRoot = "/tmp/pi-apexlang-test-reports"
  } = {}
) {
  return {
    ok,
    code,
    stdout: JSON.stringify(payload),
    stderr: "",
    action,
    command: { scriptPath: "apexctl", args: [], prelude: [] },
    outputRoot,
    preludeResults: [],
    appDigest: TEST_APP_DIGEST
  };
}

const livePassPayload = {
  live_check_status: "pass",
  validation_status: "pass",
  validation_sources: { live_validator: { status: "pass" } }
};

const importPassPayload = {
  validate_status: "pass",
  import_status: "pass",
  runtime_gate_status: "pass"
};

test("registers and executes the pi-native APEXlang tool", async () => {
  const tools = [];
  const handlers = new Map();
  apexlangExtension({
    registerTool(tool) {
      tools.push(tool);
    },
    on(event, handler) {
      handlers.set(event, handler);
    }
  });

  assert.deepEqual(tools.map((tool) => tool.name), ["apexlang"]);
  assert.equal(tools[0].executionMode, "sequential");
  assert.equal(tools[0].promptGuidelines.includes(EXPORT_OVERWRITE_GUIDELINE), true);
  assert.match(EXPORT_OVERWRITE_GUIDELINE, /exactly one SQLcl `apex export` command with `-force`/);
  assert.match(EXPORT_OVERWRITE_GUIDELINE, /\*_1\.apx/);
  assert.equal(handlers.has("session_shutdown"), true);

  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-extension-test-"));
  try {
    const updates = [];
    const result = await tools[0].execute(
      "test-call",
      { action: "workspace_probe" },
      new AbortController().signal,
      (update) => updates.push(update),
      {
        cwd: workspace,
        hasUI: false,
        ui: {}
      }
    );
    assert.equal(JSON.parse(result.content[0].text).status, "unresolved");
    assert.equal(updates.length, 1);

    await assert.rejects(
      tools[0].execute(
        "write-call",
        {
          action: "new_app_materialize",
          app_path: "applications/orders",
          db_connection_name: "apex_dev",
          workspace_name: "ORDERS_DEV"
        },
        new AbortController().signal,
        undefined,
        { cwd: workspace, hasUI: false, ui: {} }
      ),
      /requires interactive confirmation/
    );

    const outputRoot = result.details.outputRoot;
    await access(outputRoot);
    await handlers.get("session_shutdown")();
    await assert.rejects(access(outputRoot));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("publishes a sourced advisory ORDS and SQLcl compatibility table", () => {
  assert.equal(ORDS_SQLCL_COMPATIBILITY.schemaVersion, 1);
  assert.equal(ORDS_SQLCL_COMPATIBILITY.policy, "advisory-only");
  assert.equal(MASS_VALIDATION_FINDING_THRESHOLD, 50);
  assert.equal(MASS_VALIDATION_DISTINCT_FILE_THRESHOLD, 5);
  assert.equal(ORDS_SQLCL_COMPATIBILITY_TABLE.length, 4);
  for (const row of ORDS_SQLCL_COMPATIBILITY_TABLE) {
    assert.ok(row.environment);
    assert.ok(["any", "all", "fallback"].includes(row.matchMode));
    assert.ok(row.sqlclGuidance);
    assert.ok(row.basis);
    assert.ok(row.sourceUrls.length > 0);
    for (const url of row.sourceUrls) assert.equal(new URL(url).protocol, "https:");
    if (row.diagnosticSqlclDownloadUrl) {
      assert.equal(new URL(row.diagnosticSqlclDownloadUrl).protocol, "https:");
    }
  }
  assert.match(ORDS_SQLCL_COMPATIBILITY_GUIDELINE, /do not hard-block other SQLcl versions/);
  const rendered = renderOrdsSqlclCompatibilityTable();
  assert.match(rendered, /ORDS 26\.2\.x/);
  assert.match(rendered, /26\.1\.2\.132\.1334/);
  assert.match(rendered, /extension-advisory/);
});

test("detects the mass-validation boundary and normalized warning results", async () => {
  const belowThreshold = await detectValidationCompatibilitySignal(
    stubResult(
      {
        live_check_status: "fail",
        validation_status: "fail",
        problem_count: 49,
        unresolved_count: 49
      },
      { ok: false }
    )
  );
  assert.equal(belowThreshold, undefined);

  const atThreshold = await detectValidationCompatibilitySignal(
    stubResult(
      {
        live_check_status: "fail",
        validation_status: "fail",
        problem_count: 50,
        unresolved_count: 50
      },
      { ok: false }
    )
  );
  assert.deepEqual(atThreshold, { source: "structured-result", findingCount: 50 });

  const normalizedWarnings = await detectValidationCompatibilitySignal(
    stubResult({
      ...livePassPayload,
      problem_count: 0,
      unresolved_count: 0,
      compatibility_fallback: {
        policy: "sqlcl_explicit_validation_success_with_compile_warnings",
        original_unresolved_count: 142
      }
    })
  );
  assert.deepEqual(normalizedWarnings, { source: "structured-result", findingCount: 142 });
  assert.match(
    formatValidationCompatibilityAdvisory(normalizedWarnings),
    /does not turn a failed validation into a pass/
  );

  const compilerTruthOutput = Array.from({ length: 50 }, (_, index) =>
    ` - monitor/pages/p${String((index % 5) + 1).padStart(5, "0")}.apx:${index + 1}: COMPILER_TRUTH_PROP_UNKNOWN property${index} is not present in compiler metadata`
  ).join("\n");
  const compilerTruthSignal = await detectValidationCompatibilitySignal({
    ...stubResult({}, { ok: false, action: "compiler_truth_audit" }),
    stdout: compilerTruthOutput
  });
  assert.deepEqual(compilerTruthSignal, {
    source: "compiler-truth-output",
    findingCount: 50,
    distinctFileCount: 5
  });
});

test("detects mass local reports without double-counting duplicates", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-compatibility-test-"));
  const logs = join(outputRoot, "logs");
  await mkdir(logs);
  try {
    const issues = Array.from({ length: 50 }, (_, index) => ({
      file: `monitor/pages/p${String((index % 5) + 1).padStart(5, "0")}.apx`,
      line: index + 1,
      rule: "COMPILER_TRUTH_PROP_UNKNOWN",
      message: `property ${index} is not present in compiler metadata`
    }));
    await writeFile(
      join(logs, "apexlang-dsl-report.json"),
      JSON.stringify({ status: "fail", issues })
    );
    const massSignal = await detectValidationCompatibilitySignal(
      stubResult({}, { ok: false, action: "local_validate", outputRoot })
    );
    assert.deepEqual(massSignal, {
      source: "local-reports",
      findingCount: 50,
      distinctFileCount: 5
    });

    const duplicatedIssues = issues.slice(0, 25);
    await Promise.all([
      writeFile(
        join(logs, "apexlang-dsl-report.json"),
        JSON.stringify({ status: "fail", issues: duplicatedIssues })
      ),
      writeFile(
        join(logs, "apexlang-validations-report.json"),
        JSON.stringify({ status: "fail", issues: duplicatedIssues })
      )
    ]);
    assert.equal(
      await detectValidationCompatibilitySignal(
        stubResult({}, { ok: false, action: "local_validate", outputRoot })
      ),
      undefined
    );

    await writeFile(
      join(logs, "apexlang-vocab-report.json"),
      JSON.stringify({ blocking_reason: "UNSUPPORTED_MMD_VERSION", unresolved: [] })
    );
    assert.deepEqual(
      await detectValidationCompatibilitySignal(
        stubResult({}, { ok: false, action: "local_validate", outputRoot })
      ),
      { source: "unsupported-mmd" }
    );
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("clears stale local reports before a new validation run", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-stale-report-test-"));
  const logs = join(outputRoot, "logs");
  const staleReport = join(logs, "apexlang-dsl-report.json");
  await mkdir(logs);
  await writeFile(
    staleReport,
    JSON.stringify({
      status: "fail",
      issues: Array.from({ length: 50 }, (_, index) => ({
        file: `monitor/pages/p${String((index % 5) + 1).padStart(5, "0")}.apx`,
        line: index + 1,
        rule: "COMPILER_TRUTH_PROP_UNKNOWN",
        message: `stale property ${index}`
      }))
    })
  );
  try {
    const tool = createApexlangTool({
      async run() {
        await assert.rejects(access(staleReport));
        return stubResult(
          { error: "validation stopped before reports were written" },
          { ok: false, action: "local_validate", outputRoot }
        );
      },
      async outputRoot() {
        return outputRoot;
      }
    });
    await assert.rejects(
      tool.execute(
        "fresh-local-validation",
        { action: "local_validate", app_path: "monitor" },
        new AbortController().signal,
        undefined,
        { cwd: "/tmp/pi-apexlang-workspace", hasUI: false, ui: {} }
      ),
      (error) => {
        assert.doesNotMatch(error.message, /SQLcl\/ORDS compatibility advisory/);
        return true;
      }
    );
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("adds the compatibility advisory to mass runtime validation output", async () => {
  const updates = [];
  const tool = createApexlangTool({
    async run() {
      return stubResult({
        ...livePassPayload,
        compatibility_fallback: {
          policy: "sqlcl_explicit_validation_success_with_compile_warnings",
          original_unresolved_count: 142
        }
      });
    },
    async outputRoot() {
      return "/tmp/pi-apexlang-test-reports";
    }
  });
  const result = await tool.execute(
    "mass-runtime-check",
    {
      action: "runtime_validate",
      app_path: "monitor",
      db_connection_name: "apex_dev",
      workspace_name: "APEX_DEV"
    },
    new AbortController().signal,
    (update) => updates.push(update),
    { cwd: "/tmp/pi-apexlang-workspace", hasUI: false, ui: {} }
  );
  assert.match(result.content[0].text, /SQLcl\/ORDS compatibility advisory/);
  assert.match(result.content[0].text, /26\.1\.2\.132\.1334/);
  assert.match(result.content[0].text, /Import was not run/);
  assert.equal(updates.some((update) => update.details.compatibilityAdvisory === true), true);

  const failingTool = createApexlangTool({
    async run() {
      return stubResult(
        {
          live_check_status: "fail",
          validation_status: "fail",
          problem_count: 50,
          unresolved_count: 50
        },
        { ok: false }
      );
    },
    async outputRoot() {
      return "/tmp/pi-apexlang-test-reports";
    }
  });
  await assert.rejects(
    failingTool.execute(
      "mass-runtime-failure",
      {
        action: "runtime_validate",
        app_path: "monitor",
        db_connection_name: "apex_dev",
        workspace_name: "APEX_DEV"
      },
      new AbortController().signal,
      undefined,
      { cwd: "/tmp/pi-apexlang-workspace", hasUI: false, ui: {} }
    ),
    (error) => {
      assert.match(error.message, /SQLcl\/ORDS compatibility advisory/);
      assert.match(error.message, /This advice does not turn a failed validation into a pass/);
      assert.match(error.message, /APEXlang reports:/);
      return true;
    }
  );
});

test("requires authoritative payload evidence before post-check import handling", () => {
  const base = {
    ok: true,
    code: 0,
    stderr: "",
    action: "runtime_validate",
    command: { scriptPath: "apexctl", args: [], prelude: [] },
    outputRoot: "/tmp/apexlang",
    preludeResults: []
  };
  assert.equal(
    liveValidationPassed({
      ...base,
      stdout: JSON.stringify({
        live_check_status: "pass",
        validation_sources: { live_validator: { status: "pass" } }
      })
    }),
    true
  );
  assert.equal(liveValidationPassed({ ...base, stdout: "{}" }), false);
  assert.equal(
    liveImportPassed({
      ...base,
      stdout: JSON.stringify({
        validate_status: "pass",
        import_status: "pass",
        runtime_gate_status: "pass"
      })
    }),
    true
  );
  assert.equal(
    liveImportPassed({
      ...base,
      stdout: JSON.stringify({ validate_status: "pass", import_status: "blocked" })
    }),
    false
  );
  assert.equal(
    createNewTargetProved(
      stubResult(
        {
          target_resolution_mode: "create-new",
          target_resolution_status: "not_found_in_workspace",
          create_new_confirmation_required: true,
          import_status: "blocked",
          failure_class: "create_new_confirmation_required"
        },
        { ok: false }
      )
    ),
    true
  );
});

test("post-check RPC dialog is abort-aware, bounded, and fail-closed", async () => {
  const tool = createApexlangTool({
    async run() {
      return stubResult(livePassPayload);
    },
    async outputRoot() {
      return "/tmp/pi-apexlang-test-reports";
    }
  });
  const controller = new AbortController();
  const dialogCalls = [];
  const result = await tool.execute(
    "bounded-post-check",
    {
      action: "runtime_validate",
      app_path: "applications/orders",
      db_connection_name: "apex_dev",
      workspace_name: "ORDERS_DEV"
    },
    controller.signal,
    undefined,
    {
      cwd: "/tmp/pi-apexlang-workspace",
      mode: "rpc",
      hasUI: true,
      ui: {
        async select(title, options, dialogOptions) {
          dialogCalls.push({ title, options, dialogOptions });
          return undefined;
        }
      }
    }
  );

  assert.equal(result.details.liveValidationPassed, true);
  assert.equal(result.details.imported, false);
  assert.equal(result.details.postCheckChoice, "cancelled");
  assert.match(result.content[0].text, /Live validation passed/);
  assert.match(result.content[0].text, /choice was cancelled; import was not run/);
  assert.equal(dialogCalls.length, 1);
  assert.deepEqual(dialogCalls[0].options, [CHECK_ONLY_CHOICE, IMPORT_CHOICE]);
  assert.equal(dialogCalls[0].dialogOptions.timeout, RPC_DIALOG_TIMEOUT_MS);
  assert.equal(dialogCalls[0].dialogOptions.signal, controller.signal);
});

test("post-check import explicitly targets an existing application", async () => {
  const importCalls = [];
  const tool = createApexlangTool({
    async run() {
      return stubResult(livePassPayload);
    },
    async runImport(_input, _options, importOptions) {
      importCalls.push(importOptions);
      return stubResult(importPassPayload);
    },
    async runCreateNewProof() {
      throw new Error("create-new proof should not run");
    },
    async outputRoot() {
      return "/tmp/pi-apexlang-test-reports";
    }
  });
  const choices = [IMPORT_CHOICE, UPDATE_EXISTING_CHOICE];
  const result = await tool.execute(
    "existing-import",
    {
      action: "runtime_validate",
      app_path: "applications/orders",
      db_connection_name: "apex_dev",
      workspace_name: "ORDERS_DEV"
    },
    new AbortController().signal,
    undefined,
    {
      cwd: "/tmp/pi-apexlang-workspace",
      hasUI: true,
      ui: {
        async select() {
          return choices.shift();
        }
      }
    }
  );
  assert.equal(result.details.imported, true);
  assert.equal(result.details.targetResolutionMode, "update-existing");
  assert.deepEqual(importCalls, [
    {
      targetResolutionMode: "update-existing",
      createNewConfirmed: false,
      expectedAppDigest: TEST_APP_DIGEST
    }
  ]);
  assert.match(result.content[0].text, /^Import completed: validate_status=pass/);
});

test("create-new import requires Oracle absence proof before confirmation", async () => {
  const events = [];
  const tool = createApexlangTool({
    async run() {
      events.push("live-check");
      return stubResult(livePassPayload);
    },
    async runCreateNewProof(_input, _options, proofOptions) {
      events.push(`absence-proof:${proofOptions.expectedAppDigest}`);
      return stubResult(
        {
          target_resolution_mode: "create-new",
          target_resolution_status: "not_found_in_workspace",
          create_new_confirmation_required: true,
          import_status: "blocked",
          failure_class: "create_new_confirmation_required"
        },
        { ok: false }
      );
    },
    async runImport(_input, _options, importOptions) {
      events.push(
        `import:${importOptions.targetResolutionMode}:${importOptions.createNewConfirmed}:${importOptions.expectedAppDigest}`
      );
      return stubResult(importPassPayload);
    },
    async outputRoot() {
      return "/tmp/pi-apexlang-test-reports";
    }
  });
  const choices = [IMPORT_CHOICE, CREATE_NEW_CHOICE];
  const result = await tool.execute(
    "create-import",
    {
      action: "runtime_validate",
      app_path: "applications/orders",
      db_connection_name: "apex_dev",
      workspace_name: "ORDERS_DEV"
    },
    new AbortController().signal,
    undefined,
    {
      cwd: "/tmp/pi-apexlang-workspace",
      hasUI: true,
      ui: {
        async select() {
          return choices.shift();
        },
        async confirm() {
          events.push("confirm-after-proof");
          return true;
        }
      }
    }
  );
  assert.deepEqual(events, [
    "live-check",
    `absence-proof:${TEST_APP_DIGEST}`,
    "confirm-after-proof",
    `import:create-new:true:${TEST_APP_DIGEST}`
  ]);
  assert.equal(result.details.imported, true);
  assert.equal(result.details.targetResolutionMode, "create-new");
});
