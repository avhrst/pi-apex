# APEXlang support for pi

`pi-apexlang` is a pi package for Oracle APEX application development with
APEXlang. It combines two resources:

- Oracle's public `apexlang` Agent Skill, vendored unchanged at a pinned
  upstream commit.
- A small pi extension that runs the packaged APEXlang CLI with the user's
  project as its working directory, keeps runtime context stable for the
  session, and exposes a bounded `apexlang` tool.

This is an independent integration and is not an Oracle product.

## Install

Try the local checkout without installing it:

```bash
pi -e .
```

Install this Git repository for the current user:

```bash
pi install git:github.com/avhrst/pi-apex
```

Or install it only for the current project:

```bash
pi install git:github.com/avhrst/pi-apex -l
```

After an npm release, the equivalent command is:

```bash
pi install npm:pi-apexlang
```

Pi packages execute with the user's system permissions. Review extension and
skill sources before installation.

## Use

Pi discovers the skill automatically when a task concerns APEXlang. Force it
for a particular request with `/skill:apexlang`:

```text
/skill:apexlang Create a dashboard page from the verified schema metadata in metadata/tables.json. Check the APEXlang code and do not import it.
```

Useful prompts include:

```text
/skill:apexlang Probe this workspace and tell me which APEX app is safe to edit.
```

```text
/skill:apexlang Add an interactive report to the orders app using the existing table metadata. Validate locally and show me the compiler-truth evidence.
```

```text
/skill:apexlang Check applications/service-ops against connection apex_dev and APEX workspace SERVICE_OPS_DEV. Do not import it.
```

The registered `apexlang` tool supports:

| Action | Effect |
| --- | --- |
| `workspace_probe` | Finds bounded local context and candidate APEX apps. |
| `new_app_materialize` | Creates Oracle's base app scaffold after UI confirmation. |
| `local_validate` | Runs local APEXlang and vocabulary checks. |
| `compiler_truth_audit` | Verifies generated component structure against compiler metadata. |
| `query_valid_props` | Queries legal properties for an APEXlang component. |
| `runtime_preflight` | Resolves and checks the local SQLcl/APEX runtime. |
| `runtime_doctor` | Diagnoses runtime configuration. |
| `runtime_validate` | Runs Oracle's live check gate, then offers an interactive check-only or same-session validate-and-import choice. |

The model cannot request import as a standalone action. Oracle's skill defaults
to checking code; only after authoritative live validation passes does the
extension offer a separate GUI choice. Selecting **Check and import APEXlang
code** requires an explicit target mode:

- **Update existing** proceeds only when Oracle resolves one existing remote
  application.
- **Create new** first runs Oracle's target resolver without import authority.
  Only after it proves the alias is absent does Pi ask for a second
  confirmation and rerun validation plus import together.

Without GUI support, the tool always stops after checking and reports import
as a follow-up.

When refreshing a full APEXlang export, run one SQLcl export with explicit
replacement semantics:

```text
apex export -applicationid <id> -exptype APEXLANG -split -dir <absolute-parent-directory> -force
```

`-dir` names the parent directory; SQLcl creates the application-alias folder
below it. The `-force` flag removes and recreates that export folder, so a
repeat export produces one current snapshot instead of collision copies such
as `application_1.apx` and `p00005_1.apx`. Because this replaces the complete
local export, preserve or import any local-only work before refreshing it.

All app paths must remain inside the active Pi workspace. The adapter rejects
traversal, app-tree symlinks, and multiply linked files on mutating vocabulary
fixes; verifies live workspace input against `deployments/default.json`; and
terminates the whole spawned process tree when a run is cancelled or times
out.

## Requirements

Offline routing, templates, generation, and most local checks need Node.js
22.19 or newer. The bundled Python validators also require Python 3.

Oracle documents these requirements for live APEXlang work:

- Oracle APEX with APEXlang support, using the latest available 26.1 build.
- SQLcl 26.1.2 or newer.
- Java 17 or Java 21 for SQLcl.
- A saved SQLcl connection name and its corresponding APEX workspace name.
- A local APEX app or authoritative schema, model, API, or table metadata.

Do not pass database passwords or connection strings to the extension. Live
operations accept only a saved `db_connection_name` and require the matching
`workspace_name`.

## Package layout

```text
extensions/apexlang/index.ts  pi tool and lifecycle integration
extensions/lib/               argument-safe APEXlang process adapter
skills/apexlang/               unmodified Oracle APEXlang skill snapshot
scripts/                       provenance, sync, and smoke checks
test/                          adapter contract tests
```

Pi progressively discloses the skill: it initially sees only the skill name
and description, then reads `SKILL.md` and Oracle's compact routing catalogs
before loading task-specific references and templates. The entire 700+ file
documentation tree is not injected into the model context.

## Develop and verify

```bash
npm install
npm run check
npm run verify:package
```

To update the Oracle snapshot and record a new pinned commit:

```bash
npm run sync:oracle -- --ref main
npm run check
```

Review upstream changes before committing a refreshed snapshot. The sync
script replaces only `skills/apexlang`, refreshes the Oracle license, and
updates `UPSTREAM.json`.

## Provenance and license

The vendored skill comes from
[`oracle/skills/apex/apexlang`](https://github.com/oracle/skills/tree/30e30dbcbf5f92f3564bc85f8fd59d32736adcd6/apex/apexlang)
at commit `30e30dbcbf5f92f3564bc85f8fd59d32736adcd6`. See
[`UPSTREAM.json`](UPSTREAM.json) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

This package is distributed under the Universal Permissive License 1.0. See
[`LICENSE`](LICENSE).
