import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import compatibility from "./ords-sqlcl-compatibility.json" with { type: "json" };
import type { ApexlangRunResult } from "../lib/apexlang-cli.mjs";

type JsonRecord = Record<string, unknown>;

export type ValidationCompatibilitySignal = {
  findingCount?: number;
  distinctFileCount?: number;
  source: "structured-result" | "local-reports" | "compiler-truth-output" | "unsupported-mmd";
};

export const ORDS_SQLCL_COMPATIBILITY = compatibility;
export const ORDS_SQLCL_COMPATIBILITY_TABLE = compatibility.rows;
export const MASS_VALIDATION_FINDING_THRESHOLD = compatibility.massValidation.minimumFindings;
export const MASS_VALIDATION_DISTINCT_FILE_THRESHOLD =
  compatibility.massValidation.minimumDistinctFilesForAppWideReports;
export const ORDS_SQLCL_COMPATIBILITY_GUIDELINE =
  `When a validation action reports ${MASS_VALIDATION_FINDING_THRESHOLD}+ findings, recommend checking the server APEX/ORDS release, the app mmdVersion, and local \`sql -version\` against the extension's advisory compatibility table. For APEX 26.1, SQLcl 26.1 is Oracle's minimum and 26.1.2.132.1334 is the diagnostic baseline; do not hard-block other SQLcl versions or weaken validation/import gates.`;

const VALIDATION_ACTIONS = new Set([
  "local_validate",
  "compiler_truth_audit",
  "runtime_validate"
]);
const LOCAL_VALIDATION_REPORT_NAMES = [
  "apexlang-dsl-report.json",
  "apexlang-validations-report.json",
  "apexlang-vocab-report.json"
] as const;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function parseJsonRecord(value: string): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function safeCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function maximumStructuredFindingCount(payload: JsonRecord): number | undefined {
  const compatibilityFallback = asRecord(payload.compatibility_fallback);
  const candidates = [
    safeCount(payload.unresolved_count),
    safeCount(payload.problem_count),
    Array.isArray(payload.issues) ? payload.issues.length : undefined,
    Array.isArray(payload.problems) ? payload.problems.length : undefined,
    safeCount(compatibilityFallback?.original_unresolved_count)
  ].filter((value): value is number => value !== undefined);
  return candidates.length > 0 ? Math.max(...candidates) : undefined;
}

function diagnosticIdentity(issue: unknown, reportName: string, index: number): {
  key: string;
  file?: string;
} {
  if (typeof issue === "string") {
    const raw = issue.trim();
    const match = raw.match(/^\s*-?\s*(.+?\.apx):(\d+)(?::\d+)?:\s+[A-Z][A-Z0-9_]+\b/);
    return { key: raw || `${reportName}:${index}`, ...(match?.[1] ? { file: match[1] } : {}) };
  }

  const record = asRecord(issue);
  if (!record) return { key: `${reportName}:${index}:${String(issue)}` };
  const file = typeof record.file === "string" ? record.file.trim() : "";
  const raw = typeof record.raw === "string" ? record.raw.trim() : "";
  const key = raw || [
    file,
    String(record.line ?? ""),
    String(record.column ?? ""),
    String(record.rule ?? record.code ?? ""),
    String(record.message ?? "")
  ].join(":");
  return {
    key: key || `${reportName}:${index}:${JSON.stringify(record)}`,
    ...(file ? { file } : {})
  };
}

async function readJsonReport(path: string): Promise<JsonRecord | undefined> {
  try {
    return parseJsonRecord(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

export async function clearLocalValidationCompatibilityReports(outputRoot: string): Promise<void> {
  await Promise.all(
    LOCAL_VALIDATION_REPORT_NAMES.map((name) => rm(join(outputRoot, "logs", name), { force: true }))
  );
}

async function detectLocalReportSignal(outputRoot: string): Promise<ValidationCompatibilitySignal | undefined> {
  const reports = await Promise.all(
    LOCAL_VALIDATION_REPORT_NAMES.map(async (name) => ({
      name,
      payload: await readJsonReport(join(outputRoot, "logs", name))
    }))
  );
  const vocabularyReport = reports.find(({ name }) => name === "apexlang-vocab-report.json")?.payload;
  if (vocabularyReport?.blocking_reason === "UNSUPPORTED_MMD_VERSION") {
    return { source: "unsupported-mmd" };
  }

  const findingKeys = new Set<string>();
  const files = new Set<string>();
  for (const { name, payload } of reports) {
    for (const collection of [payload?.issues, payload?.unresolved]) {
      if (!Array.isArray(collection)) continue;
      collection.forEach((issue, index) => {
        const identity = diagnosticIdentity(issue, name, index);
        findingKeys.add(identity.key);
        if (identity.file) files.add(identity.file);
      });
    }
  }
  if (
    findingKeys.size >= MASS_VALIDATION_FINDING_THRESHOLD &&
    files.size >= MASS_VALIDATION_DISTINCT_FILE_THRESHOLD
  ) {
    return {
      source: "local-reports",
      findingCount: findingKeys.size,
      distinctFileCount: files.size
    };
  }
  return undefined;
}

function detectCompilerTruthOutputSignal(output: string): ValidationCompatibilitySignal | undefined {
  const findings = new Set<string>();
  const files = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+(.+?\.apx):(\d+)(?::\d+)?:\s+([A-Z][A-Z0-9_]+)\b\s*(.*)$/);
    if (!match?.[1]) continue;
    findings.add(`${match[1]}:${match[2]}:${match[3]}:${match[4] ?? ""}`);
    files.add(match[1]);
  }
  if (
    findings.size >= MASS_VALIDATION_FINDING_THRESHOLD &&
    files.size >= MASS_VALIDATION_DISTINCT_FILE_THRESHOLD
  ) {
    return {
      source: "compiler-truth-output",
      findingCount: findings.size,
      distinctFileCount: files.size
    };
  }
  return undefined;
}

export async function detectValidationCompatibilitySignal(
  result: ApexlangRunResult
): Promise<ValidationCompatibilitySignal | undefined> {
  if (!VALIDATION_ACTIONS.has(result.action)) return undefined;

  const payload = parseJsonRecord(result.stdout);
  if (payload) {
    const findingCount = maximumStructuredFindingCount(payload);
    if (findingCount !== undefined && findingCount >= MASS_VALIDATION_FINDING_THRESHOLD) {
      return { source: "structured-result", findingCount };
    }
  }
  if (result.action === "local_validate") {
    return detectLocalReportSignal(result.outputRoot);
  }
  if (result.action === "compiler_truth_audit") {
    return detectCompilerTruthOutputSignal([result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
  return undefined;
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderOrdsSqlclCompatibilityTable(): string {
  const rows = ORDS_SQLCL_COMPATIBILITY_TABLE.map((row) => {
    const guidance = row.diagnosticSqlclBuild && row.diagnosticSqlclDownloadUrl
      ? `${row.sqlclGuidance} [Download ${row.diagnosticSqlclBuild}](${row.diagnosticSqlclDownloadUrl})`
      : row.sqlclGuidance;
    return `| ${tableCell(row.environment)} | ${tableCell(guidance)} | ${tableCell(row.basis)} |`;
  });
  return [
    "| Server environment | SQLcl guidance | Basis |",
    "| --- | --- | --- |",
    ...rows
  ].join("\n");
}

export function formatValidationCompatibilityAdvisory(
  signal: ValidationCompatibilitySignal
): string {
  const findingSummary = signal.findingCount === undefined
    ? "The application declares an unsupported APEXlang compiler metadata version."
    : `Large-scale validation output detected (${signal.findingCount} findings${
        signal.distinctFileCount === undefined ? "" : ` across ${signal.distinctFileCount} files`
      }).`;
  return [
    "### SQLcl/ORDS compatibility advisory",
    "",
    `${findingSummary} Before changing many application files, check local \`sql -version\`, the app's \`.apex/apexlang.json\` \`mmdVersion\`, and the server APEX and ORDS versions with its administrator. A version/metadata mismatch can create broad diagnostic noise.`,
    "",
    renderOrdsSqlclCompatibilityTable(),
    "",
    compatibility.caveat,
    "This advice does not turn a failed validation into a pass and does not authorize import."
  ].join("\n");
}

export async function buildValidationCompatibilityAdvisory(
  result: ApexlangRunResult
): Promise<string> {
  const signal = await detectValidationCompatibilitySignal(result);
  return signal ? formatValidationCompatibilityAdvisory(signal) : "";
}
