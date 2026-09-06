import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

export async function writeJson(path, value) {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return outputPath;
}

export async function readRecords(path) {
  const raw = await readFile(resolve(path), "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.results)) return parsed.results;
    if (parsed && typeof parsed === "object") return [parsed];
    throw new Error("JSON input must be an object, array, or contain results[]");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return raw.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (lineError) {
        throw new Error(`Invalid JSONL at line ${index + 1}: ${lineError.message}`);
      }
    });
  }
}

export async function writeJsonl(path, records) {
  const outputPath = resolve(path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return outputPath;
}
