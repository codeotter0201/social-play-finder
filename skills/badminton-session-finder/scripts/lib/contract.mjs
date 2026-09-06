import { readFile } from "node:fs/promises";
import { hashId } from "./ids.mjs";

export async function extractionContract(modelConfig = { mode: "manual", model: "unspecified", version: "manual-unspecified" }) {
  if (!modelConfig || typeof modelConfig.model !== "string" || !modelConfig.model.trim() || typeof modelConfig.version !== "string" || !modelConfig.version.trim()) {
    throw new Error("Model configuration requires model and version strings; include decoding settings used for this handoff (no credentials)");
  }
  const names = ["extraction-mode.md", "extraction.schema.json", "extraction-examples.md"];
  const texts = await Promise.all(names.map((name) => readFile(new URL(`../../references/${name}`, import.meta.url), "utf8")));
  const files = Object.fromEntries(names.map((name, index) => [name, texts[index]]));
  return {
    version: "badminton-extraction-4",
    rules_version: hashId("rules", [files["extraction-mode.md"], files["extraction-examples.md"]]),
    schema_version: hashId("schema", [JSON.parse(files["extraction.schema.json"])]),
    model_config_version: hashId("model", [modelConfig]),
    model_config: modelConfig,
    files,
  };
}

// v4 adds nullable classification to already published v3 records. This only
// permits explicit presentation refresh; it never accepts a new old-contract task.
export function canRefreshV3Publication(task, published, current) {
  return current.version === "badminton-extraction-4"
    && task.contract.version === "badminton-extraction-3"
    && published?.id === task.task_id
    && published.origin?.observation_id === task.observation_id
    && ["context_hash", "rules_version", "schema_version", "model_config_version"].every(key => published.extraction?.[key] === task[key])
    && hashId("analysis", [published.analysis]) === hashId("analysis", [task.analysis]);
}
