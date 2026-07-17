import assert from "node:assert/strict";
import { access, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  APEXLANG_ACTIONS,
  assertProjectAppPath,
  buildApexlangCommand,
  buildApexlangImportCommand,
  executeProcessTree,
  validateMaterializationPaths,
  runApexlang
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
