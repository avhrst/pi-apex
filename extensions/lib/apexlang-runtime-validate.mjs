import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDirectory, "../../skills/apexlang");
const runtimeRoot = resolve(packageRoot, "runtime");

export async function loadPackagedRuntimeValidation() {
  process.env.APEXLANG_PACKAGE_ROOT = packageRoot;
  process.env.APEXLANG_RUNTIME_ROOT = runtimeRoot;
  process.env.APEXLANG_EMBEDDED_TOOLS_ROOT = resolve(packageRoot, "tools");

  const [runtime, grammar, common] = await Promise.all([
    import(pathToFileURL(resolve(runtimeRoot, "runtime.bundle.mjs")).href),
    import(pathToFileURL(resolve(runtimeRoot, "grammar_contract.mjs")).href),
    import(pathToFileURL(resolve(runtimeRoot, "lib/common.mjs")).href)
  ]);
  // Oracle's packaged Media List gate still addresses these two helpers using
  // source-tree paths. Redirect only their locations; keep its gate and reports.
  const dependencies = {
    resolveMediaListGrammarContract: (options) => runtime.resolveMediaListGrammarContract({
      ...options,
      buildGrammarContractFn: grammar.buildGrammarContract
    }),
    runTargetBuildLocalValidation: ({ appPath, componentContractPath }) => common.runCommand(
      "python3",
      [
        resolve(runtimeRoot, "internal/python/validate_apexlang.py"),
        "--component-attributes",
        componentContractPath,
        appPath
      ],
      { allowFailure: true, passthrough: false, env: { PYTHONDONTWRITEBYTECODE: "1" } }
    )
  };
  return {
    ...dependencies,
    run: (options) => runtime.runRuntimeValidate({
      ...options,
      _deps: { ...dependencies, ...options._deps }
    })
  };
}

function readOption(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

async function main(args) {
  if (args[0] !== "runtime" || args[1] !== "validate") {
    throw new Error("The pi APEXlang validation launcher accepts only runtime validate.");
  }
  const validation = await loadPackagedRuntimeValidation();
  const result = await validation.run({
    appPath: readOption(args, "--app-path"),
    dbConnectionName: readOption(args, "--db-connection-name"),
    executionMode: readOption(args, "--execution-mode", "auto"),
    targetResolutionMode: readOption(args, "--target-resolution-mode", "update-existing"),
    workspaceId: readOption(args, "--workspaceid"),
    supportingObjects: args.includes("--supporting-objects"),
    preflightOnly: args.includes("--preflight-only"),
    apexRoot: readOption(args, "--apex-root"),
    compilerOracleHome: readOption(args, "--compiler-oracle-home"),
    artifactDir: readOption(args, "--artifact-dir"),
    vscodeProblemsPath: readOption(args, "--vscode-problems-path"),
    reportPath: readOption(args, "--report-path"),
    transcriptPath: readOption(args, "--transcript-path")
  });
  process.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`);
  process.exitCode = result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
