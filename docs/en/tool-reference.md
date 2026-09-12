# Tool reference

[Documentation](README.md) · [Українська](../uk/tool-reference.md)

The registered tool is named **`apexlang`**. Its model-visible API has exactly the eight actions below. The schema is in [index.ts](../../extensions/apexlang/index.ts), while action-specific requirements and command construction are in [apexlang-cli.mjs](../../extensions/lib/apexlang-cli.mjs).

## Actions

| Action | Required input beyond `action` | Effect |
| --- | --- | --- |
| `workspace_probe` | None; connection and workspace must be supplied together if used | Discovers bounded local context and candidate applications. |
| `new_app_materialize` | `app_path`, `db_connection_name`, `workspace_name`; authoritative probe result | Creates the base scaffold after interactive confirmation, only at the exact suggested path. |
| `local_validate` | `app_path` | Runs vocabulary, DSL, and validation-rule checks. `fix_vocab=true` rewrites vocabulary after confirmation. |
| `compiler_truth_audit` | `app_path` | Audits against compiler metadata with component-attribute verification always enabled. |
| `query_valid_props` | At least one of `component`, `component_type_id`, `template_component`, or `list=true` | Queries compiler properties or lists matching component types; requests JSON output. |
| `runtime_preflight` | `db_connection_name`, `workspace_name` | Resolves/checks runtime setup; accepts optional `app_path`. |
| `runtime_doctor` | `db_connection_name`, `workspace_name` | Diagnoses runtime setup; accepts optional `app_path`. |
| `runtime_validate` | `app_path`, `db_connection_name`, `workspace_name` | Validates live, then offers the separate interactive import path after an authoritative pass. |

The two direct project-writing operations are scaffold creation and vocabulary rewriting. Reports and temporary runtime copies may also be written by other actions. Server import is a separate confirmed branch of `runtime_validate`.

## Parameters

| Parameter | Type / values | Used by |
| --- | --- | --- |
| `action` | One of the eight names above | All calls |
| `app_path` | Directory within the active workspace | Scaffold, local/audit/live validation; optional for preflight/doctor |
| `db_connection_name` | Saved SQLcl alias, 1–128 characters; letters, digits, `_`, `.`, `-`; first character alphanumeric or `_` | Probe, scaffold, runtime actions |
| `workspace_name` | 1–128 characters; letters, digits, `_`, `$`, `#`, `.`, `-`; first character alphanumeric | Paired with the saved connection |
| `execution_mode` | `auto`, `build-root`, `path` | Runtime actions; delegated to Oracle runtime resolution |
| `apex_root` | Runtime root path | Runtime actions |
| `compiler_oracle_home` | Compiler metadata location or Oracle home | Compiler audit, property queries, initial live validation |
| `component` | Semantic component identifier | Property query |
| `component_type_id` | Numeric ID supplied as a string | Property query |
| `template_component` | Universal Theme template component identifier | Property query |
| `parent`, `group` | Component/property-group filters | Property query |
| `when` | Array of up to 20 assumption strings | Property query |
| `list` | Boolean | Property query |
| `supporting_objects` | Boolean | Runtime preflight/doctor, validation, and the later import path |
| `fix_vocab` | Boolean | Local validation |

Control characters are rejected in text inputs. Paths also reject double quotes and ampersands. The schema exposes shared optional fields; the command builder determines which fields each action consumes. In particular, the roundtrip import builder does not forward `compiler_oracle_home` as a CLI option.

## Example tool inputs

These are tool argument objects, not shell commands. Replace illustrative values with verified project context.

```json
{"action":"workspace_probe"}
```

```json
{"action":"local_validate","app_path":"applications/service-ops"}
```

```json
{"action":"query_valid_props","list":true}
```

```json
{"action":"runtime_preflight","app_path":"applications/service-ops","db_connection_name":"apex_dev","workspace_name":"SERVICE_OPS_DEV"}
```

```json
{"action":"runtime_validate","app_path":"applications/service-ops","db_connection_name":"apex_dev","workspace_name":"SERVICE_OPS_DEV"}
```

## Results and pass criteria

Successful tool responses contain text plus `details` such as `action`, `exitCode`, and `outputRoot`. Runtime validation also reports `liveValidationPassed` and `imported`, with choice/target details when applicable. Cancelled project changes return `cancelled=true`. Failed runs throw an error containing the available process output and report path; pre-execution input errors may have no reports yet.

| Operation | Evidence checked by the extension |
| --- | --- |
| Local checks | Wrapper exits successfully and emits `APEXLANG_LOCAL_CHECK_OK`; individual reports carry diagnostics. |
| Live check | Successful process result; `live_check_status=pass` **or** `validation_status=pass`; and `validation_sources.live_validator.status=pass`. |
| New-target proof | A deliberately blocked result: `target_resolution_mode=create-new`, `target_resolution_status=not_found_in_workspace`, `create_new_confirmation_required=true`, `import_status=blocked`, `failure_class=create_new_confirmation_required`, and `ok=false`. |
| Import | Successful process result and `validate_status=pass`, `import_status=pass`, `runtime_gate_status=pass`. |

Exit code zero alone is insufficient for live-check or import success. The new-target proof is expected to stop at a confirmation boundary; it is not an imported application.

## Warning compatibility

The adapter contains a narrowly checked compatibility path for SQLcl results containing only compile warnings. It verifies current artifacts, transcript evidence, and applicable target identity before normalizing a result or continuing an approved import. Missing, stale, contradictory, or hard-error evidence remains blocking. The create-new branch does not use the existing-app compatibility import fallback.

This mechanism is separate from the ORDS/SQLcl **advisory table**, which only adds diagnostic guidance. See [maintenance](maintenance.md) and the source functions `normalizeWarningOnlyValidation` and `runWarningCompatibleImport` in the [adapter](../../extensions/lib/apexlang-cli.mjs).
