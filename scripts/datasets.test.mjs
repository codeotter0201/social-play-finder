import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JSDOM } from "jsdom";
import { openPostArchive } from "./post-archive/archive.mjs";
import { importDataset, readDatasets } from "./datasets.mjs";
import { updateSite } from "./site.mjs";
import { prepareArchive, runEtl } from "../skills/badminton-session-finder/scripts/etl.mjs";
import { resultFor } from "../skills/badminton-session-finder/tests/fixtures/analysis.mjs";
import { readRecords, writeJson, writeJsonl } from "../skills/badminton-session-finder/scripts/lib/io.mjs";
import { parseCsv } from "../skills/badminton-session-finder/scripts/lib/csv.mjs";

const modelConfig = { model: "manual-fixture", version: "1" };

test("dataset import, extraction, publication and site updates preserve regional isolation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "regional-site-"));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const db = join(dir, "posts.sqlite"), configPath = join(dir, "datasets.json"), sitePath = join(dir, "site");
  await writeJson(configPath, {datasets:[{id:"taipei",name:"雙北",batch_ids:[]},{id:"taichung",name:"台中",batch_ids:[]}]});
  const raw = JSON.parse(await readFile(new URL("../skills/badminton-session-finder/tests/fixtures/raw.json", import.meta.url), "utf8"));
  const file = await writeJson(join(dir, "taipei.json"), raw);
  let archive = await openPostArchive(db);
  try {
    await assert.rejects(importDataset(archive, [file], "unknown", {configPath}), /Unknown dataset/);
    assert.equal(archive.latestAll().length, 0);
    await importDataset(archive, [file], "taipei", {configPath});
    assert.equal((await importDataset(archive, [file], "taipei", {configPath})).already_imported, 1);
    await assert.rejects(importDataset(archive, [file], "taichung", {configPath}), /already belongs/);
  } finally { archive.close(); }
  assert.deepEqual((await readDatasets(configPath)).datasets[0].batch_ids, [raw.batch.batch_id]);
  await assert.rejects(prepareArchive(db, join(dir,"empty"), {modelConfig,dataset:"taichung",datasetsPath:configPath}), /no batches/);
  await assert.rejects(runEtl("publish", {db,out:join(dir,"empty-pub"),dataset:"taichung",datasetsPath:configPath}), /no batches/);

  const publish = async id => {
    const run = join(dir, `handoff-${id}`);
    await prepareArchive(db, run, {modelConfig,dataset:id,datasetsPath:configPath});
    const tasks = await readRecords(join(run,"llm_tasks.jsonl"));
    const analyses = tasks.map(task=>resultFor(task,task.context.text.includes("秘密基地")?"secret":"line"));
    const analysis=await writeJsonl(join(run,"results.jsonl"),analyses);
    await runEtl("accept",{db,run,analysis});
    const out=join(dir,id);
    const publication=await runEtl("publish",{db,out,run}); // extract --out uses the frozen handoff too.
    const output=JSON.parse(await readFile(publication.output,"utf8"));
    assert.equal(output.dataset.id,id);
    assert.equal(output.listings.length,2);
    assert.deepEqual(output.listings.map(x=>x.venue.city).sort(),[null,null]); // Dataset does not infer venue city.
    const csv=parseCsv(await readFile(publication.csv,"utf8"));
    assert(csv.rows.every(row=>row.dataset_id===id));
    await updateSite(publication.current,{configPath,sitePath});
    await assert.rejects(runEtl("publish",{db,out,dataset:id==='taipei'?'taichung':'taipei',datasetsPath:configPath}), /different dataset|no batches/);
    return {publication,output,run};
  };
  const taipei=await publish("taipei");
  const taipeiHtml=await readFile(join(sitePath,"taipei/index.html"),"utf8");
  assert.match(await readFile(join(sitePath,"taichung/index.html"),"utf8"),/尚未發布/);
  assert(! (await readFile(join(sitePath,"index.html"),"utf8")).includes('session-data'));
  const second=structuredClone(raw);second.batch.batch_id="taichung-batch";
  for(const post of second.posts) { post.post_id+='-tc';post.post_url+='tc'; }
  const secondFile=await writeJson(join(dir,"taichung.json"),second);
  archive=await openPostArchive(db);
  try { await importDataset(archive,[secondFile],"taichung",{configPath}); } finally { archive.close(); }
  const taichung=await publish("taichung");
  assert.equal(await readFile(join(sitePath,"taipei/index.html"),"utf8"),taipeiHtml);
  assert(!taipei.output.listings.some(a=>taichung.output.listings.some(b=>a.listing_id===b.listing_id)));
  const dom=new JSDOM(await readFile(join(sitePath,"taichung/index.html"),"utf8"),{runScripts:"dangerously",url:"https://example.com/repo/taichung/index.html"});
  assert.equal(dom.window.document.querySelector('nav[aria-label="地區"] [aria-current]').textContent,'台中');
  assert.match(dom.window.document.querySelector('h1').textContent,/台中/);
  assert.equal(dom.window.document.querySelector('nav[aria-label="地區"] a[href="../taipei/index.html"]').href,'https://example.com/repo/taipei/index.html');
  dom.window.close();
  const cumulative=await runEtl("publish",{db,out:join(dir,"taipei"),dataset:"taipei",datasetsPath:configPath,refresh:true});
  assert.equal(cumulative.tasks.total,2);
  await updateSite(join(dir,"taipei"),{configPath,sitePath}); // Publication root resolves current once too.
  assert.match(await readFile(join(sitePath,"taichung/index.html"),"utf8"),/session-data/);
  // A new batch of the same region accumulates without erasing prior memberships.
  const later=structuredClone(raw);later.batch.batch_id="taipei-later";
  const laterFile=await writeJson(join(dir,"later.json"),later);
  archive=await openPostArchive(db);
  try { await importDataset(archive,[laterFile],"taipei",{configPath}); } finally { archive.close(); }
  assert.equal((await readDatasets(configPath)).datasets[0].batch_ids.length,2);
  await assert.rejects(prepareArchive(db,taipei.run,{modelConfig,dataset:"taipei",datasetsPath:configPath}),/Dataset selection changed/);
});

test("dataset config rejects duplicate memberships and unsafe page paths", async t => {
  const dir=await mkdtemp(join(tmpdir(),"dataset-config-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const path=join(dir,"datasets.json");
  await writeFile(path,JSON.stringify({datasets:[{id:"../escape",name:"x",batch_ids:[]}]}));
  await assert.rejects(readDatasets(path),/Invalid or duplicate/);
  await writeFile(path,JSON.stringify({datasets:[{id:"a",name:"A",batch_ids:["same"]},{id:"b",name:"B",batch_ids:["same"]}]}));
  await assert.rejects(readDatasets(path),/multiply assigned/);
});
