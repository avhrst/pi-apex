import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export async function directoryDigest(root) {
  const hash = createHash("sha256");

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported vendored entry type: ${relativePath}`);
      }
      const contents = await readFile(absolutePath);
      hash.update(`file\0${relativePath}\0${contents.length}\0`);
      hash.update(contents);
      hash.update("\0");
    }
  }

  await walk(root);
  return hash.digest("hex");
}
