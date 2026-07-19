#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(moduleDirectory, "../../skills/apexlang");
const runtimeRoot = resolve(skillRoot, "runtime");
const pythonRoot = resolve(runtimeRoot, "internal/python");
const optimizedDslValidator = resolve(moduleDirectory, "apexlang-local-validator.py");

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? String(args[index + 1]).trim() : "";
}

function main() {
  const args = process.argv.slice(2);
  const appPath = readOption(args, "--app-path");
  if (!appPath) {
    console.error("Missing required --app-path");
    return 1;
  }

  const outputRoot = String(process.env.APEXLANG_OUTPUT_ROOT ?? "").trim();
  if (!outputRoot) {
    console.error("APEXLANG_OUTPUT_ROOT is required in packaged apexlang runtime");
    return 1;
  }

  const reportDir = resolve(outputRoot, "logs");
  mkdirSync(reportDir, { recursive: true });
  const fixVocab = args.includes("--fix-vocab");
  const commands = [
    [
      resolve(pythonRoot, "validate_apexlang_vocab.py"),
      [
        "--app-path",
        appPath,
        "--report-path",
        join(reportDir, "apexlang-vocab-report.json"),
        fixVocab ? "--rewrite" : "--check-only"
      ]
    ],
    [
      optimizedDslValidator,
      ["--report-path", join(reportDir, "apexlang-dsl-report.json"), appPath]
    ],
    [
      resolve(pythonRoot, "validate_validations.py"),
      ["--report-path", join(reportDir, "apexlang-validations-report.json"), appPath]
    ]
  ];

  let failures = 0;
  for (const [scriptPath, scriptArgs] of commands) {
    const result = spawnSync("python3", [scriptPath, ...scriptArgs], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        APEXLANG_EMBEDDED_TOOLS_ROOT: resolve(skillRoot, "tools"),
        APEXLANG_PACKAGE_ROOT: skillRoot,
        APEXLANG_RUNTIME_ROOT: runtimeRoot,
        PYTHONDONTWRITEBYTECODE: "1"
      }
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (typeof result.status !== "number" || result.status !== 0) failures += 1;
  }

  if (failures > 0) {
    console.log("APEXLANG_LOCAL_CHECK_FAILED");
    return 1;
  }
  console.log("APEXLANG_LOCAL_CHECK_OK");
  return 0;
}

process.exitCode = main();
