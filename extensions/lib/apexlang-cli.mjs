import { spawn } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export const APEXLANG_SKILL_ROOT = resolve(moduleDirectory, "../../skills/apexlang");
export const APEXLANG_ACTIONS = Object.freeze([
  "workspace_probe",
  "new_app_materialize",
  "local_validate",
  "compiler_truth_audit",
  "query_valid_props",
  "runtime_preflight",
  "runtime_doctor",
  "runtime_validate"
]);

const apexctlPath = resolve(APEXLANG_SKILL_ROOT, "tools/apexctl.mjs");
const queryValidPropsPath = resolve(APEXLANG_SKILL_ROOT, "tools/query-valid-props.mjs");
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_$#.-]{0,127}$/;
const COMPONENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

function assertPlainText(value, key) {
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${key} must not contain control characters`);
  }
  return value;
}

function requireText(input, key, action) {
  const value = String(input[key] ?? "").trim();
  if (!value) {
    throw new Error(`${key} is required for ${action}`);
  }
  return assertPlainText(value, key);
}

function optionalText(input, key) {
  const value = String(input[key] ?? "").trim();
  return value ? assertPlainText(value, key) : undefined;
}

function validateConnectionName(value) {
  if (!CONNECTION_NAME_PATTERN.test(value)) {
    throw new Error(
      "db_connection_name must be a saved SQLcl alias containing only letters, numbers, underscores, dots, or hyphens"
    );
  }
  return value;
}

function requireConnectionName(input, action) {
  return validateConnectionName(requireText(input, "db_connection_name", action));
}

function optionalConnectionName(input) {
  const value = optionalText(input, "db_connection_name");
  return value ? validateConnectionName(value) : undefined;
}

function validateWorkspaceName(value) {
  if (!WORKSPACE_NAME_PATTERN.test(value)) {
    throw new Error(
      "workspace_name must contain only letters, numbers, underscores, dollar signs, hash signs, dots, or hyphens"
    );
  }
  return value;
}

function requireWorkspaceName(input, action) {
  return validateWorkspaceName(requireText(input, "workspace_name", action));
}

function optionalWorkspaceName(input) {
  const value = optionalText(input, "workspace_name");
  return value ? validateWorkspaceName(value) : undefined;
}

function validatePath(value, key) {
  if (/["&]/.test(value)) {
    throw new Error(`${key} must not contain double quotes or ampersands`);
  }
  return value;
}

function requirePath(input, key, action) {
  return validatePath(requireText(input, key, action), key);
}

function optionalPath(input, key) {
  const value = optionalText(input, key);
  return value ? validatePath(value, key) : undefined;
}

function optionalComponentName(input, key) {
  const value = optionalText(input, key);
  if (value && !COMPONENT_NAME_PATTERN.test(value)) {
    throw new Error(`${key} must be a compiler component identifier`);
  }
  return value;
}

function addOption(args, name, value) {
  if (value !== undefined) {
    args.push(name, value);
  }
}

function addFlag(args, name, enabled) {
  if (enabled === true) {
    args.push(name);
  }
}

function apexctl(args, prelude = []) {
  return { scriptPath: apexctlPath, args, prelude };
}

export function buildApexlangCommand(input) {
  const action = String(input.action ?? "").trim();
  if (!APEXLANG_ACTIONS.includes(action)) {
    throw new Error(`Unsupported APEXlang action: ${action || "<empty>"}`);
  }

  if (action === "workspace_probe") {
    const connectionName = optionalConnectionName(input);
    const workspaceName = optionalWorkspaceName(input);
    if (connectionName && !workspaceName) {
      throw new Error("workspace_name is required with db_connection_name for workspace_probe");
    }
    if (workspaceName && !connectionName) {
      throw new Error("db_connection_name is required with workspace_name for workspace_probe");
    }
    const args = ["workspace", "probe"];
    addOption(args, "--db-connection-name", connectionName);
    addOption(args, "--workspace-name", workspaceName);
    return apexctl(args);
  }

  if (action === "new_app_materialize") {
    const connectionName = requireConnectionName(input, action);
    const workspaceName = requireWorkspaceName(input, action);
    const args = [
      "new-app",
      "materialize",
      "--app-path",
      requirePath(input, "app_path", action),
      "--workspace-name",
      workspaceName
    ];
    return apexctl(args, [
      {
        scriptPath: apexctlPath,
        args: [
          "workspace",
          "probe",
          "--db-connection-name",
          connectionName,
          "--workspace-name",
          workspaceName
        ]
      }
    ]);
  }

  if (action === "local_validate") {
    const args = ["apexlang", "validate", "--app-path", requirePath(input, "app_path", action)];
    addFlag(args, "--fix-vocab", input.fix_vocab);
    return apexctl(args);
  }

  if (action === "compiler_truth_audit") {
    const args = [
      "apexlang",
      "compiler-truth",
      "audit",
      "--app-path",
      requirePath(input, "app_path", action)
    ];
    addOption(args, "--compiler-oracle-home", optionalPath(input, "compiler_oracle_home"));
    args.push("--verify-component-attributes");
    return apexctl(args);
  }

  if (action === "query_valid_props") {
    const component = optionalComponentName(input, "component");
    const componentTypeId = optionalText(input, "component_type_id");
    const templateComponent = optionalComponentName(input, "template_component");
    if (componentTypeId && !/^\d+$/.test(componentTypeId)) {
      throw new Error("component_type_id must be numeric");
    }
    if (!input.list && !component && !componentTypeId && !templateComponent) {
      throw new Error(
        "component, component_type_id, template_component, or list=true is required for query_valid_props"
      );
    }
    const args = [];
    addOption(args, "--component", component);
    addOption(args, "--component-type-id", componentTypeId);
    addOption(args, "--template-component", templateComponent);
    addOption(args, "--parent", optionalComponentName(input, "parent"));
    addOption(args, "--group", optionalComponentName(input, "group"));
    addOption(args, "--compiler-oracle-home", optionalPath(input, "compiler_oracle_home"));
    for (const condition of input.when ?? []) {
      const value = String(condition).trim();
      addOption(args, "--when", value ? assertPlainText(value, "when") : undefined);
    }
    addFlag(args, "--list", input.list);
    args.push("--json");
    return { scriptPath: queryValidPropsPath, args, prelude: [] };
  }

  if (action === "runtime_preflight" || action === "runtime_doctor") {
    const runtimeAction = action === "runtime_preflight" ? "preflight" : "doctor";
    const connectionName = requireConnectionName(input, action);
    const workspaceName = requireWorkspaceName(input, action);
    const args = ["runtime", runtimeAction];
    addOption(args, "--app-path", optionalPath(input, "app_path"));
    addOption(args, "--db-connection-name", connectionName);
    addOption(args, "--execution-mode", optionalText(input, "execution_mode"));
    addOption(args, "--apex-root", optionalPath(input, "apex_root"));
    addFlag(args, "--supporting-objects", input.supporting_objects);
    const prelude = [
      {
        scriptPath: apexctlPath,
        args: [
          "workspace",
          "probe",
          "--db-connection-name",
          connectionName,
          "--workspace-name",
          workspaceName
        ]
      }
    ];
    return apexctl(args, prelude);
  }

  const appPath = requirePath(input, "app_path", action);
  const connectionName = requireConnectionName(input, action);
  const workspaceName = requireWorkspaceName(input, action);
  const probeArgs = [
    "workspace",
    "probe",
    "--db-connection-name",
    connectionName,
    "--workspace-name",
    workspaceName
  ];
  const args = [
    "runtime",
    "validate",
    "--app-path",
    appPath,
    "--db-connection-name",
    connectionName
  ];
  addOption(args, "--execution-mode", optionalText(input, "execution_mode"));
  addOption(args, "--apex-root", optionalPath(input, "apex_root"));
  addOption(args, "--compiler-oracle-home", optionalPath(input, "compiler_oracle_home"));
  return apexctl(args, [{ scriptPath: apexctlPath, args: probeArgs }]);
}

export function buildApexlangImportCommand(input, importOptions = {}) {
  const action = "runtime_validate";
  const appPath = requirePath(input, "app_path", action);
  const connectionName = requireConnectionName(input, action);
  const workspaceName = requireWorkspaceName(input, action);
  const targetResolutionMode = importOptions.targetResolutionMode ?? "update-existing";
  if (!["update-existing", "create-new"].includes(targetResolutionMode)) {
    throw new Error(`Unsupported import target resolution mode: ${targetResolutionMode}`);
  }
  const probeArgs = [
    "workspace",
    "probe",
    "--db-connection-name",
    connectionName,
    "--workspace-name",
    workspaceName
  ];
  const args = [
    "runtime",
    "roundtrip",
    "--app-path",
    appPath,
    "--db-connection-name",
    connectionName,
    "--import-intent",
    "validate-and-import",
    "--target-resolution-mode",
    targetResolutionMode
  ];
  addFlag(
    args,
    "--create-new-confirmed",
    targetResolutionMode === "create-new" && importOptions.createNewConfirmed === true
  );
  addOption(args, "--execution-mode", optionalText(input, "execution_mode"));
  addOption(args, "--apex-root", optionalPath(input, "apex_root"));
  addFlag(args, "--supporting-objects", input.supporting_objects);
  return apexctl(args, [{ scriptPath: apexctlPath, args: probeArgs }]);
}

function abortError() {
  return new DOMException("The operation was aborted", "AbortError");
}

function isWithin(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

async function nearestExistingRealPath(candidate) {
  let current = candidate;
  while (true) {
    try {
      return await realpath(current);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

export async function assertProjectAppPath(appPath, cwd) {
  const workspacePath = resolve(cwd);
  const candidatePath = resolve(
    workspacePath,
    validatePath(assertPlainText(appPath, "app_path"), "app_path")
  );
  if (!isWithin(workspacePath, candidatePath)) {
    throw new Error("app_path must stay within the current pi workspace");
  }

  const [workspaceRealPath, candidateRealAncestor] = await Promise.all([
    realpath(workspacePath),
    nearestExistingRealPath(candidatePath)
  ]);
  if (!isWithin(workspaceRealPath, candidateRealAncestor)) {
    throw new Error("app_path must not escape the current pi workspace through a symbolic link");
  }
  try {
    const candidateStats = await lstat(candidatePath);
    if (candidateStats.isSymbolicLink()) {
      throw new Error("app_path must not be a symbolic link");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return candidatePath;
}

async function assertSymlinkFreeTree(root, { rejectHardlinks = false } = {}) {
  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (rootStats.isSymbolicLink()) {
    throw new Error("app_path must not be a symbolic link");
  }
  if (!rootStats.isDirectory()) return;

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = resolve(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`APEXlang app trees must not contain symbolic links: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await assertSymlinkFreeTree(entryPath, { rejectHardlinks });
    } else if (rejectHardlinks && entry.isFile()) {
      const entryStats = await lstat(entryPath);
      if (entryStats.nlink > 1) {
        throw new Error(
          `APEXlang vocabulary fixes refuse multiply linked files: ${entryPath}`
        );
      }
    }
  }
}

let workspaceIntelligencePromise;

async function workspaceIntelligence() {
  workspaceIntelligencePromise ??= readFile(
    resolve(APEXLANG_SKILL_ROOT, "assets/workspace-intelligence.json"),
    "utf8"
  ).then((contents) => JSON.parse(contents));
  return workspaceIntelligencePromise;
}

async function assertWorkspaceProbeCannotFollowSymlinks(cwd) {
  const intelligence = await workspaceIntelligence();
  const config = intelligence.bounded_scan;
  const allowedExtensions = new Set(config.allowed_extensions);
  const excludedDirectories = new Set(config.excluded_directories);

  const standardRootPath = resolve(cwd, intelligence.app_discovery.standard_root);
  try {
    const standardRootStats = await lstat(standardRootPath);
    if (standardRootStats.isSymbolicLink()) {
      throw new Error(
        `workspace probe refuses a symbolic-link standard app root: ${standardRootPath}`
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  async function walk(current, depth) {
    if (depth > config.max_depth) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) {
          await walk(resolve(current, entry.name), depth + 1);
        }
        continue;
      }
      if (entry.isSymbolicLink() && allowedExtensions.has(extname(entry.name).toLowerCase())) {
        throw new Error(
          `workspace probe refuses an allowed metadata-file symlink that could escape the session boundary: ${resolve(current, entry.name)}`
        );
      }
    }
  }

  await walk(resolve(cwd), 0);
}

async function assertDeploymentWorkspace(input, cwd) {
  if (!input.app_path ||
      !["runtime_validate", "runtime_preflight", "runtime_doctor"].includes(input.action)) {
    return;
  }
  const appPath = resolve(cwd, input.app_path);
  const deploymentPath = resolve(appPath, "deployments/default.json");
  let deployment;
  try {
    deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
  } catch (error) {
    throw new Error(
      `deployments/default.json is required before ${input.action}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const declaredWorkspace = String(deployment?.workspace?.name ?? "").trim();
  const requestedWorkspace = String(input.workspace_name ?? "").trim();
  if (!declaredWorkspace || declaredWorkspace === "__REQUIRED_WORKSPACE_NAME__") {
    throw new Error("deployments/default.json must declare the exact destination workspace.name");
  }
  if (declaredWorkspace.toUpperCase() !== requestedWorkspace.toUpperCase()) {
    throw new Error(
      `workspace_name ${requestedWorkspace} does not match deployments/default.json workspace.name ${declaredWorkspace}`
    );
  }
}

function isDirectChild(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return Boolean(pathFromRoot) &&
    !isAbsolute(pathFromRoot) &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !/[\\/]/.test(pathFromRoot);
}

async function assertRealDirectoryChain(base, target) {
  const pathFromBase = relative(base, target);
  if (!pathFromBase || isAbsolute(pathFromBase) || pathFromBase.startsWith(`..${sep}`)) {
    throw new Error("standard_root must be a directory below the current pi workspace");
  }
  let current = base;
  for (const segment of pathFromBase.split(sep)) {
    current = resolve(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("standard_root and its workspace ancestors must be real directories");
    }
  }
}

export async function validateMaterializationPaths({ cwd, standardRoot, requested, suggested }) {
  const workspacePath = resolve(cwd);
  if (!standardRoot || isAbsolute(standardRoot) || CONTROL_CHARACTER_PATTERN.test(standardRoot)) {
    throw new Error("workspace probe returned an invalid standard_root");
  }
  const standardRootPath = resolve(workspacePath, standardRoot);
  if (standardRootPath === workspacePath || !isWithin(workspacePath, standardRootPath)) {
    throw new Error("workspace probe standard_root must stay below the current pi workspace");
  }

  const requestedPath = resolve(workspacePath, requested);
  const suggestedPath = resolve(workspacePath, suggested);
  if (!isDirectChild(standardRootPath, requestedPath) ||
      !isDirectChild(standardRootPath, suggestedPath) ||
      requestedPath !== suggestedPath) {
    throw new Error("new app path must be the exact direct-child path suggested by workspace probe");
  }

  await assertRealDirectoryChain(workspacePath, standardRootPath);
  const [workspaceRealPath, standardRootRealPath, requestedParentRealPath] = await Promise.all([
    realpath(workspacePath),
    realpath(standardRootPath),
    realpath(dirname(requestedPath))
  ]);
  if (!isWithin(workspaceRealPath, standardRootRealPath) ||
      standardRootRealPath === workspaceRealPath ||
      requestedParentRealPath !== standardRootRealPath) {
    throw new Error("new app path must stay in the physical standard_root directory");
  }

  try {
    const targetStats = await lstat(requestedPath);
    if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
      throw new Error("an existing new app target must be a real directory");
    }
    const targetRealPath = await realpath(requestedPath);
    if (!isDirectChild(standardRootRealPath, targetRealPath)) {
      throw new Error("existing new app target must stay directly under standard_root");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return requestedPath;
}

async function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already have exited.
        }
      }
      return;
    }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        process.kill(-child.pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    return;
  }

  await new Promise((resolveKill) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolveKill();
    };
    const fallback = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
      finish();
    };
    killer.once("error", fallback);
    killer.once("close", (code) => {
      if (code !== 0) {
        fallback();
        return;
      }
      finish();
    });
  });
}

export function executeProcessTree(executable, args, options) {
  if (options.signal?.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let bufferedBytes = 0;
    let terminationReason;
    let processError;
    let killPromise = Promise.resolve();
    let settled = false;

    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      killPromise = killProcessTree(child);
    };
    const onAbort = () => terminate("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timeout = options.timeoutMs > 0
      ? setTimeout(() => terminate("timed out"), options.timeoutMs)
      : undefined;
    timeout?.unref();

    const capture = (chunks) => (chunk) => {
      if (terminationReason === "output limit exceeded") return;
      bufferedBytes += chunk.length;
      if (bufferedBytes > maxBuffer) {
        terminate("output limit exceeded");
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", capture(stdoutChunks));
    child.stderr.on("data", capture(stderrChunks));
    child.once("error", (error) => {
      processError = error;
    });
    child.once("close", async (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      await killPromise;

      if (terminationReason === "aborted") {
        rejectProcess(abortError());
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const capturedStderr = Buffer.concat(stderrChunks).toString("utf8");
      const diagnostic = terminationReason
        ? `APEXlang process ${terminationReason}.`
        : processError instanceof Error
          ? processError.message
          : "";
      const stderr = [capturedStderr.trimEnd(), diagnostic].filter(Boolean).join("\n");
      resolveProcess({
        ok: code === 0 && !terminationReason && !processError,
        code: Number.isInteger(code) && !terminationReason ? code : 1,
        stdout,
        stderr
      });
    });
  });
}

function invoke(command, options) {
  return executeProcessTree(process.execPath, [command.scriptPath, ...command.args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      APEXLANG_OUTPUT_ROOT: options.outputRoot,
      PYTHONDONTWRITEBYTECODE: "1"
    },
    maxBuffer: DEFAULT_MAX_BUFFER,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
}

async function enforceMaterializationGate(input, result, options) {
  if (!result.ok || input.action !== "new_app_materialize") {
    return result;
  }
  let resolutionPayload;
  try {
    resolutionPayload = JSON.parse(result.stdout);
  } catch {
    return {
      ...result,
      ok: false,
      code: 1,
      stderr: "Missing Inputs: workspace probe did not return a valid context-resolution payload."
    };
  }

  const appContext = resolutionPayload.app_context ?? {};
  const dbContext = resolutionPayload.db_context ?? {};
  const suggestedAppPath = String(appContext.suggested_app_path ?? "").trim();
  const standardRoot = String(appContext.standard_root ?? "").trim();
  const requestedAppPath = String(input.app_path ?? "").trim();
  const contextIsAuthoritative = Boolean(resolutionPayload.status === "resolved" &&
    resolutionPayload.authoritative_offline_context === true &&
    appContext.status === "create_new_allowed" &&
    appContext.standard_root_present === true &&
    String(dbContext.db_connection_name ?? "").trim() === input.db_connection_name &&
    String(dbContext.workspace?.name ?? "").trim().toUpperCase() ===
      String(input.workspace_name ?? "").toUpperCase() &&
    suggestedAppPath &&
    standardRoot);
  let pathIsSafe = false;
  if (contextIsAuthoritative) {
    try {
      await validateMaterializationPaths({
        cwd: options.cwd,
        standardRoot,
        requested: requestedAppPath,
        suggested: suggestedAppPath
      });
      pathIsSafe = true;
    } catch {
      pathIsSafe = false;
    }
  }

  if (!contextIsAuthoritative || !pathIsSafe) {
    return {
      ...result,
      ok: false,
      code: 1,
      stderr: [
        "Missing Inputs: new app materialization is allowed only when workspace probe reports authoritative offline context and app_context.status=create_new_allowed.",
        suggestedAppPath
          ? `Use the exact suggested_app_path: ${suggestedAppPath}`
          : "The probe did not produce a suggested_app_path. Add authoritative model/schema metadata plus an app alias, target path, or title hint."
      ].join("\n")
    };
  }
  return result;
}

async function runCommand(input, command, options) {
  input = { ...input };
  for (const key of ["app_path", "db_connection_name", "workspace_name"]) {
    if (typeof input[key] === "string") input[key] = input[key].trim();
  }
  if (typeof input.app_path === "string" && input.app_path.trim()) {
    const appPath = await assertProjectAppPath(input.app_path.trim(), options.cwd);
    await assertSymlinkFreeTree(appPath, {
      rejectHardlinks: input.action === "local_validate" && input.fix_vocab === true
    });
  }
  if (input.action === "workspace_probe" || command.prelude.length > 0) {
    await assertWorkspaceProbeCannotFollowSymlinks(options.cwd);
  }
  await assertDeploymentWorkspace(input, options.cwd);
  const preludeResults = [];
  for (const preludeCommand of command.prelude) {
    const processResult = await invoke(preludeCommand, options);
    const result = await enforceMaterializationGate(input, processResult, options);
    preludeResults.push(result);
    if (!result.ok) {
      return {
        ...result,
        action: input.action,
        command,
        outputRoot: options.outputRoot,
        preludeResults
      };
    }
  }

  const result = await invoke(command, options);
  return {
    ...result,
    action: input.action,
    command,
    outputRoot: options.outputRoot,
    preludeResults
  };
}

export function runApexlang(input, options) {
  return runCommand(input, buildApexlangCommand(input), options);
}

export function runApexlangImport(input, options, importOptions = {}) {
  return runCommand(input, buildApexlangImportCommand(input, importOptions), options);
}

export function runApexlangCreateNewProof(input, options) {
  return runCommand(
    input,
    buildApexlangImportCommand(input, {
      targetResolutionMode: "create-new",
      createNewConfirmed: false
    }),
    options
  );
}
