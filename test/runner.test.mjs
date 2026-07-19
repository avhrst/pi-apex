import assert from "node:assert/strict";
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  APEXLANG_ACTIONS,
  assertProjectAppPath,
  buildApexlangCommand,
  buildApexlangImportCommand,
  buildWarningCompatibleImportCommands,
  classifyWarningCompatibleSqlclValidation,
  classifyWarningOnlyRuntimePayload,
  computeApexlangAppDigest,
  executeProcessTree,
  executeSqlclValidationThenImport,
  prepareRuntimeApp,
  proveWarningOnlyProblemsAreDiagnostics,
  validateMaterializationPaths,
  runApexlang,
  runApexlangImport,
  runWarningCompatibleImport,
  validateUpdateExistingImportProof
} from "../extensions/lib/apexlang-cli.mjs";

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

function warningOnlyTranscript() {
  return [
    "## roundtrip_sql_name_alias",
    "APEXlang Compile Warnings:",
    "Warning: Property example is deprecated.",
    "",
    "Validation successful.",
    "",
    "## roundtrip_sql_alias",
    "Connection failed",
    'Exception in thread "JLine Mask Thread" java.lang.IllegalStateException: Terminal has been closed',
    "\tat org.jline.terminal.impl.AbstractTerminal.checkClosed(AbstractTerminal.java:143)",
    "\tat org.jline.terminal.impl.DumbTerminal.writer(DumbTerminal.java:184)",
    "\tat org.jline.reader.impl.LineReaderImpl$1.run(LineReaderImpl.java:860)"
  ].join("\n");
}

function warningOnlyRuntimePayload(stagedAppPath, importIntent = "validate-and-import") {
  return {
    final_app_path: stagedAppPath,
    temp_app_path: stagedAppPath,
    phase_reports: [
      { phase: "preflight", status: "pass" },
      { phase: "local_validate", status: "pass" },
      { phase: "target_resolve", status: "pass" },
      {
        phase: "live_validate",
        status: "fail",
        failure_class: "live_validate_failed"
      }
    ],
    db_connection_name: "test_apex_db",
    execution_mode_used: "path",
    import_intent_choice: importIntent,
    target_resolution_mode: "update-existing",
    target_resolution_status: "resolved_existing_app",
    lookup_scope_workspaceid: "1234567890123456",
    lookup_scope_workspace_name: "TEST_WORKSPACE",
    workspaceid: "1234567890123456",
    candidate_count: 1,
    candidate_ids: [104],
    direct_import_fallback_allowed: true,
    source_application_id: 104,
    source_application_alias: "TEST_APP",
    canonical_application_id: 104,
    canonical_application_alias: "TEST_APP",
    canonical_mapping_status: "resolved",
    failure_class: "live_validate_failed",
    blocking_reason: "live_validate_failed",
    report_path: "/tmp/runtime-run.json",
    frozen_preflight_facts: {
      app_path: stagedAppPath,
      execution_mode_selected: "path",
      db_connection_name: "test_apex_db",
      requested_application_id: 104,
      requested_application_alias: "TEST_APP",
      workspace_scope: {
        workspace_id: "1234567890123456",
        workspace_name: "TEST_WORKSPACE"
      }
    }
  };
}

test("exposes a bounded, import-free action set", () => {
  assert.equal(APEXLANG_ACTIONS.includes("runtime_import"), false);
  assert.equal(APEXLANG_ACTIONS.includes("runtime_roundtrip"), false);
  assert.throws(
    () => buildApexlangCommand({ action: "runtime_import" }),
    /Unsupported APEXlang action/
  );
});

test("builds workspace probe arguments without shell interpolation", () => {
  const command = buildApexlangCommand({
    action: "workspace_probe",
    db_connection_name: "apex_dev",
    workspace_name: "SERVICE_OPS_DEV"
  });
  assert.deepEqual(command.args, [
    "workspace",
    "probe",
    "--db-connection-name",
    "apex_dev",
    "--workspace-name",
    "SERVICE_OPS_DEV"
  ]);
});

test("routes local validation through the accelerated wrapper", () => {
  const command = buildApexlangCommand({
    action: "local_validate",
    app_path: "applications/orders",
    fix_vocab: true
  });
  assert.equal(command.scriptPath.endsWith("apexlang-local-validate.mjs"), true);
  assert.deepEqual(command.args, ["--app-path", "applications/orders", "--fix-vocab"]);
  assert.deepEqual(command.prelude, []);
});

test("rejects SQLcl control-language injection at the adapter boundary", () => {
  for (const dbConnectionName of ["safe\nhost touch /tmp/pwned", "user/password@db", "alias;exit"]) {
    assert.throws(
      () =>
        buildApexlangCommand({
          action: "runtime_validate",
          app_path: "applications/orders",
          db_connection_name: dbConnectionName,
          workspace_name: "ORDERS_DEV"
        }),
      /db_connection_name|control characters/
    );
  }
  assert.throws(
    () =>
      buildApexlangCommand({
        action: "runtime_validate",
        app_path: "applications/orders\nexit",
        db_connection_name: "apex_dev",
        workspace_name: "ORDERS_DEV"
      }),
    /control characters/
  );
});

test("requires a workspace and connection for live validation", () => {
  assert.throws(
    () => buildApexlangCommand({ action: "runtime_validate", app_path: "applications/orders" }),
    /db_connection_name is required/
  );
  assert.throws(
    () =>
      buildApexlangCommand({
        action: "runtime_validate",
        app_path: "applications/orders",
        db_connection_name: "apex_dev"
      }),
    /workspace_name is required/
  );
});

test("requires paired live context for scaffolding and runtime diagnostics", () => {
  assert.throws(
    () =>
      buildApexlangCommand({
        action: "new_app_materialize",
        app_path: "applications/orders",
        workspace_name: "ORDERS_DEV"
      }),
    /db_connection_name is required/
  );
  assert.throws(
    () =>
      buildApexlangCommand({
        action: "runtime_doctor",
        db_connection_name: "apex_dev"
      }),
    /workspace_name is required/
  );
  assert.throws(
    () => buildApexlangCommand({ action: "runtime_preflight" }),
    /db_connection_name is required/
  );
  const command = buildApexlangCommand({
    action: "runtime_preflight",
    db_connection_name: "apex_dev",
    workspace_name: "ORDERS_DEV"
  });
  assert.equal(command.prelude.length, 1);
});

test("blocks materialization unless the probe authorizes the exact suggested app path", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-materialize-workspace-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-materialize-output-"));
  const appPath = join(workspace, "applications/orders");
  try {
    await mkdir(join(workspace, "applications"));
    const result = await runApexlang(
      {
        action: "new_app_materialize",
        app_path: "applications/orders",
        db_connection_name: "apex_dev",
        workspace_name: "ORDERS_DEV"
      },
      { cwd: workspace, outputRoot, timeoutMs: 30_000 }
    );
    assert.equal(result.ok, false);
    assert.match(result.stderr, /Missing Inputs: new app materialization/);
    await assert.rejects(access(appPath));
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true })
    ]);
  }
});

test("records live workspace context before check-only validation", () => {
  const command = buildApexlangCommand({
    action: "runtime_validate",
    app_path: "/work/applications/orders",
    db_connection_name: "apex_dev",
    workspace_name: "ORDERS_DEV"
  });
  assert.equal(command.prelude.length, 1);
  assert.deepEqual(command.prelude[0].args, [
    "workspace",
    "probe",
    "--db-connection-name",
    "apex_dev",
    "--workspace-name",
    "ORDERS_DEV"
  ]);
  assert.deepEqual(command.args.slice(0, 6), [
    "runtime",
    "validate",
    "--app-path",
    "/work/applications/orders",
    "--db-connection-name",
    "apex_dev"
  ]);
  assert.equal(command.args.includes("--supporting-objects"), false);

  const withSupportingObjects = buildApexlangCommand({
    action: "runtime_validate",
    app_path: "/work/applications/orders",
    db_connection_name: "apex_dev",
    workspace_name: "ORDERS_DEV",
    supporting_objects: true
  });
  assert.equal(withSupportingObjects.args.includes("--supporting-objects"), true);
});

test("builds import only as a same-session post-check roundtrip", () => {
  const command = buildApexlangImportCommand({
    action: "runtime_validate",
    app_path: "/work/applications/orders",
    db_connection_name: "apex_dev",
    workspace_name: "ORDERS_DEV"
  });
  assert.equal(command.args.includes("--workspaceid"), false);
  assert.deepEqual(command.args.slice(0, 10), [
    "runtime",
    "roundtrip",
    "--app-path",
    "/work/applications/orders",
    "--db-connection-name",
    "apex_dev",
    "--import-intent",
    "validate-and-import",
    "--target-resolution-mode",
    "update-existing"
  ]);

  const createNewProof = buildApexlangImportCommand(
    {
      action: "runtime_validate",
      app_path: "/work/applications/orders",
      db_connection_name: "apex_dev",
      workspace_name: "ORDERS_DEV"
    },
    { targetResolutionMode: "create-new" }
  );
  assert.equal(createNewProof.args.includes("--create-new-confirmed"), false);
  const confirmedCreateNew = buildApexlangImportCommand(
    {
      action: "runtime_validate",
      app_path: "/work/applications/orders",
      db_connection_name: "apex_dev",
      workspace_name: "ORDERS_DEV"
    },
    { targetResolutionMode: "create-new", createNewConfirmed: true }
  );
  assert.equal(confirmedCreateNew.args.includes("--create-new-confirmed"), true);
});

test("accepts only an explicit warning-only SQLcl validation success", () => {
  const payload = warningOnlyRuntimePayload("/tmp/staged", "validate-only");
  assert.equal(
    classifyWarningOnlyRuntimePayload(payload, warningOnlyTranscript(), "validate-only").accepted,
    true
  );
  for (const transcript of [
    warningOnlyTranscript().replace("Validation successful.\n", ""),
    warningOnlyTranscript().replace("APEXlang Compile Warnings:", "APEXlang Compile Errors:"),
    warningOnlyTranscript().replace("Validation successful.", "ORA-20001: failed\nValidation successful."),
    warningOnlyTranscript().replace("Validation successful.", "Error! validation broke\nValidation successful."),
    warningOnlyTranscript().replace("Validation successful.", "ENOENT\nValidation successful."),
    warningOnlyTranscript().replace(
      "## roundtrip_sql_name_alias",
      "## roundtrip_sql_name_alias_extra"
    ),
    "## roundtrip_sql_alias\nAPEXlang Compile Warnings:\nValidation successful."
  ]) {
    assert.equal(
      classifyWarningOnlyRuntimePayload(payload, transcript, "validate-only").accepted,
      false
    );
  }
  assert.equal(
    classifyWarningOnlyRuntimePayload(
      { ...payload, phase_reports: [{ phase: "preflight", status: "fail" }, ...payload.phase_reports.slice(1)] },
      warningOnlyTranscript(),
      "validate-only"
    ).accepted,
    false
  );
});

test("classifies direct SQLcl warning success fail-closed", () => {
  const success = "APEXlang Compile Warnings:\nWarning: legacy.\nValidation successful.";
  assert.equal(classifyWarningCompatibleSqlclValidation(success).accepted, true);
  for (const output of [
    `${success}\nError! validation broke`,
    `${success}\n  Error! validation broke`,
    `${success}\nSQL> Error! validation broke`,
    `${success}\nERROR: validation broke`,
    `${success}\n[ERROR] validation broke`,
    `${success}\n\u001b[31mERROR: validation broke\u001b[0m`,
    `${success}\nAPEXlang Import Errors:`,
    `${success}\nFATAL: simulated failure`,
    `${success}\nTNS-12541: no listener`,
    `${success}\nIO Error: connection reset`,
    `${success}\nConnection failed`,
    `${success}\nException in thread "JLine Mask Thread" java.lang.IllegalStateException: Terminal has been closed`,
    `${success}\nunknown command`,
    `${success}\nEPERM`
  ]) {
    assert.equal(classifyWarningCompatibleSqlclValidation(output).accepted, false);
  }
});

test("downgrades only a proven warning-only problems artifact", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-warning-problems-"));
  try {
    const problemsPath = join(outputRoot, "logs/validation/problems.json");
    await mkdir(join(outputRoot, "logs/validation"), { recursive: true });
    const payload = {
      blocking_reasons: ["problems.json contains unresolved validation problems."],
      problem_count: 1,
      unresolved_count: 1,
      artifacts: { problems_path: problemsPath }
    };
    const warningPayload = {
      problem_count: 1,
      unresolved_count: 1,
      problems: [{
        source: "apex_validate",
        severity: "warning",
        message: "Warning: legacy property is deprecated."
      }]
    };
    await writeFile(problemsPath, JSON.stringify(warningPayload));
    assert.equal(
      (await proveWarningOnlyProblemsAreDiagnostics(payload, { outputRoot })).accepted,
      true
    );
    assert.equal(
      (await proveWarningOnlyProblemsAreDiagnostics(
        { ...payload, blocking_reasons: [] },
        { outputRoot }
      )).accepted,
      true
    );
    assert.deepEqual(
      await proveWarningOnlyProblemsAreDiagnostics(
        { blocking_reasons: [], problem_count: 0, unresolved_count: 0 },
        { outputRoot }
      ),
      { accepted: false, reason: "problems_artifact_missing_for_zero_counts" }
    );
    assert.equal(
      (await proveWarningOnlyProblemsAreDiagnostics(
        {
          ...payload,
          blocking_reasons: [],
          problem_count: 0,
          unresolved_count: 0
        },
        { outputRoot }
      )).accepted,
      false
    );
    await writeFile(problemsPath, JSON.stringify({
      problem_count: 0,
      unresolved_count: 0,
      problems: []
    }));
    assert.equal(
      (await proveWarningOnlyProblemsAreDiagnostics(
        {
          ...payload,
          blocking_reasons: [],
          problem_count: 0,
          unresolved_count: 0
        },
        { outputRoot }
      )).accepted,
      true
    );
    assert.equal(
      (await proveWarningOnlyProblemsAreDiagnostics(
        { ...payload, problem_count: 0, unresolved_count: 0 },
        { outputRoot }
      )).accepted,
      false
    );
    for (const invalidCounts of [
      { problem_count: -1, unresolved_count: -1 },
      { problem_count: 1.5, unresolved_count: 1.5 },
      { problem_count: "NaN", unresolved_count: 1 },
      { problem_count: 1 },
      { problem_count: 1, unresolved_count: 0 }
    ]) {
      assert.equal(
        (await proveWarningOnlyProblemsAreDiagnostics(
          { blocking_reasons: [], ...invalidCounts },
          { outputRoot }
        )).accepted,
        false
      );
    }

    await writeFile(problemsPath, JSON.stringify({
      ...warningPayload,
      problems: [{ source: "compiler_truth", severity: "error", message: "Invalid property" }]
    }));
    assert.equal(
      (await proveWarningOnlyProblemsAreDiagnostics(payload, { outputRoot })).accepted,
      false
    );
    assert.equal(
      (await proveWarningOnlyProblemsAreDiagnostics(
        { ...payload, blocking_reasons: [] },
        { outputRoot }
      )).accepted,
      false
    );
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("withholds import until validation passes in the same SQLcl process", async () => {
  const fakeSqlcl = String.raw`
    if (process.env.FAKE_PID_FILE) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
    }
    if (process.env.FAKE_DESCENDANT_SURVIVED_FILE) {
      const { spawn } = await import("node:child_process");
      spawn(process.execPath, [
        "--input-type=module",
        "-e",
        'import { writeFileSync } from "node:fs"; process.on("SIGHUP", () => {}); process.on("SIGTERM", () => {}); setTimeout(() => writeFileSync(process.env.FAKE_DESCENDANT_SURVIVED_FILE, "survived"), 900); setTimeout(() => {}, 5_000);'
      ], { env: process.env, stdio: "ignore" });
    }
    if (process.env.FAKE_VALIDATE_HANG === "1") {
      process.on("SIGHUP", () => {});
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 5_000);
    }
    if (process.env.FAKE_STOP_PROXY === "1") process.kill(process.ppid, "SIGSTOP");
    if (process.env.FAKE_STARTUP_FAILURE === "1") process.stdout.write("Connection failed\n");
    process.stdout.write(process.env.FAKE_CUSTOM_PROMPT === "1" ? "CUSTOM> " : "SQL> ");
    process.stdin.setEncoding("utf8");
    let pending = "";
    let sqlErrorGuard = false;
    let osErrorGuard = false;
    let validationHanging = false;
    function handle(line) {
      if (line === "whenever sqlerror exit failure rollback") {
        sqlErrorGuard = true;
        console.log("GUARD:sqlerror");
      } else if (line === "whenever oserror exit failure rollback") {
        osErrorGuard = true;
        console.log("GUARD:oserror");
      } else if (line.startsWith("apex validate")) {
        console.log("VALIDATE_COMMAND_RECEIVED");
        if (process.env.FAKE_VALIDATE_HANG === "1") {
          validationHanging = true;
          return;
        }
        if (!sqlErrorGuard || !osErrorGuard) console.error("FATAL: SQLcl guards missing");
        console.log("__PI_APEXLANG_VALIDATE_DONE__");
        console.log("APEXlang Compile Warnings:");
        console.log("Warning: legacy property.");
        if (process.env.FAKE_VALIDATE_FAILURE === "1") console.error("Error! validation broke");
        console.log("Validation successful.");
      } else if (line.startsWith("prompt ")) {
        console.log(line.slice(7));
        if (line.includes("IMPORT_DONE") && process.env.FAKE_POST_MARKER_FATAL === "1") {
          process.stdout.write("x".repeat(200_000) + "\n");
          console.error("FATAL: simulated post-marker failure");
        }
      } else if (line.startsWith("apex import")) {
        console.log("Importing application ID: 104 into workspace: TEST_WORKSPACE");
        if (process.env.FAKE_IMPORT_FATAL === "1") {
          console.error("FATAL: simulated import failure");
        }
        console.log("Import successful.");
      } else if (line.startsWith("exit ") || line === "exit") {
        process.exit(line.includes("failure") ? 1 : 0);
      }
    }
    process.stdin.on("data", (chunk) => {
      if (validationHanging) return;
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) handle(line);
        if (validationHanging) {
          pending = "";
          break;
        }
      }
    });
  `;
  const options = {
    cwd: tmpdir(),
    env: process.env,
    validateCommand: "apex validate fake",
    importCommand: "apex import fake",
    maxBuffer: 1024 * 1024,
    timeoutMs: 10_000
  };
  const passed = await executeSqlclValidationThenImport(
    process.execPath,
    ["--input-type=module", "-e", fakeSqlcl],
    options
  );
  assert.equal(passed.ok, true);
  assert.equal(passed.ptyBacked, true);
  assert.equal(passed.ptyProcessGroupReady, true);
  assert.equal(passed.sessionReady, true);
  assert.equal(passed.validationSent, true);
  assert.equal(passed.validationAccepted, true);
  assert.equal(passed.importSent, true);
  assert.match(
    passed.importOutput,
    /Importing application ID: 104 into workspace: TEST_WORKSPACE/
  );
  assert.ok(passed.stdout.indexOf("GUARD:sqlerror") < passed.stdout.indexOf("VALIDATE_COMMAND_RECEIVED"));
  assert.ok(passed.stdout.indexOf("GUARD:oserror") < passed.stdout.indexOf("VALIDATE_COMMAND_RECEIVED"));

  const customPrompt = await executeSqlclValidationThenImport(
    process.execPath,
    ["--input-type=module", "-e", fakeSqlcl],
    { ...options, env: { ...process.env, FAKE_CUSTOM_PROMPT: "1" } }
  );
  assert.equal(customPrompt.ok, true);
  assert.equal(customPrompt.sessionReady, true);
  assert.equal(customPrompt.importCompleted, true);

  const startupFailure = await executeSqlclValidationThenImport(
    process.execPath,
    ["--input-type=module", "-e", fakeSqlcl],
    { ...options, env: { ...process.env, FAKE_STARTUP_FAILURE: "1" } }
  );
  assert.equal(startupFailure.ok, false);
  assert.equal(startupFailure.validationSent, false);
  assert.equal(startupFailure.importSent, false);
  assert.doesNotMatch(startupFailure.stdout, /Importing application ID:/);

  const failed = await executeSqlclValidationThenImport(
    process.execPath,
    ["--input-type=module", "-e", fakeSqlcl],
    {
      ...options,
      env: { ...process.env, FAKE_VALIDATE_FAILURE: "1" }
    }
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.validationAccepted, false);
  assert.equal(failed.importSent, false);
  assert.doesNotMatch(failed.stdout, /Importing application ID:/);

  for (const env of [
    { FAKE_IMPORT_FATAL: "1" },
    { FAKE_POST_MARKER_FATAL: "1" }
  ]) {
    const importFailure = await executeSqlclValidationThenImport(
      process.execPath,
      ["--input-type=module", "-e", fakeSqlcl],
      { ...options, env: { ...process.env, ...env } }
    );
    assert.equal(importFailure.ok, false);
    assert.equal(importFailure.hardFailureDetected, true);
    assert.equal(importFailure.validationAccepted, true);
    assert.equal(importFailure.importSent, true);
  }

  const timeoutRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-pty-timeout-"));
  try {
    const pidPath = join(timeoutRoot, "sqlcl.pid");
    const survivedPath = join(timeoutRoot, "descendant-survived");
    const timedOut = await executeSqlclValidationThenImport(
      process.execPath,
      ["--input-type=module", "-e", fakeSqlcl],
      {
        ...options,
        env: {
          ...process.env,
          FAKE_PID_FILE: pidPath,
          FAKE_DESCENDANT_SURVIVED_FILE: survivedPath,
          FAKE_VALIDATE_HANG: "1",
          FAKE_STOP_PROXY: "1"
        },
        timeoutMs: 700
      }
    );
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.importSent, false);
    assert.match(timedOut.stderr, /timed out/);
    await waitForProcessExit(Number(await readFile(pidPath, "utf8")));
    await delay(1_000);
    await assert.rejects(access(survivedPath));
  } finally {
    await rm(timeoutRoot, { recursive: true, force: true });
  }

  const abortRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-pty-abort-"));
  try {
    const pidPath = join(abortRoot, "sqlcl.pid");
    const survivedPath = join(abortRoot, "descendant-survived");
    const controller = new AbortController();
    const aborted = executeSqlclValidationThenImport(
      process.execPath,
      ["--input-type=module", "-e", fakeSqlcl],
      {
        ...options,
        env: {
          ...process.env,
          FAKE_PID_FILE: pidPath,
          FAKE_DESCENDANT_SURVIVED_FILE: survivedPath,
          FAKE_VALIDATE_HANG: "1"
        },
        signal: controller.signal
      }
    );
    await waitForFile(pidPath);
    controller.abort();
    await assert.rejects(aborted, (error) => error?.name === "AbortError");
    await waitForProcessExit(Number(await readFile(pidPath, "utf8")));
    await delay(1_000);
    await assert.rejects(access(survivedPath));
  } finally {
    await rm(abortRoot, { recursive: true, force: true });
  }
});

test("requires exact existing-app identity proof and builds one-session SQLcl commands", () => {
  const stagedAppPath = "/tmp/output/runtime-apps/monitor";
  const payload = warningOnlyRuntimePayload(stagedAppPath);
  assert.deepEqual(
    validateUpdateExistingImportProof(
      payload,
      {
        action: "runtime_validate",
        db_connection_name: "test_apex_db",
        workspace_name: "TEST_WORKSPACE"
      },
      stagedAppPath
    ),
    {
      canonicalId: 104,
      canonicalAlias: "TEST_APP",
      sourceId: 104,
      sourceAlias: "TEST_APP",
      workspaceId: "1234567890123456",
      workspaceName: "TEST_WORKSPACE"
    }
  );
  assert.throws(
    () => validateUpdateExistingImportProof(
      { ...payload, canonical_application_alias: "OTHER_APP" },
      {
        action: "runtime_validate",
        db_connection_name: "test_apex_db",
        workspace_name: "TEST_WORKSPACE"
      },
      stagedAppPath
    ),
    /matching source and canonical aliases/
  );
  const commands = buildWarningCompatibleImportCommands({
    appPath: stagedAppPath,
    workspaceId: "1234567890123456",
    canonicalId: 104
  });
  assert.match(commands.validateCommand, /apex validate .* -workspaceid 1234567890123456/);
  assert.match(commands.importCommand, /apex import .* -workspaceid 1234567890123456 -id 104/);
  assert.equal(commands.validateCommand.includes("apex import"), false);
});

test("compatibility import preserves target proof and uses one staged SQLcl session", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-warning-import-"));
  try {
    const stagedAppPath = join(outputRoot, "runtime-apps/monitor");
    const deploymentPath = join(stagedAppPath, "deployments/default.json");
    const transcriptPath = join(outputRoot, "logs/runtime-run.log");
    await mkdir(join(stagedAppPath, "deployments"), { recursive: true });
    await mkdir(join(outputRoot, "logs"), { recursive: true });
    await writeFile(
      deploymentPath,
      JSON.stringify({ app: { id: 999 }, workspace: { name: "TEST_WORKSPACE" } })
    );
    await writeFile(transcriptPath, warningOnlyTranscript());
    const payload = {
      ...warningOnlyRuntimePayload(stagedAppPath),
      source_application_id: 999,
      frozen_preflight_facts: {
        ...warningOnlyRuntimePayload(stagedAppPath).frozen_preflight_facts,
        requested_application_id: 999
      },
      transcript_path: transcriptPath,
      report_path: join(outputRoot, "logs/runtime-run.json")
    };
    const processCalls = [];
    const input = {
      action: "runtime_validate",
      db_connection_name: " test_apex_db ",
      workspace_name: " TEST_WORKSPACE "
    };
    const validatedAppDigest = await computeApexlangAppDigest(stagedAppPath);
    const runtimeResult = {
      ok: false,
      code: 1,
      stdout: JSON.stringify(payload),
      stderr: "",
      action: "runtime_validate",
      command: { scriptPath: "roundtrip", args: [], prelude: [] },
      outputRoot,
      preludeResults: [],
      runtimeApp: { appPath: stagedAppPath, staged: true },
      appDigest: validatedAppDigest
    };
    const runOptions = { cwd: outputRoot, outputRoot, timeoutMs: 30_000 };
    const successfulSessionResult = () => {
      const validationOutput = [
        "APEXlang Compile Warnings:",
        "Warning: legacy property.",
        "Validation successful."
      ].join("\n");
      const importOutput = [
        "Importing application ID: 104 into workspace: TEST_WORKSPACE",
        "Import successful."
      ].join("\n");
      return {
        ok: true,
        code: 0,
        stdout: `${validationOutput}\n${importOutput}`,
        stderr: "",
        validationAccepted: true,
        validationEvidence: classifyWarningCompatibleSqlclValidation(validationOutput),
        ptyBacked: true,
        ptyProcessGroupReady: true,
        sessionReady: true,
        validationSent: true,
        importSent: true,
        importCompleted: true,
        hardFailureDetected: false,
        orderedMergedOutput: true,
        validationOutput,
        importOutput
      };
    };
    const result = await runWarningCompatibleImport(
      input,
      runtimeResult,
      runOptions,
      {
        async sessionRunner(executable, args, options) {
          processCalls.push({ executable, args, options });
          return successfulSessionResult();
        }
      }
    );
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(result.stdout).import_status, "pass");
    assert.equal(JSON.parse(result.stdout).direct_import_bypass_forbidden, true);
    assert.equal(processCalls.length, 1);
    assert.deepEqual(processCalls[0].args, ["-S", "-name", "test_apex_db"]);
    assert.match(processCalls[0].options.validateCommand, /apex validate/);
    assert.equal(processCalls[0].options.validateCommand.includes("apex import"), false);
    assert.match(
      processCalls[0].options.importCommand,
      /-workspaceid 1234567890123456 -id 104/
    );
    assert.equal(JSON.parse(await readFile(deploymentPath, "utf8")).app.id, 104);
    const compatibilityRecord = JSON.parse(await readFile(
      join(outputRoot, "logs/compat/sqlcl-warning-policy-import.json"),
      "utf8"
    ));
    assert.equal(compatibilityRecord.pty_backed_sqlcl_session, true);
    assert.equal(compatibilityRecord.pty_process_group_ready, true);
    assert.equal(compatibilityRecord.session_ready_marker, true);

    for (const missingTransportProof of [
      "ptyBacked",
      "ptyProcessGroupReady",
      "sessionReady",
      "validationSent"
    ]) {
      await writeFile(
        deploymentPath,
        JSON.stringify({ app: { id: 999 }, workspace: { name: "TEST_WORKSPACE" } })
      );
      await assert.rejects(
        runWarningCompatibleImport(input, runtimeResult, runOptions, {
          async sessionRunner() {
            const sessionResult = successfulSessionResult();
            sessionResult[missingTransportProof] = false;
            return sessionResult;
          }
        }),
        /did not return proven SQLcl success/
      );
    }

    await writeFile(
      deploymentPath,
      JSON.stringify({ app: { id: 998 }, workspace: { name: "TEST_WORKSPACE" } })
    );
    let mismatchedSessionCalled = false;
    await assert.rejects(
      runWarningCompatibleImport(input, runtimeResult, runOptions, {
        async sessionRunner() {
          mismatchedSessionCalled = true;
          return successfulSessionResult();
        }
      }),
      /does not match the frozen source identity/
    );
    assert.equal(mismatchedSessionCalled, false);

    await writeFile(
      deploymentPath,
      JSON.stringify({ app: { id: 999 }, workspace: { name: "TEST_WORKSPACE" } })
    );
    await assert.rejects(
      runWarningCompatibleImport(input, runtimeResult, runOptions, {
        async sessionRunner() {
          const sessionResult = successfulSessionResult();
          sessionResult.importOutput = [
            "Importing application ID: 104 into workspace: TEST_WORKSPACE",
            "Importing application ID: 105 into workspace: TEST_WORKSPACE"
          ].join("\n");
          sessionResult.stdout = `${sessionResult.validationOutput}\n${sessionResult.importOutput}`;
          return sessionResult;
        }
      }),
      /did not return proven SQLcl success/
    );

    for (const malformedImportOutput of [
      "Importing application ID: 104",
      "prefix Importing application ID: 104 suffix",
      "SQL> Importing application ID: 104",
      "Importing application ID:\n104",
      "Importing application ID: 104 into workspace: OTHER\nImport successful.",
      "Importing application ID: 104 into workspace: TEST_WORKSPACE",
      "Import successful.\nImporting application ID: 104 into workspace: TEST_WORKSPACE",
      "Importing application ID: 104 into workspace: TEST_WORKSPACE\nImport successful.\nUnexpected trailing output",
      "Importing application ID: 104 into workspace: TEST_WORKSPACE\nImport successful.\nImport successful.",
      "Importing application ID: 104 into workspace: TEST_WORKSPACE\nImporting application ID: 104 into workspace: TEST_WORKSPACE\nImport successful."
    ]) {
      await writeFile(
        deploymentPath,
        JSON.stringify({ app: { id: 999 }, workspace: { name: "TEST_WORKSPACE" } })
      );
      await assert.rejects(
        runWarningCompatibleImport(input, runtimeResult, runOptions, {
          async sessionRunner() {
            const sessionResult = successfulSessionResult();
            sessionResult.importOutput = malformedImportOutput;
            sessionResult.stdout = `${sessionResult.validationOutput}\n${malformedImportOutput}`;
            return sessionResult;
          }
        }),
        /did not return proven SQLcl success/
      );
    }

    await writeFile(
      deploymentPath,
      JSON.stringify({ app: { id: 999 }, workspace: { name: "TEST_WORKSPACE" } })
    );
    await assert.rejects(
      runWarningCompatibleImport(input, runtimeResult, runOptions, {
        async sessionRunner() {
          const sessionResult = successfulSessionResult();
          sessionResult.stdout = `${sessionResult.stdout}\n__IMPORT_DONE__\nFATAL: simulated failure`;
          return sessionResult;
        }
      }),
      /did not return proven SQLcl success/
    );

    await writeFile(
      deploymentPath,
      JSON.stringify({ app: { id: 999 }, workspace: { name: "TEST_WORKSPACE" } })
    );
    await writeFile(join(stagedAppPath, "changed.apx"), "changed after validation\n");
    let driftedSessionCalled = false;
    await assert.rejects(
      runWarningCompatibleImport(input, runtimeResult, runOptions, {
        async sessionRunner() {
          driftedSessionCalled = true;
          return successfulSessionResult();
        }
      }),
      /changed after validation/
    );
    assert.equal(driftedSessionCalled, false);
    await access(join(outputRoot, "logs/compat/sqlcl-warning-policy-import.log"));
    await access(join(outputRoot, "logs/compat/sqlcl-warning-policy-import-failure.json"));
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test("always enables compiler-backed component verification", () => {
  const command = buildApexlangCommand({
    action: "compiler_truth_audit",
    app_path: "applications/orders"
  });
  assert.equal(command.args.includes("--verify-component-attributes"), true);
});

test("keeps app paths inside the workspace and rejects symlink roots", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-path-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-apexlang-path-outside-"));
  try {
    await mkdir(join(workspace, "applications"));
    assert.equal(
      await assertProjectAppPath("applications/orders", workspace),
      join(workspace, "applications/orders")
    );
    await assert.rejects(
      assertProjectAppPath(join(outside, "orders"), workspace),
      /must stay within/
    );
    await symlink(outside, join(workspace, "applications/link"), "dir");
    await assert.rejects(
      assertProjectAppPath("applications/link", workspace),
      /symbolic link/
    );
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true })
    ]);
  }
});

test("allows only an exact direct child of the real materialization root", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-gate-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-apexlang-gate-outside-"));
  try {
    await mkdir(join(workspace, "applications"));
    assert.equal(
      await validateMaterializationPaths({
        cwd: workspace,
        standardRoot: "applications",
        requested: join(workspace, "applications/orders"),
        suggested: "applications/orders"
      }),
      join(workspace, "applications/orders")
    );
    for (const [requested, suggested] of [
      ["applications/../orders", "applications/../orders"],
      ["applications/team/orders", "applications/team/orders"],
      ["applications", "applications"],
      [join(outside, "orders"), join(outside, "orders")]
    ]) {
      await assert.rejects(
        validateMaterializationPaths({
          cwd: workspace,
          standardRoot: "applications",
          requested,
          suggested
        }),
        /direct-child|exact direct-child/
      );
    }

    await symlink(outside, join(workspace, "linked-applications"), "dir");
    await assert.rejects(
      validateMaterializationPaths({
        cwd: workspace,
        standardRoot: "linked-applications",
        requested: "linked-applications/orders",
        suggested: "linked-applications/orders"
      }),
      /real directories/
    );
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true })
    ]);
  }
});

test("rejects runtime workspace metadata that differs from explicit user context", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-workspace-match-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-workspace-match-output-"));
  try {
    const deploymentDirectory = join(workspace, "applications/orders/deployments");
    await mkdir(deploymentDirectory, { recursive: true });
    await writeFile(
      join(deploymentDirectory, "default.json"),
      JSON.stringify({ workspace: { name: "ORDERS_PROD" } })
    );
    await assert.rejects(
      runApexlang(
        {
          action: "runtime_validate",
          app_path: "applications/orders",
          db_connection_name: "apex_dev",
          workspace_name: "ORDERS_DEV"
        },
        { cwd: workspace, outputRoot, timeoutMs: 30_000 }
      ),
      /does not match deployments\/default.json/
    );
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true })
    ]);
  }
});

test("normalizes SQLcl export workspace shapes only in an ephemeral runtime copy", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-export-shape-workspace-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-export-shape-output-"));
  try {
    const appPath = join(workspace, "monitor");
    const deploymentDirectory = join(appPath, "deployments");
    await mkdir(deploymentDirectory, { recursive: true });
    const deploymentPath = join(deploymentDirectory, "default.json");
    await writeFile(
      deploymentPath,
      JSON.stringify({ app: { id: 104, workspace: { name: "test_workspace" } } })
    );

    const prepared = await prepareRuntimeApp(
      {
        action: "runtime_validate",
        app_path: "monitor",
        db_connection_name: "test_apex_db",
        workspace_name: "TEST_WORKSPACE"
      },
      workspace,
      outputRoot
    );
    assert.equal(prepared.staged, true);
    assert.equal(prepared.workspaceSource, "app.workspace.name");
    assert.notEqual(prepared.appPath, appPath);
    assert.deepEqual(JSON.parse(await readFile(deploymentPath, "utf8")), {
      app: { id: 104, workspace: { name: "test_workspace" } }
    });
    const stagedDeployment = JSON.parse(
      await readFile(join(prepared.appPath, "deployments/default.json"), "utf8")
    );
    assert.equal(stagedDeployment.workspace.name, "TEST_WORKSPACE");

    await writeFile(deploymentPath, JSON.stringify({ app: { id: 104 } }));
    const missingWorkspace = await prepareRuntimeApp(
      {
        action: "runtime_validate",
        app_path: "monitor",
        db_connection_name: "test_apex_db",
        workspace_name: "test_workspace"
      },
      workspace,
      outputRoot
    );
    assert.equal(missingWorkspace.staged, true);
    assert.equal(missingWorkspace.workspaceSource, "explicit_workspace_name");
    assert.equal(
      JSON.parse(
        await readFile(join(missingWorkspace.appPath, "deployments/default.json"), "utf8")
      ).workspace.name,
      "test_workspace"
    );

    await writeFile(
      deploymentPath,
      JSON.stringify({ app: { id: 104 }, workspace: { name: "TEST_WORKSPACE" } })
    );
    const forcedStage = await prepareRuntimeApp(
      {
        action: "runtime_validate",
        app_path: "monitor",
        db_connection_name: "test_apex_db",
        workspace_name: "test_workspace"
      },
      workspace,
      outputRoot,
      { forceStage: true }
    );
    assert.equal(forcedStage.staged, true);
    assert.notEqual(forcedStage.appPath, appPath);
    assert.equal(JSON.parse(await readFile(deploymentPath, "utf8")).app.id, 104);
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true })
    ]);
  }
});

test("binds staged runtime trees with a canonical application digest", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-digest-workspace-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-digest-output-"));
  try {
    const appPath = join(workspace, "monitor");
    const deploymentPath = join(appPath, "deployments/default.json");
    const pagePath = join(appPath, "pages/p00005.apx");
    await mkdir(join(appPath, "deployments"), { recursive: true });
    await mkdir(join(appPath, "pages"), { recursive: true });
    await writeFile(
      deploymentPath,
      JSON.stringify({ app: { id: 104, workspace: { name: "TEST_WORKSPACE" } } })
    );
    await writeFile(pagePath, "page 5 (\n  region result ( type: classicReport )\n)\n");
    const sourceDigest = await computeApexlangAppDigest(appPath);
    const prepared = await prepareRuntimeApp(
      {
        action: "runtime_validate",
        app_path: "monitor",
        db_connection_name: "test_apex_db",
        workspace_name: "TEST_WORKSPACE"
      },
      workspace,
      outputRoot
    );
    assert.equal(await computeApexlangAppDigest(prepared.appPath), sourceDigest);

    const stagedPagePath = join(prepared.appPath, "pages/p00005.apx");
    await writeFile(stagedPagePath, "page 5 (\n  region result ( type: cards )\n)\n");
    assert.notEqual(await computeApexlangAppDigest(prepared.appPath), sourceDigest);
    await writeFile(stagedPagePath, await readFile(pagePath));

    const stagedDeploymentPath = join(prepared.appPath, "deployments/default.json");
    const stagedDeployment = JSON.parse(await readFile(stagedDeploymentPath, "utf8"));
    stagedDeployment.app.id = 105;
    await writeFile(stagedDeploymentPath, JSON.stringify(stagedDeployment, null, 2));
    assert.notEqual(await computeApexlangAppDigest(prepared.appPath), sourceDigest);
    stagedDeployment.app.id = 104;
    stagedDeployment.workspace.environment = "production";
    await writeFile(stagedDeploymentPath, JSON.stringify(stagedDeployment, null, 2));
    assert.notEqual(await computeApexlangAppDigest(prepared.appPath), sourceDigest);
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true })
    ]);
  }
});

test("blocks import before runtime invocation when the approved app digest drifted", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-import-drift-workspace-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-import-drift-output-"));
  try {
    const appPath = join(workspace, "monitor");
    await mkdir(join(appPath, "deployments"), { recursive: true });
    await writeFile(
      join(appPath, "deployments/default.json"),
      JSON.stringify({ app: { id: 104 }, workspace: { name: "TEST_WORKSPACE" } })
    );
    await assert.rejects(
      runApexlangImport(
        {
          action: "runtime_validate",
          app_path: "monitor",
          db_connection_name: "test_apex_db",
          workspace_name: "TEST_WORKSPACE"
        },
        { cwd: workspace, outputRoot, timeoutMs: 30_000 },
        {
          targetResolutionMode: "update-existing",
          createNewConfirmed: false,
          expectedAppDigest: "0".repeat(64)
        }
      ),
      /changed after the approved live check/
    );
    await assert.rejects(
      runApexlangImport(
        {
          action: "runtime_validate",
          app_path: "monitor",
          db_connection_name: "test_apex_db",
          workspace_name: "TEST_WORKSPACE"
        },
        { cwd: workspace, outputRoot, timeoutMs: 30_000 },
        { targetResolutionMode: "update-existing" }
      ),
      /expectedAppDigest/
    );
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true })
    ]);
  }
});

test("rejects conflicting exported workspace metadata before runtime staging", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-workspace-conflict-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-workspace-conflict-output-"));
  try {
    const deploymentDirectory = join(workspace, "monitor/deployments");
    await mkdir(deploymentDirectory, { recursive: true });
    await writeFile(
      join(deploymentDirectory, "default.json"),
      JSON.stringify({
        workspace: { name: "TEST_WORKSPACE" },
        app: { id: 104, workspace: { name: "OTHER_WORKSPACE" } }
      })
    );
    await assert.rejects(
      prepareRuntimeApp(
        {
          action: "runtime_validate",
          app_path: "monitor",
          db_connection_name: "test_apex_db",
          workspace_name: "TEST_WORKSPACE"
        },
        workspace,
        outputRoot
      ),
      /conflicting workspace names/
    );
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true })
    ]);
  }
});

test("blocks metadata-file symlinks before workspace discovery", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-probe-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-apexlang-probe-outside-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-probe-output-"));
  try {
    const outsideMetadata = join(outside, "schema.json");
    await writeFile(outsideMetadata, JSON.stringify({ tables: [{ name: "SECRET" }] }));
    await symlink(outsideMetadata, join(workspace, "schema.json"), "file");
    await assert.rejects(
      runApexlang(
        { action: "workspace_probe" },
        { cwd: workspace, outputRoot, timeoutMs: 30_000 }
      ),
      /metadata-file symlink/
    );
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true })
    ]);
  }
});

test("vocabulary fixing refuses hard-linked project files", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-apexlang-hardlink-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-apexlang-hardlink-outside-"));
  const outputRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-hardlink-output-"));
  try {
    const appPath = join(workspace, "applications/orders");
    await mkdir(appPath, { recursive: true });
    const outsideFile = join(outside, "page.apx");
    await writeFile(outsideFile, "page 1 (\n)\n");
    await link(outsideFile, join(appPath, "page.apx"));
    await assert.rejects(
      runApexlang(
        { action: "local_validate", app_path: "applications/orders", fix_vocab: true },
        { cwd: workspace, outputRoot, timeoutMs: 30_000 }
      ),
      /refuse multiply linked files/
    );
  } finally {
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
      rm(outputRoot, { recursive: true, force: true })
    ]);
  }
});

test("aborting a runner kills its process-tree descendants", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-tree-abort-"));
  const parentPath = join(fixtureRoot, "parent.mjs");
  const childPath = join(fixtureRoot, "child.mjs");
  const readyPath = join(fixtureRoot, "ready");
  const survivedPath = join(fixtureRoot, "survived");
  try {
    await writeFile(
      childPath,
      [
        'import { writeFileSync } from "node:fs";',
        "const [ready, survived] = process.argv.slice(2);",
        'writeFileSync(ready, "ready");',
        'setTimeout(() => writeFileSync(survived, "survived"), 900);',
        "setTimeout(() => process.exit(0), 2_000);"
      ].join("\n")
    );
    await writeFile(
      parentPath,
      [
        'import { spawn } from "node:child_process";',
        "const [child, ready, survived] = process.argv.slice(2);",
        "spawn(process.execPath, [child, ready, survived], { stdio: \"ignore\" });",
        "setTimeout(() => process.exit(0), 4_000);"
      ].join("\n")
    );
    const controller = new AbortController();
    const processPromise = executeProcessTree(
      process.execPath,
      [parentPath, childPath, readyPath, survivedPath],
      {
        cwd: fixtureRoot,
        env: process.env,
        signal: controller.signal,
        timeoutMs: 5_000
      }
    );
    await waitForFile(readyPath);
    controller.abort();
    await assert.rejects(processPromise, (error) => error?.name === "AbortError");
    await delay(1_100);
    await assert.rejects(access(survivedPath));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("runner timeouts and output limits fail closed", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-tree-limits-"));
  try {
    const stdinResult = await executeProcessTree(
      process.execPath,
      ["--eval", 'process.stdin.setEncoding("utf8"); let value=""; process.stdin.on("data", chunk => value += chunk); process.stdin.on("end", () => process.stdout.write(value));'],
      { cwd: fixtureRoot, env: process.env, input: "one-session\n", timeoutMs: 2_000 }
    );
    assert.equal(stdinResult.ok, true);
    assert.equal(stdinResult.stdout, "one-session\n");

    const timeoutResult = await executeProcessTree(
      process.execPath,
      ["--eval", "setTimeout(() => {}, 5_000)"],
      { cwd: fixtureRoot, env: process.env, timeoutMs: 50 }
    );
    assert.equal(timeoutResult.ok, false);
    assert.match(timeoutResult.stderr, /timed out/);

    const outputResult = await executeProcessTree(
      process.execPath,
      ["--eval", 'process.stdout.write("x".repeat(4096)); setTimeout(() => {}, 5_000)'],
      { cwd: fixtureRoot, env: process.env, maxBuffer: 100, timeoutMs: 2_000 }
    );
    assert.equal(outputResult.ok, false);
    assert.match(outputResult.stderr, /output limit exceeded/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("requires compiler query identity and emits JSON", () => {
  assert.throws(
    () => buildApexlangCommand({ action: "query_valid_props" }),
    /component, component_type_id, template_component, or list=true is required/
  );
  const command = buildApexlangCommand({
    action: "query_valid_props",
    component: "region",
    group: "source",
    when: ["94=NATIVE_IR", "957=LOCAL"]
  });
  assert.deepEqual(command.args, [
    "--component",
    "region",
    "--group",
    "source",
    "--when",
    "94=NATIVE_IR",
    "--when",
    "957=LOCAL",
    "--json"
  ]);

  const listCommand = buildApexlangCommand({ action: "query_valid_props", list: true });
  assert.deepEqual(listCommand.args, ["--list", "--json"]);
});
