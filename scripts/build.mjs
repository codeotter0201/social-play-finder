import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await Promise.all([
  build({ entryPoints: ["src/background/index.ts"], outfile: "dist/background.js", bundle: true, format: "esm", target: "chrome120" }),
  build({ entryPoints: ["src/content/index.ts"], outfile: "dist/content.js", bundle: true, format: "iife", target: "chrome120" }),
  build({ entryPoints: ["src/popup/index.ts"], outfile: "dist/popup.js", bundle: true, format: "esm", target: "chrome120" }),
]);

await Promise.all([
  cp("src/manifest.json", "dist/manifest.json"),
  cp("src/popup/index.html", "dist/popup.html"),
  cp("src/popup/styles.css", "dist/popup.css"),
]);
