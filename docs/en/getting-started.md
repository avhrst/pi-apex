# Getting started

[Documentation](README.md) · [Українська](../uk/getting-started.md)

## Requirements

For local work, have pi installed, Node.js **22.19.0 or newer**, and `python3` available on `PATH`. Node's minimum is declared in [package.json](../../package.json); the [local validator wrapper](../../extensions/lib/apexlang-local-validate.mjs) invokes `python3` directly.

For live commands, the [bundled Oracle skill](../../skills/apexlang/README.md#requirements) requires SQLcl **26.1.2 or newer** and the latest available APEX **26.1** build, with a valid database connection and privileges for the target workspace and schema. The general [Oracle APEXlang prerequisites](https://docs.oracle.com/en/database/oracle/sql-developer-command-line/26.1/sqcug/prerequisites-apexlang.html) list SQLcl 26.1 as the minimum. ORDS **26.1.1** introduced the required APEXlang support; see [ORDS 26.1.1 release notes](https://www.oracle.com/tools/ords/ords-relnotes-26.1.1.html). For the SQLcl 26.1.2 line, Oracle lists Java **17 or 21** in its [release notes](https://www.oracle.com/tools/sqlcl/sqlcl-relnotes-26.1.2.html). Check the relevant release documentation when selecting another version.

Provide a **saved SQLcl connection name** and its corresponding **APEX workspace name**. The extension accepts names, not passwords, credentials, or connection strings. Local work also needs an existing APEXlang app or authoritative schema, model, API, or table metadata.

## Install and open a project

Install for the current user:

```bash
pi install git:github.com/avhrst/pi-apex
```

For installation scoped to an application project, run this inside that project:

```bash
pi install git:github.com/avhrst/pi-apex -l
```

Then start `pi` in the directory that contains your application and metadata. This directory is the active workspace: `app_path` must stay inside it.

To try this repository locally, run `pi -e .` from its checkout. That makes the checkout the workspace; it does not select an external application project. The root README also documents the npm installation form for use after an npm release. This guide does not assert that a particular version has been published.

Pi loads the skill when relevant. Prefix a request with `/skill:apexlang` to select it explicitly.

## First check of an existing app

The names below are examples; substitute a real app path and saved connection.

1. Establish context:

   ```text
   /skill:apexlang Probe this workspace. Identify candidate APEX apps and the available authoritative metadata. Explain any missing inputs.
   ```

2. Check the intended app locally:

   ```text
   /skill:apexlang Check applications/service-ops locally. Run the compiler-truth audit when compiler metadata is available. Show findings and report paths. Do not import it.
   ```

3. When the runtime is configured, request a server check:

   ```text
   /skill:apexlang Check applications/service-ops using saved connection apex_dev and APEX workspace SERVICE_OPS_DEV. Diagnose the runtime first, then validate live. Do not import it.
   ```

If the successful live check displays a next-step dialog, select **Check APEXlang code** to finish without importing. Each interactive dialog is limited to five minutes; cancellation, timeout, or an unavailable UI does not authorize an import.

See [the tool reference](tool-reference.md) for exact action names and [the import flow](architecture.md#import-flow) for the separate import path.

## Create a local scaffold

Provide authoritative metadata and an app alias, target path, or title hint. `workspace_probe` must resolve the context, set `app_context.status=create_new_allowed`, and return the exact `suggested_app_path`. `new_app_materialize` requires this path, the saved connection/workspace pair, and interactive confirmation.

```text
/skill:apexlang Use the verified schema metadata in this workspace to prepare a new APEXlang app. Probe first and report the proposed app path. Materialize the scaffold through the confirmation dialog, then check it locally. Do not import it.
```

Materialization creates local files. Creating a remote application is a later, separately confirmed import operation.

## Refresh a complete export

In an appropriately connected SQLcl session, replace the placeholders before running:

```text
apex export -applicationid <id> -exptype APEXLANG -split -dir <absolute-parent-directory> -force
```

`-dir` is the parent directory; SQLcl creates the application-alias folder below it. `-force` removes and recreates that export folder. Preserve local-only changes before refreshing. The extension's export guidance calls for one replacement export to avoid collision-suffixed copies such as `p00005_1.apx`; see the [registered guideline](../../extensions/apexlang/index.ts).
