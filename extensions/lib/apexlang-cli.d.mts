export type ApexlangAction =
  | "workspace_probe"
  | "new_app_materialize"
  | "local_validate"
  | "compiler_truth_audit"
  | "query_valid_props"
  | "runtime_preflight"
  | "runtime_doctor"
  | "runtime_validate";

export interface ApexlangInput {
  action: ApexlangAction;
  app_path?: string;
  db_connection_name?: string;
  workspace_name?: string;
  execution_mode?: "auto" | "build-root" | "path";
  apex_root?: string;
  compiler_oracle_home?: string;
  component?: string;
  component_type_id?: string;
  template_component?: string;
  parent?: string;
  group?: string;
  when?: string[];
  list?: boolean;
  supporting_objects?: boolean;
  fix_vocab?: boolean;
}

export interface ApexlangCommand {
  scriptPath: string;
  args: string[];
  prelude: Array<{ scriptPath: string; args: string[] }>;
}

export interface ApexlangRunOptions {
  cwd: string;
  outputRoot: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ApexlangImportOptions {
  targetResolutionMode?: "update-existing" | "create-new";
  createNewConfirmed?: boolean;
  expectedAppDigest?: string;
}

export interface ApexlangApprovedImportOptions extends ApexlangImportOptions {
  expectedAppDigest: string;
}

export interface ApexlangCreateNewProofOptions {
  expectedAppDigest: string;
}

export interface ProcessTreeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ApexlangProcessResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface SqlclValidationImportOptions extends ProcessTreeOptions {
  validateCommand: string;
  importCommand: string;
}

export interface SqlclValidationImportResult extends ApexlangProcessResult {
  validationAccepted: boolean;
  validationEvidence: {
    accepted: boolean;
    reason: string;
    warningCount?: number;
    validationSuccessCount?: number;
    outputSha256?: string;
  };
  ptyBacked: true;
  ptyProcessGroupReady: boolean;
  sessionReady: boolean;
  validationSent: boolean;
  importSent: boolean;
  importCompleted: boolean;
  hardFailureDetected: boolean;
  orderedMergedOutput: true;
  validationOutput: string;
  importOutput: string;
}

export interface ApexlangRunResult extends ApexlangProcessResult {
  action: ApexlangAction;
  command: ApexlangCommand;
  outputRoot: string;
  preludeResults: ApexlangProcessResult[];
  runtimeApp: {
    appPath?: string;
    staged: boolean;
    workspaceSource?: "workspace.name" | "app.workspace.name" | "explicit_workspace_name";
  };
  appDigest?: string;
}

export const APEXLANG_SKILL_ROOT: string;
export const APEXLANG_ACTIONS: readonly [
  "workspace_probe",
  "new_app_materialize",
  "local_validate",
  "compiler_truth_audit",
  "query_valid_props",
  "runtime_preflight",
  "runtime_doctor",
  "runtime_validate"
];

export function buildApexlangCommand(input: ApexlangInput): ApexlangCommand;
export function buildApexlangImportCommand(
  input: ApexlangInput,
  options?: ApexlangImportOptions
): ApexlangCommand;
export function assertProjectAppPath(appPath: string, cwd: string): Promise<string>;
export function validateMaterializationPaths(options: {
  cwd: string;
  standardRoot: string;
  requested: string;
  suggested: string;
}): Promise<string>;
export function prepareRuntimeApp(
  input: ApexlangInput,
  cwd: string,
  outputRoot: string,
  options?: { forceStage?: boolean }
): Promise<{
  appPath?: string;
  staged: boolean;
  workspaceSource?: "workspace.name" | "app.workspace.name" | "explicit_workspace_name";
}>;
export function computeApexlangAppDigest(appPath: string): Promise<string>;
export function classifyWarningOnlyRuntimePayload(
  payload: Record<string, unknown>,
  transcript: string,
  expectedImportIntent?: "validate-only" | "validate-and-import"
): {
  accepted: boolean;
  reason: string;
  attemptLabel?: string;
  warningCount?: number;
  validationSuccessCount?: number;
  attemptSha256?: string;
};
export function classifyWarningCompatibleSqlclValidation(output: string): {
  accepted: boolean;
  reason: string;
  warningCount: number;
  validationSuccessCount: number;
  outputSha256?: string;
};
export function proveWarningOnlyProblemsAreDiagnostics(
  payload: Record<string, any>,
  result: Pick<ApexlangRunResult, "outputRoot">
): Promise<{
  accepted: boolean;
  reason?: string;
  problemCount?: number;
  problemsPath?: string;
  problemsSha256?: string;
}>;
export function validateUpdateExistingImportProof(
  payload: Record<string, any>,
  input: ApexlangInput,
  stagedAppPath: string
): {
  canonicalId: number;
  canonicalAlias: string;
  sourceId: number;
  sourceAlias: string;
  workspaceId: string;
  workspaceName: string;
};
export function buildWarningCompatibleImportCommands(options: {
  appPath: string;
  workspaceId: string;
  canonicalId: number;
}): { validateCommand: string; importCommand: string };
export function runWarningCompatibleImport(
  input: ApexlangInput,
  result: ApexlangRunResult,
  options: ApexlangRunOptions,
  dependencies?: { sessionRunner?: typeof executeSqlclValidationThenImport }
): Promise<ApexlangRunResult>;
export function executeProcessTree(
  executable: string,
  args: string[],
  options: ProcessTreeOptions
): Promise<ApexlangProcessResult>;
export function executeSqlclValidationThenImport(
  executable: string,
  args: string[],
  options: SqlclValidationImportOptions
): Promise<SqlclValidationImportResult>;
export function runApexlang(
  input: ApexlangInput,
  options: ApexlangRunOptions
): Promise<ApexlangRunResult>;
export function runApexlangImport(
  input: ApexlangInput,
  options: ApexlangRunOptions,
  importOptions: ApexlangApprovedImportOptions
): Promise<ApexlangRunResult>;
export function runApexlangCreateNewProof(
  input: ApexlangInput,
  options: ApexlangRunOptions,
  proofOptions: ApexlangCreateNewProofOptions
): Promise<ApexlangRunResult>;
