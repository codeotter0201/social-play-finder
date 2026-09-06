import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resultFor } from "./fixtures/analysis.mjs";
import { buildSourceRecord } from "../scripts/prepare.mjs";
import { buildFinalized, finalizeJoined } from "../scripts/finalize.mjs";
import { validateRun } from "../scripts/validate.mjs";
import { assertAnalysisMatchesSource, assertQueryPlan } from "../scripts/lib/validation.mjs";
import { parseCsv } from "../scripts/lib/csv.mjs";
import { browserPlan } from "../scripts/browser-runtime.mjs";
import { filterRows } from "../scripts/lib/query-core.mjs";
import { queryCsv } from "../scripts/query.mjs";
import { extractionContract } from "../scripts/lib/contract.mjs";
import { batchResponseSchema } from "../scripts/codex-extract.mjs";
import { writeJson } from "../scripts/lib/io.mjs";

async function mixed() {
 const raw=JSON.parse(await readFile(new URL("fixtures/raw.json",import.meta.url),"utf8"));
 const post=buildSourceRecord({id:"post_00000000000000000000",rawPost:raw.posts[0],batch:raw.batch,batchId:"batch",sourceFile:"fixture",sourcePostIndex:0});
 const analysis=resultFor(post,"secret").analysis;
 const template=structuredClone(analysis.listings[0]); delete template.evidence;
 const specifications=[
  ["session",null,"mixed_doubles"],
  ["venue_rental",{rental_kind:"transfer",billing_unit:"每面每小時",transfer_terms:"整段接手"},null],
  ["coaching",{coach_name:"陳教練",audience:"初學",course_schedule:"每週六，共八堂",lesson_count:8,class_size:6,billing_unit:"整期"},null],
  ["tournament",{event_name:"秋季賽",divisions:["男雙"],registration_deadline:"2026-09-30",event_end_date:"2026-10-10",billing_unit:"每隊"},"mens_doubles"],
 ];
 analysis.listings=specifications.map(([listing_type,service_details,play_format],listing_index)=>({...structuredClone(template),listing_index,listing_type,service_details,play_format}));
 return {batches:[{id:"batch",source_file:"fixture",raw:raw.batch}],posts:[{...post,analysis}]};
}

test("mixed services publish separately with source links, matching CSVs and independent dedupe",async()=>{
 const joined=await mixed();const docs=buildFinalized(joined);
 assert.equal(docs.result.listings.length,1);
 assert.equal(docs.result.stats.total_records,4);
 for(const name of ["venue_rentals","coaching_courses","tournaments"]){
  const listing=docs.result.tables[name][0];
  assert.equal(listing.source_post_id,joined.posts[0].id);
  assert.equal(listing.dedupe.status,"unique");
  assert.equal(listing.source.post_url,docs.result.listings[0].source.post_url);
  assert.equal(parseCsv(docs.tableFiles[name+".csv"]).rows.length,1);
 }
 assert.equal(parseCsv(docs.csv).rows[0].play_format,"mixed_doubles");
 const dir=await mkdtemp(join(tmpdir(),"fb-classification-"));
 const source=await writeJson(join(dir,"input.json"),joined);await finalizeJoined(source,dir);
 await validateRun(dir);
 const plan=browserPlan({full:true,cancelled:true});await writeJson(join(dir,"query.json"),plan);
 await queryCsv(join(dir,"venue_rentals.csv"),join(dir,"query.json"),join(dir,"rental-search.csv"));
 assert.equal(parseCsv(await readFile(join(dir,"rental-search.csv"),"utf8")).rows.length,1);
 await writeFile(join(dir,"current","tournaments.csv"),"corrupted");
 await assert.rejects(validateRun(dir),/Table tournaments.csv differs/);
});

test("legacy classification stays blank and IDs stable; typed details reject mismatches",async()=>{
 const joined=await mixed();
 joined.posts[0].analysis.listings=joined.posts[0].analysis.listings.slice(0,1);
 const listing=joined.posts[0].analysis.listings[0];
 delete listing.listing_type;delete listing.play_format;delete listing.service_details;
 const legacy=buildFinalized(joined).result.listings[0];
 assert.equal(legacy.play_format,null);assert.equal(legacy.listing_type,null);
 listing.listing_type="session";listing.play_format="doubles";listing.service_details=null;
 assert.equal(buildFinalized(joined).result.listings[0].listing_id,legacy.listing_id);
 listing.play_format=["doubles","singles"];
 assert.throws(()=>buildFinalized(joined),/Invalid LLM result/);
 listing.play_format=null;listing.listing_type="coaching";
 assert.throws(()=>buildFinalized(joined),/details do not match/);
 listing.service_details={rental_kind:"rental",billing_unit:null,transfer_terms:null};
 assert.throws(()=>buildFinalized(joined),/details do not match/);
});

test("pure rental remains included and v4 response contract requires classification",async()=>{
 const joined=await mixed(),post=joined.posts[0];
 post.analysis.listings=[post.analysis.listings[1]];post.analysis.listings[0].listing_index=0;
 assert.doesNotThrow(()=>assertAnalysisMatchesSource({id:post.id,analysis:post.analysis},post.context.text));
 const docs=buildFinalized(joined);assert.equal(docs.result.listings.length,0);assert.equal(docs.result.tables.venue_rentals.length,1);
 const contract=await extractionContract();assert.equal(contract.version,"badminton-extraction-4");
 const schema=batchResponseSchema(contract);
 for(const field of ["listing_type","play_format","service_details"])assert.ok(schema.$defs.listing.required.includes(field));
});

test("play format groups are shared with CLI plans; exact mixed doubles excludes generic and unknown",()=>{
 const rows=[null,"doubles","mens_doubles","womens_doubles","mixed_doubles","singles","mens_singles","womens_singles"].map((play_format,i)=>({listing_id:String(i),play_format}));
 for(const [value,count] of [["doubles",4],["singles",3],["mixed_doubles",1],["",8]]){
  const plan=browserPlan({play_format:value});assertQueryPlan(plan);
  assert.equal(filterRows(rows,plan).length,count);
 }
});

test("v3 refresh compatibility accepts only unchanged previously published tasks",async()=>{
 const {canRefreshV3Publication}=await import('../scripts/lib/contract.mjs');
 const task={contract:{version:'badminton-extraction-3'},task_id:'a',observation_id:'o',context_hash:'c',rules_version:'r',schema_version:'s',model_config_version:'m',analysis:{listings:[]}};
 const previous={id:'a',origin:{observation_id:'o'},extraction:{context_hash:'c',rules_version:'r',schema_version:'s',model_config_version:'m'},analysis:{listings:[]}};
 const current={version:'badminton-extraction-4'};
 assert.equal(canRefreshV3Publication(task,previous,current),true);
 assert.equal(canRefreshV3Publication(task,null,current),false);
 assert.equal(canRefreshV3Publication({...task,analysis:{listings:[{}]}},previous,current),false);
 assert.equal(canRefreshV3Publication({...task,observation_id:'new'},previous,current),false);
 assert.equal(canRefreshV3Publication({...task,rules_version:'different'},previous,current),false);
 assert.equal(canRefreshV3Publication(task,previous,{version:'future'}),false);
});
