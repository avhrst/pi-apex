import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

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
const runtimeRoundtripPath = resolve(moduleDirectory, "apexlang-runtime-roundtrip.mjs");
const sqlclPtyProxyPath = resolve(moduleDirectory, "apexlang-sqlcl-pty.py");
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_$#.-]{0,127}$/;
const COMPONENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const SQLCL_WARNING_HEADER_PATTERN = /^APEXlang Compile Warnings:\s*$/gim;
const SQLCL_IMPORT_TARGET_PATTERN = /^Importing application ID:[^\S\r\n]*(\d+)[^\S\r\n]+into workspace:[^\S\r\n]*([^\r\n]*\S)[^\S\r\n]*$/gm;
const SQLCL_IMPORT_SUCCESS_PATTERN = /^Import successful\.[^\S\r\n]*$/gm;
const SQLCL_HARD_FAILURE_PATTERNS = Object.freeze([
  /APEXlang (?:Compile|Import) Errors:/i,
  /(?:^|\s)(?:ORA|SP2|PLS)-\d+/im,
  /(?:^|\s)(?:TNS|DPI)-\d+/im,
  /\b(?:Validation|Import) failed\b/i,
  /\bFATAL(?:!|:|\s|$)/i,
  /\bERROR!(?:\s|$)/i,
  /\[ERROR\]/i,
  /(?:^|[\r\n])\s*(?:SQL>\s*)?ERROR(?:\s*:|\s+)/i,
  /Exception in thread/i,
  /\b(?:SQLRecoverableException|SQLException)\b/i,
  /\bI\/?O Error\b/i,
  /\bConnection failed\b/i,
  /\bconnection (?:refused|reset|closed|timed out)\b/i,
  /\b(?:could not|unable to|failed to)\s+(?:connect|open|read|write|find|import|validate)\b/i,
  /\b(?:permission|access) denied\b/i,
  /\bnot connected\b/i,
  /invalid username\/password/i,
  /(?:enter|provide).*password/i,
  /\b(?:EPERM|ENOENT)\b/,
  /(?:unknown|unrecognized) command/i,
  /No such file or directory/i,
  /Could not find file or directory/i,
  /APEXlang process (?:timed out|output limit exceeded)/i
]);

const COMPATIBLE_VALIDATION_BLOCKING_REASONS = Object.freeze(new Set([
  "Live APEX validation did not pass or did not produce pass evidence.",
  "problems.json contains unresolved validation problems."
]));

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

function normalizeApexlangInput(input) {
  const normalized = { ...input };
  for (const key of ["app_path", "db_connection_name", "workspace_name"]) {
    if (typeof normalized[key] === "string") normalized[key] = normalized[key].trim();
  }
  return normalized;
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
  addFlag(args, "--supporting-objects", input.supporting_objects);
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
  return {
    scriptPath: runtimeRoundtripPath,
    args,
    prelude: [{ scriptPath: apexctlPath, args: probeArgs }]
  };
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

function runtimeActionUsesDeployment(input) {
  return Boolean(input.app_path) &&
    ["runtime_validate", "runtime_preflight", "runtime_doctor"].includes(input.action);
}

function workspaceName(value) {
  return String(value ?? "").trim();
}

function workspaceNamesMatch(left, right) {
  return left.toUpperCase() === right.toUpperCase();
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])])
  );
}

function canonicalDeploymentBytes(contents) {
  let deployment;
  try {
    deployment = JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Cannot digest invalid deployments/default.json: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
    throw new Error("Cannot digest deployments/default.json unless it contains a JSON object");
  }

  // prepareRuntimeApp may inject this run-scoped field and reformat the JSON. The
  // explicit workspace input is checked separately, so omit only that injected
  // name while retaining every other deployment property in the content digest.
  if (deployment.workspace && typeof deployment.workspace === "object" &&
      !Array.isArray(deployment.workspace)) {
    const workspace = { ...deployment.workspace };
    delete workspace.name;
    if (Object.keys(workspace).length === 0) {
      delete deployment.workspace;
    } else {
      deployment.workspace = workspace;
    }
  }
  return Buffer.from(JSON.stringify(stableJsonValue(deployment)), "utf8");
}

export async function computeApexlangAppDigest(appPath) {
  const root = resolve(appPath);
  const rootStats = await lstat(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error("APEXlang app digest requires a real application directory");
  }

  const hash = createHash("sha256");
  hash.update("pi-apexlang-app-tree-v1\0");

  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const entryPath = resolve(directory, entry.name);
      const relativePath = relative(root, entryPath).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        throw new Error(`APEXlang app digest refuses symbolic links: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`APEXlang app digest refuses non-regular files: ${entryPath}`);
      }
      const rawContents = await readFile(entryPath);
      const contents = relativePath === "deployments/default.json"
        ? canonicalDeploymentBytes(rawContents)
        : rawContents;
      hash.update(`file\0${relativePath}\0${contents.length}\0`);
      hash.update(contents);
      hash.update("\0");
    }
  }

  await walk(root);
  return hash.digest("hex");
}

function requireAppDigest(value, label = "expectedAppDigest") {
  const digest = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${label} must be a 64-character SHA-256 app digest`);
  }
  return digest;
}

function commandWithAppPath(command, appPath) {
  const args = [...command.args];
  const appPathIndex = args.indexOf("--app-path");
  if (appPathIndex >= 0) {
    args[appPathIndex + 1] = appPath;
  }
  return { ...command, args };
}

async function clearStaleRuntimeEvidence(command, outputRoot) {
  if (command.args[0] !== "runtime") return;
  if (command.args[1] === "validate") {
    await Promise.all([
      rm(resolve(outputRoot, "logs/validation"), { recursive: true, force: true }),
      rm(resolve(outputRoot, "logs/compat/sqlcl-warning-policy-validation.json"), { force: true })
    ]);
    return;
  }
  if (command.args[1] === "roundtrip") {
    await Promise.all([
      rm(resolve(outputRoot, "logs/runtime-run.json"), { force: true }),
      rm(resolve(outputRoot, "logs/runtime-run.log"), { force: true }),
      rm(resolve(outputRoot, "logs/compat/sqlcl-warning-policy-import.json"), { force: true }),
      rm(resolve(outputRoot, "logs/compat/sqlcl-warning-policy-import-failure.json"), { force: true }),
      rm(resolve(outputRoot, "logs/compat/sqlcl-warning-policy-import.log"), { force: true })
    ]);
  }
}

export async function prepareRuntimeApp(input, cwd, outputRoot, prepareOptions = {}) {
  if (!runtimeActionUsesDeployment(input)) {
    return { appPath: input.app_path ? resolve(cwd, input.app_path) : undefined, staged: false };
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
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
    throw new Error("deployments/default.json must contain a JSON object");
  }

  const topLevelWorkspace = workspaceName(deployment?.workspace?.name);
  const exportedWorkspace = workspaceName(deployment?.app?.workspace?.name);
  const requestedWorkspace = workspaceName(input.workspace_name);
  if (!requestedWorkspace) {
    throw new Error(`workspace_name is required for ${input.action}`);
  }
  if (topLevelWorkspace && exportedWorkspace &&
      !workspaceNamesMatch(topLevelWorkspace, exportedWorkspace)) {
    throw new Error(
      `deployments/default.json contains conflicting workspace names: ${topLevelWorkspace} and ${exportedWorkspace}`
    );
  }

  const declaredWorkspace = topLevelWorkspace || exportedWorkspace;
  if (declaredWorkspace === "__REQUIRED_WORKSPACE_NAME__") {
    throw new Error("deployments/default.json must declare the exact destination workspace.name");
  }
  if (declaredWorkspace && !workspaceNamesMatch(declaredWorkspace, requestedWorkspace)) {
    throw new Error(
      `workspace_name ${requestedWorkspace} does not match deployments/default.json workspace.name ${declaredWorkspace}`
    );
  }

  if (topLevelWorkspace && prepareOptions.forceStage !== true) {
    return { appPath, staged: false, workspaceSource: "workspace.name" };
  }

  const stageKey = createHash("sha256")
    .update(`${appPath}\0${requestedWorkspace.toUpperCase()}`)
    .digest("hex")
    .slice(0, 16);
  const stagedAppPath = resolve(outputRoot, "runtime-apps", stageKey);
  if (isWithin(appPath, stagedAppPath)) {
    throw new Error("APEXLANG_OUTPUT_ROOT must not be inside the application tree");
  }
  const [appRealPath, outputRealAncestor] = await Promise.all([
    realpath(appPath),
    nearestExistingRealPath(resolve(outputRoot))
  ]);
  if (isWithin(appRealPath, outputRealAncestor)) {
    throw new Error("APEXLANG_OUTPUT_ROOT must not resolve inside the application tree");
  }
  await rm(stagedAppPath, { recursive: true, force: true });
  await mkdir(dirname(stagedAppPath), { recursive: true });
  await cp(appPath, stagedAppPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true
  });
  deployment.workspace = {
    ...(deployment.workspace && typeof deployment.workspace === "object"
      ? deployment.workspace
      : {}),
    name: requestedWorkspace
  };
  await writeFile(
    resolve(stagedAppPath, "deployments/default.json"),
    `${JSON.stringify(deployment, null, 2)}\n`,
    "utf8"
  );
  return {
    appPath: stagedAppPath,
    staged: true,
    workspaceSource: topLevelWorkspace
      ? "workspace.name"
      : exportedWorkspace
        ? "app.workspace.name"
        : "explicit_workspace_name"
  };
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

async function killPosixProcessGroup(groupId) {
  try {
    process.kill(-groupId, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-groupId, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

async function killPtyProcessTree(child, ptyProcessGroupPromise) {
  if (!child.pid || process.platform === "win32") {
    await killProcessTree(child);
    return;
  }

  // The helper publishes its forkpty child PGID on a private pipe before the
  // adapter sends any SQLcl command.  Kill that group directly; never rely on
  // the proxy being scheduled in time to forward a signal.
  try {
    child.kill("SIGCONT");
  } catch {
    // The proxy may already have exited.
  }
  const ptyProcessGroupId = await ptyProcessGroupPromise;
  if (Number.isInteger(ptyProcessGroupId) && ptyProcessGroupId > 1) {
    await killPosixProcessGroup(ptyProcessGroupId);
  }
  // When no valid PGID was published, the helper contract guarantees that it
  // killed/reaped any forkpty child before closing the control pipe.
  await killProcessTree(child);
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
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
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

    if (options.input !== undefined) {
      child.stdin.on("error", (error) => {
        if (error?.code !== "EPIPE") processError = error;
      });
      child.stdin.end(String(options.input));
    }

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

export function executeSqlclValidationThenImport(executable, args, options) {
  if (options.signal?.aborted) {
    return Promise.reject(abortError());
  }
  if (process.platform === "win32") {
    return Promise.reject(new Error(
      "Warning-compatible import requires an ordered merged SQLcl output stream and is unavailable on Windows"
    ));
  }

  const markerToken = randomUUID().replaceAll("-", "").toUpperCase();
  const sessionReadyMarker = `__PI_APEXLANG_SESSION_READY_${markerToken}__`;
  const validateDoneMarker = `__PI_APEXLANG_VALIDATE_DONE_${markerToken}__`;
  const importDoneMarker = `__PI_APEXLANG_IMPORT_DONE_${markerToken}__`;

  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn("python3", [
      sqlclPtyProxyPath,
      executable,
      ...args
    ], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: {
        ...options.env,
        TERM: "dumb",
        COLUMNS: "120",
        LINES: "40",
        PYTHONDONTWRITEBYTECODE: "1"
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
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
    let sessionSetupTimer;
    let sessionSetupSent = false;
    let sessionReady = false;
    let validationSent = false;
    let validationStartIndex = -1;
    let validationDecided = false;
    let validationAccepted = false;
    let validationEvidence = { accepted: false, reason: "validation_marker_missing" };
    let importSent = false;
    let ptyProcessGroupReady = false;
    let ptyControlBuffer = "";
    let ptyControlSettled = false;
    let resolvePtyProcessGroup;
    const ptyProcessGroupPromise = new Promise((resolveGroup) => {
      resolvePtyProcessGroup = resolveGroup;
    });
    const settlePtyProcessGroup = (groupId) => {
      if (ptyControlSettled) return;
      ptyControlSettled = true;
      if (Number.isInteger(groupId) && groupId > 1 && groupId !== child.pid) {
        ptyProcessGroupReady = true;
        resolvePtyProcessGroup(groupId);
        return;
      }
      resolvePtyProcessGroup(undefined);
    };

    const terminate = (reason) => {
      if (terminationReason) return;
      terminationReason = reason;
      killPromise = killPtyProcessTree(child, ptyProcessGroupPromise);
    };
    const onAbort = () => terminate("aborted");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timeout = options.timeoutMs > 0
      ? setTimeout(() => terminate("timed out"), options.timeoutMs)
      : undefined;
    timeout?.unref();

    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") processError = error;
    });

    const endSqlclInput = (commands) => {
      if (terminationReason || child.stdin.destroyed) return;
      child.stdin.end([...commands, ""].join("\n"));
    };

    const scheduleSessionSetup = () => {
      if (!ptyProcessGroupReady || sessionSetupSent || validationDecided ||
          terminationReason || child.stdin.destroyed) {
        return;
      }
      if (sessionSetupTimer) clearTimeout(sessionSetupTimer);
      sessionSetupTimer = setTimeout(() => {
        sessionSetupTimer = undefined;
        if (!ptyProcessGroupReady || sessionSetupSent || validationDecided ||
            terminationReason || child.stdin.destroyed) {
          return;
        }
        const startupOutput = Buffer.concat(stdoutChunks).toString("utf8");
        if (containsSqlclHardFailure(startupOutput)) {
          validationDecided = true;
          validationEvidence = { accepted: false, reason: "sqlcl_session_start_failed" };
          endSqlclInput(["exit failure rollback"]);
          return;
        }
        sessionSetupSent = true;
        child.stdin.write([
          'set sqlprompt ""',
          `prompt ${sessionReadyMarker}`,
          ""
        ].join("\n"));
      }, 250);
    };

    const inspectSqlclOutput = () => {
      if (!ptyProcessGroupReady || terminationReason || child.stdin.destroyed) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const normalizedStdout = normalizeInteractiveSqlclOutput(stdout);

      if (!sessionSetupSent) {
        if (containsSqlclHardFailure(normalizedStdout)) {
          validationDecided = true;
          validationEvidence = { accepted: false, reason: "sqlcl_session_start_failed" };
          endSqlclInput(["exit failure rollback"]);
          return;
        }
        scheduleSessionSetup();
        return;
      }

      const readyMarkerSpan = exactSqlclMarkerSpan(
        normalizedStdout,
        sessionReadyMarker,
        { allowPromptPrefix: true }
      );
      if (!sessionReady) {
        if (!readyMarkerSpan) return;
        const startupOutput = normalizedStdout.slice(0, readyMarkerSpan.start);
        if (containsSqlclHardFailure(startupOutput)) {
          validationDecided = true;
          validationEvidence = { accepted: false, reason: "sqlcl_session_start_failed" };
          endSqlclInput(["exit failure rollback"]);
          return;
        }
        sessionReady = true;
        validationSent = true;
        validationStartIndex = readyMarkerSpan.end;
        child.stdin.write([
          "whenever sqlerror exit failure rollback",
          "whenever oserror exit failure rollback",
          options.validateCommand,
          `prompt ${validateDoneMarker}`,
          ""
        ].join("\n"));
        return;
      }

      if (validationDecided) return;
      const validateMarkerSpan = exactSqlclMarkerSpan(normalizedStdout, validateDoneMarker);
      if (!validateMarkerSpan) return;
      validationDecided = true;
      const validationOutput = normalizedStdout.slice(
        validationStartIndex,
        validateMarkerSpan.start
      );
      const currentStderr = Buffer.concat(stderrChunks).toString("utf8");
      validationEvidence = classifyWarningCompatibleSqlclValidation(
        [validationOutput, currentStderr].filter(Boolean).join("\n")
      );
      validationAccepted = validationEvidence.accepted;
      if (!validationAccepted) {
        endSqlclInput(["exit failure rollback"]);
        return;
      }
      importSent = true;
      endSqlclInput([
        options.importCommand,
        `prompt ${importDoneMarker}`,
        "exit success commit"
      ]);
    };

    const capture = (chunks, inspectOutput = false) => (chunk) => {
      if (terminationReason === "output limit exceeded") return;
      bufferedBytes += chunk.length;
      if (bufferedBytes > maxBuffer) {
        terminate("output limit exceeded");
        return;
      }
      chunks.push(chunk);
      if (inspectOutput) inspectSqlclOutput();
    };
    const ptyControlStream = child.stdio[3];
    ptyControlStream.setEncoding("utf8");
    ptyControlStream.on("data", (chunk) => {
      if (ptyControlSettled) return;
      ptyControlBuffer += chunk;
      if (ptyControlBuffer.length > 32) {
        processError = new Error("PTY proxy returned invalid process-group evidence");
        settlePtyProcessGroup(undefined);
        terminate("PTY control channel failed");
      }
    });
    ptyControlStream.once("error", (error) => {
      processError = error;
      settlePtyProcessGroup(undefined);
      terminate("PTY control channel failed");
    });
    ptyControlStream.once("end", () => {
      if (ptyControlSettled) return;
      const match = /^([1-9]\d{0,9})\n$/.exec(ptyControlBuffer);
      const groupId = match ? Number(match[1]) : undefined;
      if (!Number.isSafeInteger(groupId) || groupId <= 1 || groupId === child.pid) {
        processError = new Error("PTY proxy returned invalid process-group evidence");
        settlePtyProcessGroup(undefined);
        terminate("PTY control channel failed");
        return;
      }
      settlePtyProcessGroup(groupId);
      // Process-group proof authorizes safe cleanup, but it is not a SQLcl
      // readiness signal.  Sending input before SQLcl emits terminal output
      // can be discarded by its startup terminal initialization.
      if (stdoutChunks.length > 0) inspectSqlclOutput();
    });
    child.stdout.on("data", capture(stdoutChunks, true));
    child.stderr.on("data", capture(stderrChunks));
    child.once("error", (error) => {
      processError = error;
    });
    child.once("close", async (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (sessionSetupTimer) clearTimeout(sessionSetupTimer);
      options.signal?.removeEventListener("abort", onAbort);
      await killPromise;

      if (terminationReason === "aborted") {
        rejectProcess(abortError());
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const normalizedStdout = normalizeInteractiveSqlclOutput(stdout);
      const capturedStderr = Buffer.concat(stderrChunks).toString("utf8");
      const readyMarkerSpan = exactSqlclMarkerSpan(
        normalizedStdout,
        sessionReadyMarker,
        { allowPromptPrefix: true }
      );
      const validateMarkerSpan = exactSqlclMarkerSpan(normalizedStdout, validateDoneMarker);
      const importMarkerSpan = exactSqlclMarkerSpan(normalizedStdout, importDoneMarker);
      const validationOutput = validateMarkerSpan && validationStartIndex >= 0
        ? normalizedStdout.slice(validationStartIndex, validateMarkerSpan.start)
        : normalizedStdout;
      const importOutput = validateMarkerSpan
        ? normalizedStdout.slice(
            validateMarkerSpan.end,
            importMarkerSpan?.start
          )
        : "";
      const diagnostic = terminationReason
        ? `APEXlang process ${terminationReason}.`
        : processError instanceof Error
          ? processError.message
          : "";
      const stderr = [capturedStderr.trimEnd(), diagnostic].filter(Boolean).join("\n");
      const markersAreOrdered = Boolean(
        readyMarkerSpan &&
        validateMarkerSpan &&
        importMarkerSpan &&
        readyMarkerSpan.start < validateMarkerSpan.start &&
        validateMarkerSpan.start < importMarkerSpan.start
      );
      const importCompleted = importSent && markersAreOrdered;
      const hardFailureDetected = containsSqlclHardFailure(
        [stdout, stderr].filter(Boolean).join("\n")
      );
      resolveProcess({
        ok: code === 0 && !terminationReason && !processError && ptyProcessGroupReady &&
          validationAccepted && importCompleted && !hardFailureDetected,
        code: Number.isInteger(code) && !terminationReason ? code : 1,
        stdout,
        stderr,
        validationAccepted,
        validationEvidence,
        sessionReady,
        validationSent,
        importSent,
        importCompleted,
        hardFailureDetected,
        validationOutput,
        importOutput,
        orderedMergedOutput: true,
        ptyBacked: true,
        ptyProcessGroupReady
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

function parseJsonRecord(value) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function countMatches(value, pattern) {
  return [...String(value).matchAll(pattern)].length;
}

function normalizeInteractiveSqlclOutput(output) {
  return stripVTControlCharacters(String(output))
    .replace(/\r+\n/g, "\n")
    .replace(/\r/g, "\n");
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactSqlclMarkerSpan(output, marker, options = {}) {
  const normalizedOutput = normalizeInteractiveSqlclOutput(output);
  const escapedMarker = escapeRegularExpression(marker);
  const promptPrefix = options.allowPromptPrefix === true
    ? "[^\\r\\n]{0,256}"
    : "(?:SQL>[^\\S\\r\\n]*)?";
  const match = new RegExp(
    `(^|\\n)${promptPrefix}${escapedMarker}(?=\\n|$)`
  ).exec(normalizedOutput);
  if (!match) return undefined;
  return {
    start: match.index + match[1].length,
    end: match.index + match[0].length
  };
}

function transcriptSection(transcript, label) {
  const header = `## ${label}`;
  const lines = String(transcript).split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line === header);
  if (headerIndex < 0) return "";
  const nextHeaderIndex = lines.findIndex(
    (line, index) => index > headerIndex && line.startsWith("## ")
  );
  return lines.slice(headerIndex + 1, nextHeaderIndex < 0 ? undefined : nextHeaderIndex).join("\n");
}

function containsSqlclHardFailure(output) {
  const normalizedOutput = stripVTControlCharacters(String(output));
  return SQLCL_HARD_FAILURE_PATTERNS.some((pattern) => pattern.test(normalizedOutput));
}

export function classifyWarningCompatibleSqlclValidation(output) {
  const warningCount = countMatches(output, SQLCL_WARNING_HEADER_PATTERN);
  const validationSuccessCount = countMatches(output, /^Validation successful\.\s*$/gim);
  if (warningCount !== 1 || validationSuccessCount !== 1) {
    return {
      accepted: false,
      reason: "warning_success_markers_not_exact",
      warningCount,
      validationSuccessCount
    };
  }
  if (containsSqlclHardFailure(output)) {
    return {
      accepted: false,
      reason: "hard_failure_marker_present",
      warningCount,
      validationSuccessCount
    };
  }
  return {
    accepted: true,
    reason: "sqlcl_explicit_validation_success_with_compile_warnings",
    warningCount,
    validationSuccessCount,
    outputSha256: createHash("sha256").update(String(output)).digest("hex")
  };
}

export function classifyWarningOnlyRuntimePayload(
  payload,
  transcript,
  expectedImportIntent = "validate-only"
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { accepted: false, reason: "missing_runtime_payload" };
  }
  if (payload.failure_class !== "live_validate_failed" || payload.blocking_reason !== "live_validate_failed") {
    return { accepted: false, reason: "unexpected_failure_class" };
  }
  if (payload.import_intent_choice !== expectedImportIntent) {
    return { accepted: false, reason: "unexpected_import_intent" };
  }
  const phases = Array.isArray(payload.phase_reports) ? payload.phase_reports : [];
  const livePhaseIndex = phases.findIndex((phase) => phase?.phase === "live_validate");
  if (livePhaseIndex < 0) {
    return { accepted: false, reason: "missing_live_validate_phase" };
  }
  const livePhase = phases[livePhaseIndex];
  if (livePhase?.status !== "fail" || livePhase?.failure_class !== "live_validate_failed") {
    return { accepted: false, reason: "unexpected_live_validate_phase" };
  }
  if (phases.slice(0, livePhaseIndex).some((phase) => phase?.status !== "pass")) {
    return { accepted: false, reason: "earlier_phase_did_not_pass" };
  }

  const attemptLabel = "roundtrip_sql_name_alias";
  const attempt = transcriptSection(transcript, attemptLabel);
  if (!attempt) {
    return { accepted: false, reason: "preferred_sqlcl_attempt_missing" };
  }
  const sqlclEvidence = classifyWarningCompatibleSqlclValidation(attempt);
  if (!sqlclEvidence.accepted) return sqlclEvidence;
  return {
    accepted: true,
    reason: "sqlcl_explicit_validation_success_with_compile_warnings",
    attemptLabel,
    warningCount: sqlclEvidence.warningCount,
    validationSuccessCount: sqlclEvidence.validationSuccessCount,
    attemptSha256: createHash("sha256").update(attempt).digest("hex")
  };
}

async function resolveOutputArtifact(outputRoot, candidate, label) {
  const outputPath = resolve(outputRoot);
  const artifactPath = resolve(String(candidate ?? ""));
  if (!candidate || !isWithin(outputPath, artifactPath)) {
    throw new Error(`${label} must stay inside APEXLANG_OUTPUT_ROOT`);
  }
  const [outputRealPath, artifactRealPath] = await Promise.all([
    realpath(outputPath),
    realpath(artifactPath)
  ]);
  if (!isWithin(outputRealPath, artifactRealPath)) {
    throw new Error(`${label} must not escape APEXLANG_OUTPUT_ROOT through a symbolic link`);
  }
  return artifactRealPath;
}

async function writeCompatibilityRecord(outputRoot, filename, record) {
  const compatibilityDirectory = resolve(outputRoot, "logs/compat");
  await mkdir(compatibilityDirectory, { recursive: true });
  const recordPath = resolve(compatibilityDirectory, filename);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return recordPath;
}

export async function proveWarningOnlyProblemsAreDiagnostics(payload, result) {
  const blockingReasons = Array.isArray(payload.blocking_reasons)
    ? payload.blocking_reasons.map(String)
    : [];
  const hasProblemsBlocker = blockingReasons.includes(
    "problems.json contains unresolved validation problems."
  );
  const exactCount = (value) => {
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    }
    if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value.trim())) {
      const parsed = Number(value.trim());
      return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    return undefined;
  };
  const outerProblemCount = exactCount(payload.problem_count);
  const outerUnresolvedCount = exactCount(payload.unresolved_count);
  if (outerProblemCount === undefined || outerUnresolvedCount === undefined) {
    return { accepted: false, reason: "runtime_problem_counts_are_invalid" };
  }
  if (outerProblemCount === 0 && outerUnresolvedCount === 0) {
    if (hasProblemsBlocker) {
      return { accepted: false, reason: "problem_blocker_conflicts_with_zero_counts" };
    }
    const zeroProblemsCandidate = payload.artifacts?.problems_path;
    if (!zeroProblemsCandidate) {
      return { accepted: false, reason: "problems_artifact_missing_for_zero_counts" };
    }
    const zeroProblemsPath = await resolveOutputArtifact(
      result.outputRoot,
      zeroProblemsCandidate,
      "problems_path"
    );
    const rawZeroProblems = await readFile(zeroProblemsPath, "utf8");
    const zeroProblemsPayload = parseJsonRecord(rawZeroProblems);
    const zeroProblems = zeroProblemsPayload?.problems;
    if (!Array.isArray(zeroProblems) || zeroProblems.length !== 0 ||
        exactCount(zeroProblemsPayload?.problem_count) !== 0 ||
        exactCount(zeroProblemsPayload?.unresolved_count) !== 0) {
      return { accepted: false, reason: "zero_problem_counts_conflict_with_artifact" };
    }
    return {
      accepted: true,
      problemCount: 0,
      problemsPath: zeroProblemsPath,
      problemsSha256: createHash("sha256").update(rawZeroProblems).digest("hex")
    };
  }
  if (outerProblemCount === 0 || outerUnresolvedCount === 0) {
    return { accepted: false, reason: "runtime_problem_counts_are_inconsistent" };
  }
  const problemsPath = await resolveOutputArtifact(
    result.outputRoot,
    payload.artifacts?.problems_path,
    "problems_path"
  );
  const rawProblems = await readFile(problemsPath, "utf8");
  const problemsPayload = parseJsonRecord(rawProblems);
  const problems = Array.isArray(problemsPayload?.problems) ? problemsPayload.problems : [];
  const declaredProblemCount = exactCount(problemsPayload?.problem_count);
  const declaredUnresolvedCount = exactCount(problemsPayload?.unresolved_count);
  const warningsOnly = problems.length > 0 && problems.every((problem) =>
    problem?.source === "apex_validate" &&
    String(problem?.severity ?? "").toLowerCase() === "warning" &&
    /^Warning:\s/.test(String(problem?.message ?? "")) &&
    !containsSqlclHardFailure(problem?.message)
  );
  if (!warningsOnly ||
      declaredProblemCount !== problems.length ||
      declaredUnresolvedCount !== problems.length ||
      outerProblemCount !== problems.length ||
      outerUnresolvedCount !== problems.length) {
    return { accepted: false, reason: "problems_artifact_is_not_warning_only" };
  }
  return {
    accepted: true,
    problemCount: problems.length,
    problemsPath,
    problemsSha256: createHash("sha256").update(rawProblems).digest("hex")
  };
}

async function proveWarningOnlyValidationIdentity(
  input,
  result,
  payload,
  roundtripPayload,
  roundtripReportPath,
  transcriptPath
) {
  const runtimeAppPathValue = result.runtimeApp?.appPath;
  if (!runtimeAppPathValue) throw new Error("runtime app path is missing");
  const runtimeAppPath = await realpath(resolve(runtimeAppPathValue));
  for (const candidate of [
    roundtripPayload.final_app_path,
    roundtripPayload.temp_app_path,
    roundtripPayload.frozen_preflight_facts?.app_path
  ]) {
    if (!candidate || await realpath(resolve(candidate)) !== runtimeAppPath) {
      throw new Error("runtime evidence app path does not match the current runtime app");
    }
  }
  if (roundtripPayload.report_path &&
      await realpath(resolve(roundtripPayload.report_path)) !== roundtripReportPath) {
    throw new Error("runtime report path does not match the current artifact");
  }
  if (roundtripPayload.transcript_path &&
      await realpath(resolve(roundtripPayload.transcript_path)) !== transcriptPath) {
    throw new Error("runtime transcript path does not match the current artifact");
  }
  const outerTimestamp = Date.parse(String(payload.timestamp ?? ""));
  const roundtripTimestamp = Date.parse(String(roundtripPayload.timestamp ?? ""));
  if (!Number.isFinite(outerTimestamp) || !Number.isFinite(roundtripTimestamp) ||
      Math.abs(outerTimestamp - roundtripTimestamp) > 5_000) {
    throw new Error("runtime artifacts do not share the same validation timestamp");
  }
  const sourceId = Number(roundtripPayload.source_application_id);
  const frozen = roundtripPayload.frozen_preflight_facts;
  if (!Number.isInteger(sourceId) || sourceId <= 0 ||
      Number(frozen?.requested_application_id) !== sourceId ||
      frozen?.execution_mode_selected !== "path" ||
      frozen?.db_connection_name !== input.db_connection_name ||
      roundtripPayload.db_connection_name !== input.db_connection_name ||
      !sameName(frozen?.requested_application_alias, roundtripPayload.source_application_alias)) {
    throw new Error("runtime evidence source identity does not match frozen preflight facts");
  }
  const deployment = parseJsonRecord(
    await readFile(resolve(runtimeAppPath, "deployments/default.json"), "utf8")
  );
  const deploymentWorkspace = workspaceName(
    deployment?.workspace?.name ?? deployment?.app?.workspace?.name
  );
  if (Number(deployment?.app?.id) !== sourceId ||
      !workspaceNamesMatch(deploymentWorkspace, input.workspace_name)) {
    throw new Error("runtime evidence does not match staged deployment identity");
  }
  return {
    runtimeAppPath,
    sourceId,
    sourceAlias: roundtripPayload.source_application_alias,
    timestampDeltaMs: Math.abs(outerTimestamp - roundtripTimestamp)
  };
}

async function normalizeWarningOnlyValidation(input, result) {
  input = normalizeApexlangInput(input);
  if (result.ok || input.action !== "runtime_validate") return result;
  const payload = parseJsonRecord(result.stdout);
  const artifacts = payload?.artifacts;
  if (!artifacts || typeof artifacts !== "object") return result;

  let roundtripReportPath;
  let transcriptPath;
  try {
    [roundtripReportPath, transcriptPath] = await Promise.all([
      resolveOutputArtifact(
        result.outputRoot,
        artifacts.roundtrip_report_path,
        "roundtrip_report_path"
      ),
      resolveOutputArtifact(
        result.outputRoot,
        artifacts.validation_transcript_path,
        "validation_transcript_path"
      )
    ]);
  } catch {
    return result;
  }

  const [roundtripPayload, transcript] = await Promise.all([
    readFile(roundtripReportPath, "utf8").then(parseJsonRecord),
    readFile(transcriptPath, "utf8")
  ]);
  const evidence = classifyWarningOnlyRuntimePayload(roundtripPayload, transcript, "validate-only");
  if (!evidence.accepted) return result;
  if (roundtripPayload.db_connection_name !== input.db_connection_name) return result;
  const originalBlockingReasons = Array.isArray(payload.blocking_reasons)
    ? payload.blocking_reasons.map(String)
    : [];
  if (originalBlockingReasons.some(
    (reason) => !COMPATIBLE_VALIDATION_BLOCKING_REASONS.has(reason)
  )) {
    return result;
  }
  let identityEvidence;
  let problemEvidence;
  try {
    [identityEvidence, problemEvidence] = await Promise.all([
      proveWarningOnlyValidationIdentity(
        input,
        result,
        payload,
        roundtripPayload,
        roundtripReportPath,
        transcriptPath
      ),
      proveWarningOnlyProblemsAreDiagnostics(payload, result)
    ]);
  } catch {
    return result;
  }
  if (!problemEvidence.accepted) return result;
  const diagnosticReasons = originalBlockingReasons.filter(
    (reason) => reason !== "Live APEX validation did not pass or did not produce pass evidence."
  );

  const compatibilityRecord = {
    status: "accepted",
    policy: "sqlcl_explicit_validation_success_with_compile_warnings",
    timestamp: new Date().toISOString(),
    db_connection_name: input.db_connection_name,
    workspace_name: input.workspace_name,
    original_live_check_status: payload.live_check_status,
    original_validation_status: payload.validation_status,
    original_unresolved_count: payload.unresolved_count,
    original_blocking_reasons: originalBlockingReasons,
    diagnostic_reasons: diagnosticReasons,
    validation_identity: identityEvidence,
    warning_only_problems: problemEvidence,
    roundtrip_report_path: roundtripReportPath,
    transcript_path: transcriptPath,
    transcript_sha256: createHash("sha256").update(transcript).digest("hex"),
    ...evidence
  };
  delete compatibilityRecord.accepted;
  const compatibilityReportPath = await writeCompatibilityRecord(
    result.outputRoot,
    "sqlcl-warning-policy-validation.json",
    compatibilityRecord
  );
  const normalizedPayload = {
    ...payload,
    live_check_status: "pass",
    validation_status: "pass",
    warnings_as_errors: false,
    validation_sources: {
      ...(payload.validation_sources ?? {}),
      live_validator: {
        ...(payload.validation_sources?.live_validator ?? {}),
        status: "pass",
        policy: compatibilityRecord.policy,
        compatibility_report_path: compatibilityReportPath
      },
      ...(payload.validation_sources?.compiler_truth
        ? {
            compiler_truth: {
              ...payload.validation_sources.compiler_truth,
              gate_role: "diagnostic_after_live_pass"
            }
          }
        : {}),
      ...(payload.validation_sources?.vscode_problems
        ? {
            vscode_problems: {
              ...payload.validation_sources.vscode_problems,
              gate_role: "diagnostic_after_live_pass"
            }
          }
        : {})
    },
    blocking_reasons: [],
    diagnostic_reasons: diagnosticReasons,
    import_eligibility: "validate-only-passed-with-compile-warnings",
    compatibility_fallback: compatibilityRecord,
    notes: [
      ...(Array.isArray(payload.notes) ? payload.notes : []),
      "SQLcl returned an explicit Validation successful marker; compile warnings remain recorded as diagnostics."
    ]
  };
  return {
    ...result,
    ok: true,
    code: 0,
    stdout: `${JSON.stringify(normalizedPayload, null, 2)}\n`
  };
}

function sameName(left, right) {
  return String(left ?? "").trim().toUpperCase() === String(right ?? "").trim().toUpperCase();
}

export function validateUpdateExistingImportProof(payload, input, stagedAppPath) {
  if (payload.target_resolution_mode !== "update-existing" ||
      payload.target_resolution_status !== "resolved_existing_app" ||
      payload.direct_import_fallback_allowed !== true ||
      payload.canonical_mapping_status !== "resolved") {
    throw new Error("APEXlang compatibility import requires a resolved existing-app target");
  }
  const canonicalId = Number(payload.canonical_application_id);
  const candidateIds = Array.isArray(payload.candidate_ids)
    ? payload.candidate_ids.map(Number)
    : [];
  if (!Number.isInteger(canonicalId) || canonicalId <= 0 ||
      payload.candidate_count !== 1 ||
      candidateIds.length !== 1 ||
      candidateIds[0] !== canonicalId) {
    throw new Error("APEXlang compatibility import requires exactly one canonical application id");
  }
  if (!sameName(payload.canonical_application_alias, payload.source_application_alias) ||
      !payload.canonical_application_alias) {
    throw new Error("APEXlang compatibility import requires matching source and canonical aliases");
  }
  const sourceId = Number(payload.source_application_id);
  if (!Number.isInteger(sourceId) || sourceId <= 0 ||
      Number(payload.frozen_preflight_facts?.requested_application_id) !== sourceId ||
      !sameName(
        payload.frozen_preflight_facts?.requested_application_alias,
        payload.source_application_alias
      ) ||
      !sameName(
        payload.frozen_preflight_facts?.requested_application_alias,
        payload.canonical_application_alias
      )) {
    throw new Error("APEXlang compatibility import source identity does not match frozen preflight facts");
  }
  const workspaceId = String(payload.lookup_scope_workspaceid ?? "").trim();
  if (!/^\d+$/.test(workspaceId) || workspaceId !== String(payload.workspaceid ?? "").trim()) {
    throw new Error("APEXlang compatibility import requires one proven numeric workspace id");
  }
  if (!sameName(payload.lookup_scope_workspace_name, input.workspace_name) ||
      !sameName(payload.frozen_preflight_facts?.workspace_scope?.workspace_name, input.workspace_name) ||
      String(payload.frozen_preflight_facts?.workspace_scope?.workspace_id ?? "").trim() !== workspaceId) {
    throw new Error("APEXlang compatibility import workspace proof does not match workspace_name");
  }
  if (payload.db_connection_name !== input.db_connection_name ||
      payload.frozen_preflight_facts?.db_connection_name !== input.db_connection_name) {
    throw new Error("APEXlang compatibility import connection proof does not match db_connection_name");
  }
  if (payload.execution_mode_used !== "path" ||
      payload.frozen_preflight_facts?.execution_mode_selected !== "path" ||
      resolve(payload.final_app_path) !== resolve(stagedAppPath) ||
      resolve(payload.temp_app_path) !== resolve(stagedAppPath) ||
      resolve(payload.frozen_preflight_facts?.app_path ?? "") !== resolve(stagedAppPath)) {
    throw new Error("APEXlang compatibility import requires the proven staged PATH runtime app");
  }
  return {
    canonicalId,
    canonicalAlias: payload.canonical_application_alias,
    sourceId,
    sourceAlias: payload.source_application_alias,
    workspaceId,
    workspaceName: payload.lookup_scope_workspace_name
  };
}

export function buildWarningCompatibleImportCommands({ appPath, workspaceId, canonicalId }) {
  const safeAppPath = validatePath(assertPlainText(String(appPath), "app_path"), "app_path");
  if (!/^\d+$/.test(String(workspaceId)) || !Number.isInteger(canonicalId) || canonicalId <= 0) {
    throw new Error("A proven workspace id and canonical application id are required for import");
  }
  return {
    validateCommand: `apex validate -input "${safeAppPath}" -workspaceid ${workspaceId}`,
    importCommand: `apex import -input "${safeAppPath}" -workspaceid ${workspaceId} -id ${canonicalId}`
  };
}

export async function runWarningCompatibleImport(input, result, options, dependencies = {}) {
  input = normalizeApexlangInput(input);
  const payload = parseJsonRecord(result.stdout);
  if (!payload || !result.runtimeApp?.staged || !result.runtimeApp.appPath) return result;
  if (payload.transcript_path === undefined) return result;

  const transcriptPath = await resolveOutputArtifact(
    result.outputRoot,
    payload.transcript_path,
    "runtime transcript_path"
  );
  const transcript = await readFile(transcriptPath, "utf8");
  const evidence = classifyWarningOnlyRuntimePayload(
    payload,
    transcript,
    "validate-and-import"
  );
  if (!evidence.accepted) return result;

  const stagedProofPath = resolve(result.runtimeApp.appPath);
  const stagedAppPath = await realpath(stagedProofPath);
  const runtimeAppsPath = await realpath(resolve(result.outputRoot, "runtime-apps"));
  if (!isWithin(runtimeAppsPath, stagedAppPath)) {
    throw new Error("APEXlang compatibility import app must stay under APEXLANG_OUTPUT_ROOT/runtime-apps");
  }
  const proof = validateUpdateExistingImportProof(payload, input, stagedProofPath);
  const deploymentPath = resolve(stagedAppPath, "deployments/default.json");
  const deployment = parseJsonRecord(await readFile(deploymentPath, "utf8"));
  if (!deployment || !deployment.app || typeof deployment.app !== "object" || Array.isArray(deployment.app)) {
    throw new Error("Staged deployments/default.json must contain an app object before import");
  }
  const previousApplicationId = Number(deployment.app.id);
  if (!Number.isInteger(previousApplicationId) || previousApplicationId !== proof.sourceId) {
    throw new Error("Staged deployment application id does not match the frozen source identity");
  }
  const validatedAppDigest = requireAppDigest(result.appDigest, "validated appDigest");
  const currentAppDigest = await computeApexlangAppDigest(stagedAppPath);
  if (currentAppDigest !== validatedAppDigest) {
    throw new Error(
      "Staged APEXlang application changed after validation; revalidate before importing"
    );
  }
  deployment.app.id = proof.canonicalId;
  await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");

  const commands = buildWarningCompatibleImportCommands({
    appPath: stagedAppPath,
    workspaceId: proof.workspaceId,
    canonicalId: proof.canonicalId
  });
  const sessionRunner = dependencies.sessionRunner ?? executeSqlclValidationThenImport;
  const importResult = await sessionRunner("sql", ["-S", "-name", input.db_connection_name], {
    cwd: options.cwd,
    env: process.env,
    ...commands,
    maxBuffer: DEFAULT_MAX_BUFFER,
    signal: options.signal,
    timeoutMs: options.timeoutMs
  });
  const compatibilityDirectory = resolve(result.outputRoot, "logs/compat");
  await mkdir(compatibilityDirectory, { recursive: true });
  const importLogPath = resolve(compatibilityDirectory, "sqlcl-warning-policy-import.log");
  const fullSessionOutput = [importResult.stdout, importResult.stderr].filter(Boolean).join("\n");
  await writeFile(importLogPath, fullSessionOutput, "utf8");
  const validationOutput = [importResult.validationOutput, importResult.stderr]
    .filter(Boolean)
    .join("\n");
  const validationEvidence = classifyWarningCompatibleSqlclValidation(validationOutput);
  const hardFailureDetected = containsSqlclHardFailure(fullSessionOutput);
  const normalizedImportOutput = normalizeInteractiveSqlclOutput(
    importResult.importOutput ?? ""
  );
  const importedTargetMatches = [
    ...normalizedImportOutput.matchAll(SQLCL_IMPORT_TARGET_PATTERN)
  ];
  const importedTargets = importedTargetMatches.map((match) => ({
    applicationId: Number(match[1]),
    workspaceName: String(match[2]).trim()
  }));
  const importedIds = importedTargets.map((target) => target.applicationId);
  const importedWorkspaceNames = importedTargets.map((target) => target.workspaceName);
  const importedTarget = importedTargets.length === 1 ? importedTargets[0] : null;
  const importedId = importedTarget?.applicationId ?? null;
  const importSuccessMatches = [
    ...normalizedImportOutput.matchAll(SQLCL_IMPORT_SUCCESS_PATTERN)
  ];
  const importSuccessCount = importSuccessMatches.length;
  const targetReportedBeforeSuccess = Boolean(
    importedTargetMatches.length === 1 &&
    importSuccessMatches.length === 1 &&
    importedTargetMatches[0].index < importSuccessMatches[0].index
  );
  const importSuccessIsTerminal = Boolean(
    importSuccessMatches.length === 1 &&
    normalizedImportOutput.slice(
      importSuccessMatches[0].index + importSuccessMatches[0][0].length
    ).trim() === ""
  );
  if (!importResult.ok || importResult.code !== 0 ||
      importResult.ptyBacked !== true ||
      importResult.ptyProcessGroupReady !== true ||
      importResult.sessionReady !== true ||
      importResult.validationSent !== true ||
      importResult.validationAccepted !== true ||
      importResult.importSent !== true ||
      importResult.importCompleted !== true ||
      importResult.orderedMergedOutput !== true ||
      !validationEvidence.accepted ||
      hardFailureDetected ||
      importSuccessCount !== 1 ||
      !targetReportedBeforeSuccess ||
      !importSuccessIsTerminal ||
      importedTargets.length !== 1 ||
      importedId !== proof.canonicalId ||
      !sameName(importedTarget?.workspaceName, proof.workspaceName)) {
    await writeCompatibilityRecord(
      result.outputRoot,
      "sqlcl-warning-policy-import-failure.json",
      {
        status: "fail",
        timestamp: new Date().toISOString(),
        canonical_application_id: proof.canonicalId,
        workspace_id: proof.workspaceId,
        pty_backed: importResult.ptyBacked === true,
        pty_process_group_ready: importResult.ptyProcessGroupReady === true,
        session_ready: importResult.sessionReady === true,
        validation_sent: importResult.validationSent === true,
        validation_accepted: importResult.validationAccepted === true,
        import_sent: importResult.importSent === true,
        import_completed: importResult.importCompleted === true,
        ordered_merged_output: importResult.orderedMergedOutput === true,
        imported_application_ids: importedIds,
        imported_workspace_names: importedWorkspaceNames,
        import_success_count: importSuccessCount,
        target_reported_before_success: targetReportedBeforeSuccess,
        import_success_is_terminal: importSuccessIsTerminal,
        hard_failure_detected: hardFailureDetected,
        validation_evidence: validationEvidence,
        import_log_path: importLogPath,
        import_log_sha256: createHash("sha256").update(fullSessionOutput).digest("hex")
      }
    );
    throw new Error("APEXlang compatibility validate-and-import did not return proven SQLcl success");
  }

  const compatibilityRecord = {
    status: "pass",
    policy: "sqlcl_explicit_validation_success_with_compile_warnings",
    timestamp: new Date().toISOString(),
    target_resolution_status: payload.target_resolution_status,
    canonical_application_id: proof.canonicalId,
    canonical_application_alias: proof.canonicalAlias,
    workspace_id: proof.workspaceId,
    workspace_name: proof.workspaceName,
    db_connection_name: input.db_connection_name,
    staged_app_path: stagedAppPath,
    validated_app_digest: validatedAppDigest,
    staged_deployment_previous_application_id: Number.isInteger(previousApplicationId)
      ? previousApplicationId
      : null,
    staged_deployment_reconciled: previousApplicationId !== proof.canonicalId,
    imported_application_id: importedId,
    imported_workspace_name: importedTarget.workspaceName,
    import_success_count: importSuccessCount,
    target_reported_before_success: true,
    import_success_is_terminal: true,
    sqlcl_entrypoint: "sql -S -name <saved-alias>",
    pty_backed_sqlcl_session: true,
    pty_process_group_ready: true,
    session_ready_marker: true,
    one_session_validate_and_import: true,
    validation_gated_before_import_send: true,
    ordered_merged_output: true,
    source_runtime_report_path: payload.report_path,
    source_runtime_transcript_path: transcriptPath,
    source_runtime_transcript_sha256: createHash("sha256").update(transcript).digest("hex"),
    import_log_path: importLogPath,
    import_log_sha256: createHash("sha256").update(fullSessionOutput).digest("hex"),
    validation_evidence: validationEvidence,
    ...evidence
  };
  delete compatibilityRecord.accepted;
  const compatibilityReportPath = await writeCompatibilityRecord(
    result.outputRoot,
    "sqlcl-warning-policy-import.json",
    compatibilityRecord
  );
  const normalizedPayload = {
    ...payload,
    warnings_as_errors: false,
    validate_status: "pass",
    live_check_status: "pass",
    live_check_token: "APEXLANG_LIVE_CHECK_OK",
    final_check_status: "pass",
    import_status: "pass",
    runtime_gate_status: "pass",
    failure_class: "",
    blocking_reason: "",
    blocking_findings_count: 0,
    repair_loop_required: false,
    validation_feedback_status: "diagnostics-recorded",
    review_status: "diagnostics_recorded",
    recommended_next_action: "Import completed; review the recorded compile-warning diagnostics.",
    direct_import_bypass_forbidden: true,
    import_mode_used: "direct",
    import_lane_fallback_used: true,
    import_lane_fallback_reason: compatibilityRecord.policy,
    session_entrypoint_used: "compat_sql_name_alias",
    canonical_mapping_reconciled_source: previousApplicationId !== proof.canonicalId,
    phase_reports: [
      ...(Array.isArray(payload.phase_reports)
        ? payload.phase_reports.map((phase) => phase?.phase === "live_validate"
          ? {
              ...phase,
              original_status: phase.status,
              original_failure_class: phase.failure_class,
              status: "pass",
              failure_class: "",
              next_safe_action: "Continue to import.",
              compatibility_policy: compatibilityRecord.policy
            }
          : phase)
        : []),
      {
        phase: "import",
        status: "pass",
        failure_class: "",
        next_safe_action: "Import completed.",
        compatibility_policy: compatibilityRecord.policy
      }
    ],
    compatibility_fallback: {
      ...compatibilityRecord,
      report_path: compatibilityReportPath
    },
    notes: [
      ...(Array.isArray(payload.notes) ? payload.notes : []),
      "Imported after SQLcl explicitly validated the same staged app in the same saved-alias session; compile warnings remain recorded as diagnostics."
    ]
  };
  return {
    ...result,
    ok: true,
    code: 0,
    stdout: `${JSON.stringify(normalizedPayload, null, 2)}\n`,
    stderr: ""
  };
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

async function runCommand(input, command, options, runOptions = {}) {
  input = normalizeApexlangInput(input);
  if (typeof input.app_path === "string" && input.app_path.trim()) {
    const appPath = await assertProjectAppPath(input.app_path.trim(), options.cwd);
    await assertSymlinkFreeTree(appPath, {
      rejectHardlinks: input.action === "local_validate" && input.fix_vocab === true
    });
  }
  if (input.action === "workspace_probe" || command.prelude.length > 0) {
    await assertWorkspaceProbeCannotFollowSymlinks(options.cwd);
  }
  const runtimeApp = await prepareRuntimeApp(input, options.cwd, options.outputRoot, {
    forceStage: runOptions.forceRuntimeStage === true
  });
  const preRunAppDigest = runtimeApp.appPath && runtimeActionUsesDeployment(input)
    ? await computeApexlangAppDigest(runtimeApp.appPath)
    : undefined;
  if (runOptions.expectedAppDigest !== undefined) {
    const expectedAppDigest = requireAppDigest(runOptions.expectedAppDigest);
    if (!preRunAppDigest || preRunAppDigest !== expectedAppDigest) {
      throw new Error(
        "APEXlang application changed after the approved live check; revalidate before importing"
      );
    }
  }
  command = runtimeApp.staged ? commandWithAppPath(command, runtimeApp.appPath) : command;
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
        preludeResults,
        runtimeApp,
        appDigest: preRunAppDigest
      };
    }
  }

  await clearStaleRuntimeEvidence(command, options.outputRoot);
  const result = await invoke(command, options);
  const postRunAppDigest = runtimeApp.appPath && runtimeActionUsesDeployment(input)
    ? await computeApexlangAppDigest(runtimeApp.appPath)
    : undefined;
  if (preRunAppDigest && postRunAppDigest !== preRunAppDigest) {
    throw new Error(
      "APEXlang runtime changed the staged application during validation; review and revalidate before importing"
    );
  }
  return {
    ...result,
    action: input.action,
    command,
    outputRoot: options.outputRoot,
    preludeResults,
    runtimeApp,
    appDigest: postRunAppDigest ?? preRunAppDigest
  };
}

export async function runApexlang(input, options) {
  const normalizedInput = normalizeApexlangInput(input);
  const result = await runCommand(
    normalizedInput,
    buildApexlangCommand(normalizedInput),
    options
  );
  return normalizeWarningOnlyValidation(normalizedInput, result);
}

export async function runApexlangImport(input, options, importOptions = {}) {
  const normalizedInput = normalizeApexlangInput(input);
  const expectedAppDigest = requireAppDigest(importOptions.expectedAppDigest);
  const result = await runCommand(
    normalizedInput,
    buildApexlangImportCommand(normalizedInput, importOptions),
    options,
    { forceRuntimeStage: true, expectedAppDigest }
  );
  if (result.ok || importOptions.targetResolutionMode === "create-new") return result;
  return runWarningCompatibleImport(normalizedInput, result, options);
}

export function runApexlangCreateNewProof(input, options, proofOptions = {}) {
  const normalizedInput = normalizeApexlangInput(input);
  const expectedAppDigest = requireAppDigest(proofOptions.expectedAppDigest);
  return runCommand(
    normalizedInput,
    buildApexlangImportCommand(normalizedInput, {
      targetResolutionMode: "create-new",
      createNewConfirmed: false
    }),
    options,
    { forceRuntimeStage: true, expectedAppDigest }
  );
}
