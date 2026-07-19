import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CREATE_NEW_CHOICE,
  IMPORT_CHOICE,
  UPDATE_EXISTING_CHOICE,
  createApexlangTool,
  createNewTargetProved,
  liveImportPassed,
  liveValidationPassed,
  default as apexlangExtension
} from "../extensions/apexlang/index.ts";

const TEST_APP_DIGEST = "a".repeat(64);

function stubResult(payload, { ok = true, code = ok ? 0 : 1 } = {}) {
  return {
    ok,
    code,
    stdout: JSON.stringify(payload),
    stderr: "",
    action: "runtime_validate",
    command: { scriptPath: "apexctl", args: [], prelude: [] },
    outputRoot: "/tmp/pi-apexlang-test-reports",
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
