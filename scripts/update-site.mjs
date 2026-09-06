import { copyFile, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error("Usage: npm run site:update -- <publication-directory>/current");
  process.exit(1);
}

// Resolve current once so the snapshot belongs to one immutable release.
const release = await realpath(args[0]);
const source = await realpath(join(release, "index.html"));
const destination = fileURLToPath(new URL("../site/", import.meta.url));
await mkdir(destination, { recursive: true });
await copyFile(source, join(destination, "index.html"));
console.log(`Updated site/index.html from ${source}`);
