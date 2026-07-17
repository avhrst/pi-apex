import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { directoryDigest } from "./lib/vendor-digest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = resolve(root, "skills/apexlang");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const upstream = JSON.parse(await readFile(resolve(root, "UPSTREAM.json"), "utf8"));
const oracleManifest = JSON.parse(await readFile(resolve(skillRoot, "manifest.json"), "utf8"));

assert.equal(packageJson.keywords.includes("pi-package"), true, "pi-package keyword is required");
assert.deepEqual(packageJson.pi.extensions, ["./extensions/apexlang/index.ts"]);
assert.deepEqual(packageJson.pi.skills, ["./skills/apexlang"]);
assert.match(upstream.commit, /^[0-9a-f]{40}$/);
assert.match(upstream.content_sha256, /^[0-9a-f]{64}$/);
assert.equal(upstream.source_path, "apex/apexlang");
assert.equal(await directoryDigest(skillRoot), upstream.content_sha256, "vendored snapshot digest changed");

const declaredFiles = new Set([
  ...oracleManifest.required_output_files,
  ...oracleManifest.files.map((entry) => entry.path)
]);
for (const relativePath of declaredFiles) {
  await access(resolve(skillRoot, relativePath));
}

const skill = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
assert.match(skill, /^---\nname: apexlang\ndescription: .+\n---/);
const license = await readFile(resolve(root, "LICENSE"), "utf8");
assert.match(license, /Universal Permissive License/);
assert.match(license, /Copyright \(c\) 2025 Oracle/);

console.log(
  `Verified Oracle APEXlang snapshot ${upstream.commit.slice(0, 12)} (${declaredFiles.size} declared files).`
);
