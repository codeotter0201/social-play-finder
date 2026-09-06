import { updateSite } from "./site.mjs";

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error("Usage: npm run site:update -- <dataset-publication-directory>/current");
  process.exit(1);
}
try {
  console.log(JSON.stringify(await updateSite(args[0]), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
