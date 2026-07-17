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
}

export interface ProcessTreeOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
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

export interface ApexlangRunResult extends ApexlangProcessResult {
  action: ApexlangAction;
  command: ApexlangCommand;
  outputRoot: string;
  preludeResults: ApexlangProcessResult[];
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
export function executeProcessTree(
  executable: string,
  args: string[],
  options: ProcessTreeOptions
): Promise<ApexlangProcessResult>;
export function runApexlang(
  input: ApexlangInput,
  options: ApexlangRunOptions
): Promise<ApexlangRunResult>;
export function runApexlangImport(
  input: ApexlangInput,
  options: ApexlangRunOptions,
  importOptions?: ApexlangImportOptions
): Promise<ApexlangRunResult>;
export function runApexlangCreateNewProof(
  input: ApexlangInput,
  options: ApexlangRunOptions
): Promise<ApexlangRunResult>;
