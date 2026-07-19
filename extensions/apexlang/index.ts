import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  APEXLANG_ACTIONS,
  runApexlang,
  runApexlangCreateNewProof,
  runApexlangImport,
  type ApexlangAction,
  type ApexlangInput,
  type ApexlangRunResult
} from "../lib/apexlang-cli.mjs";
import {
  MASS_VALIDATION_DISTINCT_FILE_THRESHOLD,
  MASS_VALIDATION_FINDING_THRESHOLD,
  ORDS_SQLCL_COMPATIBILITY,
  ORDS_SQLCL_COMPATIBILITY_GUIDELINE,
  ORDS_SQLCL_COMPATIBILITY_TABLE,
  buildValidationCompatibilityAdvisory,
  clearLocalValidationCompatibilityReports,
  detectValidationCompatibilitySignal,
  formatValidationCompatibilityAdvisory,
  renderOrdsSqlclCompatibilityTable
} from "./compatibility.ts";

const MAX_TOOL_OUTPUT = 80_000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const CHECK_ONLY_CHOICE = "Check APEXlang code (recommended) — stop after the successful live check";
const IMPORT_CHOICE = "Check and import APEXlang code — revalidate and import in one SQLcl session";
const UPDATE_EXISTING_CHOICE = "Update an existing app — require one proven remote target";
const CREATE_NEW_CHOICE = "Create a new app — require proof that the alias is absent";
const EXPORT_OVERWRITE_GUIDELINE =
  "For a full APEXlang export refresh, run exactly one SQLcl `apex export` command with `-force` and `-dir` set to the absolute parent directory. Never export without `-force` into an existing destination: SQLcl can collision-suffix every artifact as `*_1.apx` instead of replacing the snapshot.";

function trimOutput(value: string, outputRoot?: string): string {
  if (value.length <= MAX_TOOL_OUTPUT) return value;
  const location = outputRoot ? ` at ${outputRoot}` : "";
  return `${value.slice(0, MAX_TOOL_OUTPUT)}\n\n[output truncated; full reports are in APEXLANG_OUTPUT_ROOT${location}]`;
}

function actionWritesProject(params: ApexlangInput): boolean {
  return params.action === "new_app_materialize" ||
    (params.action === "local_validate" && params.fix_vocab === true);
}

function confirmationMessage(params: ApexlangInput): string {
  if (params.action === "new_app_materialize") {
    return `Materialize a new APEXlang app at ${params.app_path ?? "the requested path"}?`;
  }
  return `Apply vocabulary fixes inside ${params.app_path ?? "the requested app"}?`;
}

function parsePayload(result: ApexlangRunResult): Record<string, unknown> | undefined {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function liveValidationPassed(result: ApexlangRunResult): boolean {
  if (!result.ok) return false;
  const payload = parsePayload(result);
  const validationSources = payload?.validation_sources as
    | { live_validator?: { status?: string } }
    | undefined;
  return (payload?.live_check_status === "pass" || payload?.validation_status === "pass") &&
    validationSources?.live_validator?.status === "pass";
}

function liveImportPassed(result: ApexlangRunResult): boolean {
  if (!result.ok) return false;
  const payload = parsePayload(result);
  return payload?.validate_status === "pass" &&
    payload?.import_status === "pass" &&
    payload?.runtime_gate_status === "pass";
}

function createNewTargetProved(result: ApexlangRunResult): boolean {
  const payload = parsePayload(result);
  return !result.ok &&
    payload?.target_resolution_mode === "create-new" &&
    payload?.target_resolution_status === "not_found_in_workspace" &&
    payload?.create_new_confirmation_required === true &&
    payload?.import_status === "blocked" &&
    payload?.failure_class === "create_new_confirmation_required";
}

function processOutput(result: ApexlangRunResult, compatibilityAdvisory = ""): string {
  const streams = result.ok ? [result.stdout, result.stderr] : [result.stderr, result.stdout];
  const output = trimOutput(streams.filter(Boolean).join("\n").trim(), result.outputRoot);
  return [output, compatibilityAdvisory].filter(Boolean).join("\n\n");
}

function failureOutput(
  result: ApexlangRunResult,
  fallback: string,
  compatibilityAdvisory = ""
): string {
  const streams = result.ok ? [result.stdout, result.stderr] : [result.stderr, result.stdout];
  const output = trimOutput(streams.filter(Boolean).join("\n").trim(), result.outputRoot) || fallback;
  return `${[output, compatibilityAdvisory].filter(Boolean).join("\n\n")}\n\nAPEXlang reports: ${result.outputRoot}`;
}

type ApexlangDependencies = {
  run: typeof runApexlang;
  runCreateNewProof: typeof runApexlangCreateNewProof;
  runImport: typeof runApexlangImport;
  outputRoot: typeof getOutputRoot;
};

export function createApexlangTool(overrides: Partial<ApexlangDependencies> = {}) {
  const dependencies: ApexlangDependencies = {
    run: runApexlang,
    runCreateNewProof: runApexlangCreateNewProof,
    runImport: runApexlangImport,
    outputRoot: getOutputRoot,
    ...overrides
  };

  return defineTool({
  name: "apexlang",
  label: "APEXlang",
  description:
    "Run the vendored Oracle APEXlang workspace probe, local checks, compiler-truth queries, runtime diagnostics, live validation, or confirmed new-app scaffolding. After a live check passes, import is available only through a separate interactive choice.",
  promptSnippet: "Probe, scaffold, and check Oracle APEXlang applications",
  promptGuidelines: [
    "Load the apexlang skill before using the apexlang tool and follow its routing and Missing Inputs rules.",
    "Use apexlang workspace_probe before app-scoped APEXlang work.",
    EXPORT_OVERWRITE_GUIDELINE,
    ORDS_SQLCL_COMPATIBILITY_GUIDELINE,
    "Use apexlang runtime_validate only after the user provides both db_connection_name and the matching APEX workspace_name; import requires the tool's separate post-check GUI choice."
  ],
  executionMode: "sequential",
  parameters: Type.Object({
    action: StringEnum(APEXLANG_ACTIONS, {
      description: "The bounded APEXlang operation to run."
    }),
    app_path: Type.Optional(
      Type.String({
        description: "APEX application directory contained within the current pi workspace."
      })
    ),
    db_connection_name: Type.Optional(
      Type.String({
        description:
          "Saved SQLcl connection name. Required with workspace_name for live checks, runtime diagnostics, and new-app materialization. Never pass credentials or a connect string."
      })
    ),
    workspace_name: Type.Optional(
      Type.String({ description: "APEX workspace name corresponding to db_connection_name." })
    ),
    execution_mode: Type.Optional(StringEnum(["auto", "build-root", "path"] as const)),
    apex_root: Type.Optional(
      Type.String({ description: "Optional APEX/SQLcl runtime root used by live validation." })
    ),
    compiler_oracle_home: Type.Optional(
      Type.String({ description: "Optional Oracle home or compiler metadata location." })
    ),
    component: Type.Optional(
      Type.String({ description: "Semantic component name for query_valid_props." })
    ),
    component_type_id: Type.Optional(
      Type.String({ description: "Exact compiler component type ID for query_valid_props." })
    ),
    template_component: Type.Optional(
      Type.String({ description: "Universal Theme template component for query_valid_props." })
    ),
    parent: Type.Optional(Type.String({ description: "Optional parent component filter." })),
    group: Type.Optional(Type.String({ description: "Optional property group filter." })),
    when: Type.Optional(
      Type.Array(Type.String(), {
        description: "Compiler assumptions such as identification.type=NATIVE_IR.",
        maxItems: 20
      })
    ),
    list: Type.Optional(Type.Boolean({ description: "List matching compiler component types." })),
    supporting_objects: Type.Optional(
      Type.Boolean({ description: "Include supporting objects in runtime preflight, validation, and import." })
    ),
    fix_vocab: Type.Optional(
      Type.Boolean({ description: "Apply local vocabulary fixes after interactive confirmation." })
    )
  }),

  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    const input = params as ApexlangInput;
    if (actionWritesProject(input)) {
      if (!ctx.hasUI) {
        throw new Error("This APEXlang action changes project files and requires interactive confirmation.");
      }
      const confirmed = await ctx.ui.confirm("Confirm APEXlang project change", confirmationMessage(input));
      if (!confirmed) {
        return {
          content: [{ type: "text", text: "APEXlang project change cancelled." }],
          details: { action: input.action, cancelled: true }
        };
      }
    }

    onUpdate?.({
      content: [{ type: "text", text: `Running APEXlang ${input.action}…` }],
      details: { action: input.action }
    });

    const outputRoot = await dependencies.outputRoot();
    const runOptions = {
      cwd: ctx.cwd,
      outputRoot,
      ...(signal ? { signal } : {}),
      timeoutMs: COMMAND_TIMEOUT_MS
    };
    if (input.action === "local_validate") {
      await clearLocalValidationCompatibilityReports(outputRoot);
    }
    const result = await dependencies.run(input, runOptions);
    const compatibilityAdvisory = await buildValidationCompatibilityAdvisory(result);
    if (compatibilityAdvisory) {
      onUpdate?.({
        content: [{ type: "text", text: compatibilityAdvisory }],
        details: { action: input.action, compatibilityAdvisory: true }
      });
    }
    const output = processOutput(result, compatibilityAdvisory);
    if (!result.ok) {
      throw new Error(
        failureOutput(
          result,
          `APEXlang ${input.action} failed with exit code ${result.code}.`,
          compatibilityAdvisory
        )
      );
    }

    if (input.action === "runtime_validate") {
      if (!liveValidationPassed(result)) {
        throw new Error(
          failureOutput(
            result,
            "APEXlang runtime validation did not produce authoritative live pass evidence.",
            compatibilityAdvisory
          )
        );
      }

      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: `${output}\n\nLive validation passed. Import was not run because GUI choices are unavailable; importing remains an explicit interactive follow-up.`
            }
          ],
          details: {
            action: input.action,
            exitCode: result.code,
            outputRoot: result.outputRoot,
            liveValidationPassed: true,
            imported: false
          }
        };
      }

      const choice = await ctx.ui.select("APEXlang live check passed. Choose the next step:", [
        CHECK_ONLY_CHOICE,
        IMPORT_CHOICE
      ]);
      if (choice !== CHECK_ONLY_CHOICE && choice !== IMPORT_CHOICE) {
        return {
          content: [
            {
              type: "text",
              text: `${output}\n\nLive validation passed. The post-check choice was cancelled; import was not run.`
            }
          ],
          details: {
            action: input.action,
            exitCode: result.code,
            outputRoot: result.outputRoot,
            liveValidationPassed: true,
            imported: false,
            postCheckChoice: "cancelled"
          }
        };
      }
      if (choice === IMPORT_CHOICE) {
        const expectedAppDigest = String(result.appDigest ?? "").trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(expectedAppDigest)) {
          throw new Error(
            "APEXlang live check did not produce a valid application snapshot digest; import is blocked until it is revalidated."
          );
        }
        const targetChoice = await ctx.ui.select("Choose the explicitly intended import target:", [
          UPDATE_EXISTING_CHOICE,
          CREATE_NEW_CHOICE
        ]);
        if (targetChoice !== UPDATE_EXISTING_CHOICE && targetChoice !== CREATE_NEW_CHOICE) {
          return {
            content: [
              {
                type: "text",
                text: `${output}\n\nLive validation passed. Import was cancelled before choosing a target mode.`
              }
            ],
            details: {
              action: input.action,
              exitCode: result.code,
              outputRoot: result.outputRoot,
              liveValidationPassed: true,
              imported: false
            }
          };
        }

        const targetResolutionMode = targetChoice === CREATE_NEW_CHOICE
          ? "create-new"
          : "update-existing";
        let createNewConfirmed = false;
        if (targetResolutionMode === "create-new") {
          onUpdate?.({
            content: [
              {
                type: "text",
                text: "Resolving the selected workspace to prove that the new app alias is absent…"
              }
            ],
            details: { action: input.action, targetResolutionMode, provingTarget: true }
          });
          const proofResult = await dependencies.runCreateNewProof(input, runOptions, {
            expectedAppDigest
          });
          if (!createNewTargetProved(proofResult)) {
            const proofCompatibilityAdvisory = await buildValidationCompatibilityAdvisory(proofResult);
            throw new Error(
              failureOutput(
                proofResult,
                "Oracle did not prove that the create-new target is absent from the selected workspace.",
                proofCompatibilityAdvisory
              )
            );
          }
          const proofPayload = parsePayload(proofResult);
          const provenAlias = String(proofPayload?.source_application_alias ?? "the app alias");
          const provenWorkspace = String(
            proofPayload?.lookup_scope_workspace_name ?? input.workspace_name ?? "the selected workspace"
          );
          createNewConfirmed = await ctx.ui.confirm(
            "Confirm new APEX application",
            `Oracle proved that ${provenAlias} is absent from ${provenWorkspace}. Create it by rerunning validation and import together?`
          );
          if (!createNewConfirmed) {
            return {
              content: [
                {
                  type: "text",
                  text: `${output}\n\nLive validation passed. Create-new import was cancelled.`
                }
              ],
              details: {
                action: input.action,
                exitCode: result.code,
                outputRoot: result.outputRoot,
                liveValidationPassed: true,
                imported: false
              }
            };
          }
        }

        onUpdate?.({
          content: [{ type: "text", text: "Revalidating and importing APEXlang in one SQLcl session…" }],
          details: { action: input.action, importApproved: true, targetResolutionMode }
        });
        const importResult = await dependencies.runImport(input, runOptions, {
          targetResolutionMode,
          createNewConfirmed,
          expectedAppDigest
        });
        const importCompatibilityAdvisory = await buildValidationCompatibilityAdvisory(importResult);
        const importOutput = processOutput(importResult, importCompatibilityAdvisory);
        if (!liveImportPassed(importResult)) {
          throw new Error(
            failureOutput(
              importResult,
              "APEXlang validate-and-import did not produce authoritative import pass evidence.",
              importCompatibilityAdvisory
            )
          );
        }
        return {
          content: [
            {
              type: "text",
              text: trimOutput(
                `Import completed: validate_status=pass, import_status=pass, runtime_gate_status=pass, target_resolution_mode=${targetResolutionMode}.\n\nApproved same-session validate and import:\n${importOutput}\n\nInitial live check:\n${output}`,
                importResult.outputRoot
              )
            }
          ],
          details: {
            action: input.action,
            exitCode: importResult.code,
            outputRoot: importResult.outputRoot,
            liveValidationPassed: true,
            imported: true,
            postCheckChoice: IMPORT_CHOICE,
            targetResolutionMode
          }
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: output || `APEXlang ${input.action} completed with exit code ${result.code}.`
        }
      ],
      details: {
        action: input.action,
        exitCode: result.code,
        outputRoot: result.outputRoot,
        preludeCount: result.preludeResults.length,
        ...(input.action === "runtime_validate"
          ? {
              liveValidationPassed: true,
              imported: false,
              postCheckChoice: CHECK_ONLY_CHOICE
            }
          : {})
      }
    };
  }
  });
}

const apexlangTool = createApexlangTool();

let outputRootPromise: Promise<string> | undefined;

function getOutputRoot(): Promise<string> {
  outputRootPromise ??= mkdtemp(join(tmpdir(), "pi-apexlang-"));
  return outputRootPromise;
}

async function cleanOutputRoot(): Promise<void> {
  if (!outputRootPromise) return;
  const outputRoot = await outputRootPromise;
  outputRootPromise = undefined;
  await rm(outputRoot, { recursive: true, force: true });
}

export default function apexlangExtension(pi: ExtensionAPI) {
  pi.registerTool(apexlangTool);
  pi.on("session_shutdown", async () => {
    await cleanOutputRoot();
  });
}

export {
  APEXLANG_ACTIONS,
  CHECK_ONLY_CHOICE,
  IMPORT_CHOICE,
  CREATE_NEW_CHOICE,
  EXPORT_OVERWRITE_GUIDELINE,
  MASS_VALIDATION_DISTINCT_FILE_THRESHOLD,
  MASS_VALIDATION_FINDING_THRESHOLD,
  ORDS_SQLCL_COMPATIBILITY,
  ORDS_SQLCL_COMPATIBILITY_GUIDELINE,
  ORDS_SQLCL_COMPATIBILITY_TABLE,
  UPDATE_EXISTING_CHOICE,
  actionWritesProject,
  buildValidationCompatibilityAdvisory,
  clearLocalValidationCompatibilityReports,
  confirmationMessage,
  createNewTargetProved,
  detectValidationCompatibilitySignal,
  formatValidationCompatibilityAdvisory,
  liveImportPassed,
  liveValidationPassed,
  renderOrdsSqlclCompatibilityTable
};
export type { ApexlangAction };
