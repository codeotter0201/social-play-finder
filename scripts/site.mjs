import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDatasets, getDataset, DATASETS_PATH } from "./datasets.mjs";
import { buildBrowser, escapeHtml } from "../skills/badminton-session-finder/scripts/browser.mjs";
import { validateRun } from "../skills/badminton-session-finder/scripts/validate.mjs";

const SITE_PATH = fileURLToPath(new URL("../site/", import.meta.url));

function entryPage(datasets, published, current = null) {
  const title = current ? `${current.name}場次` : "選擇地區";
  const prefix = current ? "../" : "./";
  const links = datasets.map(dataset => {
    const info = published.get(dataset.id);
    return `<a href="${prefix}${encodeURIComponent(dataset.id)}/index.html"><strong>${escapeHtml(dataset.name)}</strong><span>${info ? `${info.stats.listings} 筆場次 · 更新 ${escapeHtml(info.generated_at.slice(0, 10))}` : "尚未發布"}</span></a>`;
  }).join("");
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}｜場次瀏覽</title><style>
*{box-sizing:border-box}body{margin:0;background:#fafbf9;color:#20342d;font:16px/1.6 system-ui,sans-serif}main{max-width:760px;margin:auto;padding:48px 24px}h1{font-size:28px}p,span{color:#64746c}nav{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:28px}nav a{display:flex;flex-direction:column;gap:8px;background:white;border:1px solid #d8e1da;border-radius:10px;padding:24px;text-decoration:none;color:#217254}a:focus-visible{outline:2px solid #217254;outline-offset:3px}strong{font-size:22px}span{font-size:14px}.home{color:#217254}
</style></head><body><main>${current ? '<a class="home" href="../index.html">← 所有地區</a>' : ""}<h1>${escapeHtml(title)}</h1><p>${current ? "此地區尚未發布場次，請先瀏覽其他地區。" : "選擇想找場次的地區，各區資料分開載入。"}</p><p>地區依來源資料集分類；實際地點請查看場館資訊。</p><nav aria-label="地區">${links}</nav></main></body></html>\n`;
}

export async function updateSite(publicationDirectory, { configPath = DATASETS_PATH, sitePath = SITE_PATH } = {}) {
  const config = await readDatasets(configPath);
  // Resolve once: validation, JSON and CSV must all belong to the same release.
  const release = await realpath(join(publicationDirectory, "current")).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return realpath(publicationDirectory);
  });
  const validation = await validateRun(release);
  const result = JSON.parse(await readFile(join(release, "output_result.json"), "utf8"));
  if (!result.dataset) throw new Error("Publication has no dataset; publish with --dataset before updating the site");
  const dataset = getDataset(config, result.dataset.id);
  if (!result.dataset.batch_ids.every(id => dataset.batch_ids.includes(id))) throw new Error("Publication batches no longer belong to this dataset");
  const csv = await readFile(join(release, "output_result.csv"), "utf8");
  const destination = join(sitePath, dataset.id);
  await mkdir(destination, { recursive: true });
  const temporary = join(destination, ".index.tmp");
  await buildBrowser(result, csv, temporary, { datasets: config.datasets });
  await rename(temporary, join(destination, "index.html"));

  const published = new Map();
  for (const item of config.datasets) {
    let html;
    try { html = await readFile(join(sitePath, item.id, "index.html"), "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; continue; }
    const embedded = html.match(/<script type="application\/json" id="session-data">([\s\S]*?)<\/script>/);
    if (embedded) published.set(item.id, JSON.parse(embedded[1]).result);
  }
  for (const item of config.datasets) {
    if (published.has(item.id)) continue;
    await mkdir(join(sitePath, item.id), { recursive: true });
    await writeFile(join(sitePath, item.id, "index.html"), entryPage(config.datasets, published, item));
  }
  await writeFile(join(sitePath, "index.html"), entryPage(config.datasets, published));
  return { dataset: dataset.id, page: join(destination, "index.html"), listings: result.stats.listings, partial: validation.partial };
}
