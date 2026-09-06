import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DATASETS_PATH = new URL("../datasets.json", import.meta.url);

export async function readDatasets(path = DATASETS_PATH) {
  const config = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(config.datasets) || !config.datasets.length) throw new Error("datasets must be a non-empty array");
  const ids = new Set(), batches = new Set();
  for (const dataset of config.datasets) {
    if (!/^[a-z][a-z0-9-]*$/.test(dataset.id) || ids.has(dataset.id)) throw new Error("Invalid or duplicate dataset ID");
    if (typeof dataset.name !== "string" || !dataset.name.trim() || !Array.isArray(dataset.batch_ids)) throw new Error(`Invalid dataset: ${dataset.id}`);
    ids.add(dataset.id);
    for (const id of dataset.batch_ids) {
      if (typeof id !== "string" || !id.trim() || batches.has(id)) throw new Error(`Invalid or multiply assigned batch: ${id}`);
      batches.add(id);
    }
  }
  return config;
}

export function getDataset(config, id, { requireBatches = false } = {}) {
  const dataset = config.datasets.find(item => item.id === id);
  if (!dataset) throw new Error(`Unknown dataset: ${id}`);
  if (requireBatches && !dataset.batch_ids.length) throw new Error(`Dataset ${id} has no batches; import with --dataset ${id} first`);
  return dataset;
}

export async function importDataset(archive, paths, id, { configPath = DATASETS_PATH, ...options } = {}) {
  const config = await readDatasets(configPath);
  const dataset = getDataset(config, id);
  const batches = await Promise.all(paths.map(async path => {
    const raw = JSON.parse(await readFile(path, "utf8"));
    const batch = raw.batch?.batch_id;
    if (typeof batch !== "string" || !batch.trim()) throw new Error(`${path}: batch_id is required`);
    const owner = config.datasets.find(item => item.id !== id && item.batch_ids.includes(batch));
    if (owner) throw new Error(`Batch ${batch} already belongs to ${owner.id}`);
    return batch;
  }));
  const result = archive.importFiles(paths, options);
  dataset.batch_ids = [...new Set([...dataset.batch_ids, ...batches])];
  const temp = join(dirname(configPath instanceof URL ? fileURLToPath(configPath) : resolve(configPath)), `.datasets-${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n");
  await rename(temp, configPath);
  return { ...result, dataset: { id: dataset.id, name: dataset.name }, batch_ids: batches };
}

export function datasetPostKeys(archive, dataset) {
  if (!dataset.batch_ids.length) throw new Error(`Dataset ${dataset.id} has no batches`);
  const keys = new Set();
  for (const batch of dataset.batch_ids) {
    const rows = archive.rows("SELECT DISTINCT post_key FROM post_observations WHERE batch_id=$batch", { $batch: batch });
    if (!rows.length) throw new Error(`Unknown or empty batch: ${batch}`);
    for (const row of rows) keys.add(row.post_key);
  }
  return keys;
}
