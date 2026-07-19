import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(moduleDirectory, "../../skills/apexlang");
const runtimeRoot = resolve(packageRoot, "runtime");

function readOption(args, name, fallback = "") {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function hasFlag(args, name) {
  return args.includes(name);
}

const args = process.argv.slice(2);
if (args[0] !== "runtime" || args[1] !== "roundtrip") {
  throw new Error("The pi APEXlang roundtrip launcher accepts only runtime roundtrip.");
}

process.env.APEXLANG_PACKAGE_ROOT = packageRoot;
process.env.APEXLANG_RUNTIME_ROOT = runtimeRoot;
process.env.APEXLANG_EMBEDDED_TOOLS_ROOT = resolve(packageRoot, "tools");

const runtime = await import(
  `${pathToFileURL(resolve(runtimeRoot, "runtime.bundle.mjs")).href}?pi-roundtrip`
);
const result = await runtime.runRuntimeRoundtrip({
  appPath: readOption(args, "--app-path"),
  dbConnectionName: readOption(args, "--db-connection-name"),
  executionMode: readOption(args, "--execution-mode", "auto"),
  importIntentChoice: readOption(args, "--import-intent", "validate-only"),
  importIntentSource: "cli",
  targetResolutionMode: readOption(args, "--target-resolution-mode", "update-existing"),
  createNewConfirmed: hasFlag(args, "--create-new-confirmed"),
  supportingObjects: hasFlag(args, "--supporting-objects"),
  apexRoot: readOption(args, "--apex-root"),
  localValidationPolicy: "skip"
});

process.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`);
process.exitCode = result.code;
