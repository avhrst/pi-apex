import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { directoryDigest } from "./lib/vendor-digest.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/oracle/skills.git";
const refIndex = process.argv.indexOf("--ref");
const ref = refIndex >= 0 ? process.argv[refIndex + 1] : "main";

if (!ref) {
  throw new Error("Usage: npm run sync:oracle -- --ref <branch|tag|commit>");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-apexlang-sync-"));
const checkout = join(temporaryRoot, "oracle-skills");
const stagedSkill = join(temporaryRoot, "apexlang");

async function git(args) {
  return execFileAsync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

try {
  await git(["clone", "--filter=blob:none", "--no-checkout", repository, checkout]);
  await git(["-C", checkout, "sparse-checkout", "set", "--no-cone", "/apex/apexlang/", "/LICENSE.txt"]);
  await git(["-C", checkout, "fetch", "--depth", "1", "origin", ref]);
  await git(["-C", checkout, "checkout", "--detach", "FETCH_HEAD"]);
  const { stdout } = await git(["-C", checkout, "rev-parse", "HEAD"]);
  const commit = stdout.trim();

  await cp(join(checkout, "apex/apexlang"), stagedSkill, { recursive: true });
  const contentSha256 = await directoryDigest(stagedSkill);
  const destination = resolve(root, "skills/apexlang");
  const backup = resolve(root, "skills/.apexlang.previous");
  const metadataPaths = ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "UPSTREAM.json"];
  const originalMetadata = new Map(
    await Promise.all(
      metadataPaths.map(async (relativePath) => [
        relativePath,
        await readFile(resolve(root, relativePath), "utf8")
      ])
    )
  );
  await rm(backup, { recursive: true, force: true });
  await rename(destination, backup);
  try {
    await rename(stagedSkill, destination);
    await cp(join(checkout, "LICENSE.txt"), resolve(root, "LICENSE"));
    const upstream = JSON.parse(await readFile(resolve(root, "UPSTREAM.json"), "utf8"));
    const previousCommit = upstream.commit;
    upstream.commit = commit;
    upstream.content_sha256 = contentSha256;
    await writeFile(resolve(root, "UPSTREAM.json"), `${JSON.stringify(upstream, null, 2)}\n`, "utf8");
    for (const relativePath of ["README.md", "THIRD_PARTY_NOTICES.md"]) {
      const filePath = resolve(root, relativePath);
      const contents = await readFile(filePath, "utf8");
      await writeFile(filePath, contents.replaceAll(previousCommit, commit), "utf8");
    }
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    await rename(backup, destination);
    await Promise.all(
      [...originalMetadata].map(([relativePath, contents]) =>
        writeFile(resolve(root, relativePath), contents, "utf8")
      )
    );
    throw error;
  }
  console.log(`Synced Oracle APEXlang at ${commit}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
