# Maintenance and troubleshooting

[Documentation](README.md) · [Українська](../uk/maintenance.md)

## Keep the reports you need

Read the `outputRoot` in tool result details or the `APEXlang reports:` path in an execution error. The extension passes this directory to subprocesses as `APEXLANG_OUTPUT_ROOT`; its own temporary root is created internally rather than selected by a tool parameter.

| Relative location | Contents |
| --- | --- |
| `logs/apexlang-vocab-report.json` | Vocabulary findings and unsupported-MMD diagnostics |
| `logs/apexlang-dsl-report.json` | DSL validation findings |
| `logs/apexlang-validations-report.json` | Validation-rule findings |
| `logs/validation/` | Live-validation artifacts when produced by the runtime |
| `logs/runtime-run.json`, `logs/runtime-run.log` | Roundtrip runtime report and transcript when produced |
| `logs/compat/` | Compatibility evidence when that path is used |
| `runtime-apps/` | Temporary staged application copies |

Not every action creates every file. New runs clear known stale evidence, and session shutdown deletes the whole root. Save the relevant reports to a project-owned evidence directory before another run or shutdown if you need a durable record. Reports can contain application code, names, and diagnostics; review their contents before sharing them.

## Diagnose by symptom

| Symptom | Next step |
| --- | --- |
| `Missing Inputs` during scaffolding | Supply authoritative metadata and an app identity hint; probe again and use exactly `suggested_app_path`. |
| App path or symlink rejected | Open pi at the intended project root and use a real app directory inside it. |
| Vocabulary fix rejects a multiply linked file | Make the intended app file independent before requesting a rewrite. |
| Saved connection or workspace rejected | Use the saved alias, not a connection string; supply the matching workspace. |
| `deployments/default.json` missing/conflicting | Inspect the exported deployment metadata and reconcile the intended workspace before retrying. |
| Compiler properties cannot be resolved | Check the app's `mmdVersion` and the available compiler metadata; use `compiler_oracle_home` where supported. |
| Many findings across the app | Review SQLcl/APEX/ORDS and compiler-metadata compatibility before bulk edits. |
| Live process exits successfully but import is unavailable | Inspect authoritative live-validator fields; a process exit code alone is insufficient. |
| App changed after the approved check | Revalidate the current app snapshot. |
| Post-check dialog cancelled or timed out | The app was not imported; request a fresh check if an import is still intended. |
| Process timeout or output-limit error | Inspect saved output, diagnose with `runtime_doctor`, and address the cause before rerunning. |

## Version advisory

The [machine-readable table](../../extensions/apexlang/ords-sqlcl-compatibility.json) records `policy=advisory-only` and a review date of **2026-07-19**. Its SQLcl build **26.1.2.132.1334** is a diagnostic baseline for the documented APEX 26.1 scenarios, not a universal version pin. SQLcl 26.2 is not categorically blocked.

The [advisory detector](../../extensions/apexlang/compatibility.ts) triggers for at least **50 structured findings**. Local JSON reports and compiler-truth text additionally need at least **5 distinct `.apx` files**; duplicate findings are deduplicated. A local vocabulary report explicitly declaring `UNSUPPORTED_MMD_VERSION` also triggers guidance.

Check `sql -version`, `.apex/apexlang.json` → `mmdVersion`, and the server's APEX/ORDS releases with its administrator. The table adds guidance without changing validation status or granting import authority. Its recorded Oracle minima and project diagnostic recommendations have distinct `basis` values; consult the linked release documentation for other release lines.

## Develop and verify

From the repository root:

```bash
npm install --ignore-scripts
npm run check
```

`npm run check` runs these stages in order:

| Stage | What it checks |
| --- | --- |
| `typecheck` | Strict TypeScript checks without emitting files |
| `verify:vendor` | The pinned Oracle snapshot digest and provenance |
| `test` | Extension/adapter contracts and validator-output parity |
| `smoke` | Probe of an empty temporary workspace and local validation of the bundled scaffold |
| `verify:package` | npm dry-run package contents and excluded development/cache files |

These checks are local automated verification, not proof of a successful live validation or import against a real server. The publish workflow is manually dispatched and runs `npm run check` before publishing; see [publish-npm.yml](../../.github/workflows/publish-npm.yml).

## Refresh Oracle's snapshot

Use a reviewed commit/ref in place of `<reviewed-ref>`:

```bash
npm run sync:oracle -- --ref <reviewed-ref>
npm run check
```

The [sync script](../../scripts/sync-oracle-apexlang.mjs) fetches Oracle's repository, replaces `skills/apexlang`, refreshes `LICENSE`, updates the commit/digest in `UPSTREAM.json`, and updates pinned references in the root README and third-party notices. It uses a backup while replacing the snapshot. Review the resulting diff before committing.

Keep custom behavior in `extensions/`; local edits inside the Oracle snapshot break the provenance check. After behavior changes, update both language guides and both infographic SVGs/PNGs together. The guides' baseline date/commit is a documentation snapshot, not automatically rewritten by the Oracle sync script.

## Documentation assets

The infographics are editable SVGs in [docs/assets](../assets), with PNG copies for sharing. Both use the same layout and workflow. SVG is the source of each image; regenerate its PNG after changing labels or diagrams. The npm `files` list includes `docs` so the installed README's documentation links remain usable.

Project source/test links in these guides refer to the Git checkout. `scripts/` and `test/` are development resources and are intentionally not included in the npm package; open the [source repository](https://github.com/avhrst/pi-apex) for them. Licensing and vendor attribution are in [LICENSE](../../LICENSE), [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md), and [UPSTREAM.json](../../UPSTREAM.json).
