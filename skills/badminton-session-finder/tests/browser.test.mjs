import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import { buildFinalized } from "../scripts/finalize.mjs";
import { buildBrowser } from "../scripts/browser.mjs";
import { browserPlan, compareBrowserRows, mountBrowser, safeLink } from "../scripts/browser-runtime.mjs";
import { filterRows } from "../scripts/lib/query-core.mjs";
import { buildSourceRecord } from "../scripts/prepare.mjs";
import { parseCsv } from "../scripts/lib/csv.mjs";
import { queryCsv } from "../scripts/query.mjs";
import { writeJson } from "../scripts/lib/io.mjs";
import { resultFor } from "./fixtures/analysis.mjs";

async function fixture() {
  const raw = JSON.parse(await readFile(new URL("fixtures/raw.json", import.meta.url), "utf8"));
  const posts = raw.posts.map((rawPost, index) => {
    const id = `post_${String(index + 1).padStart(20, "0")}`;
    const post = buildSourceRecord({ id, rawPost, batch: raw.batch, batchId: "batch", sourceFile: "fixture", sourcePostIndex: index });
    return { ...post, analysis: resultFor({ id }, index ? "line" : "secret").analysis };
  });
  posts[0].raw.content_text += '\n<img src=x onerror="globalThis.attacked=true"></script><script>globalThis.attacked=true</script>';
  const documents = buildFinalized({ batches: [{ id: "batch", raw: raw.batch }], posts });
  const directory = await mkdtemp(join(tmpdir(), "badminton-browser-"));
  const path = join(directory, "index.html"); await buildBrowser(documents.result, documents.csv, path);
  const html = await readFile(path, "utf8");
  return { ...documents, directory, html, rows: parseCsv(documents.csv).rows };
}

test("A11,A12: real generated page uses full collection, clear, zero results, conditional filters and safe text", async () => {
  const f = await fixture();
  const dom = new JSDOM(f.html, { runScripts: "dangerously", url: "https://local.example/index.html" });
  const document = dom.window.document;
  const $ = (id) => document.getElementById(id);
  const ids = () => [...document.querySelectorAll("tbody tr[data-listing-id]")].map((row) => row.dataset.listingId).sort();
  assert.equal($("error").hidden, true);
  assert.equal(ids().length, 2); assert.equal(dom.window.attacked, undefined);
  assert.equal(document.querySelector("tbody img"), null);
  assert.match(document.querySelector("tbody").textContent, /<img src=x/);
  const input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new dom.window.Event("input", { bubbles: true })); };
  input("fee", "0"); assert.equal(ids().length, 0); assert.match($("summary").textContent, /沒有符合/);
  input("fee", "250"); assert.equal(ids().length, 1);
  input("beginner", "true"); assert.equal(ids().length, 0);
  $("filters").reset(); await new Promise((done) => setTimeout(done, 0)); assert.equal(ids().length, 2);
  input("q", "板橋"); assert.equal(ids().length, 1);
  $("filters").reset(); await new Promise((done) => setTimeout(done, 0));
  input("date", "2026-09-02"); input("weekday", "1");
  assert.equal(ids().length, 2); // one explicit date OR the weekly Monday group
  input("dateMode", "all"); assert.equal(ids().length, 0);
  dom.window.close();
});

test("A11: identical page and CLI plans produce identical listing ID sets", async () => {
  const f = await fixture();
  const { writeFile } = await import("node:fs/promises");
  const csv = join(f.directory, "output_result.csv"); await writeFile(csv, f.csv);
  for (const [index, values] of [
    {}, { date: "2026-09-02", weekday: "1" }, { date: "2026-09-02", weekday: "1", dateMode: "all" },
    { fee: "250" }, { q: "板橋", from: "14:00" }, { beginner: "true" }, { full: true, cancelled: true, duplicates: true },
  ].entries()) {
    const plan = browserPlan(values); const planPath = await writeJson(join(f.directory, `plan-${index}.json`), plan);
    const result = await queryCsv(csv, planPath, join(f.directory, `result-${index}.csv`));
    const cli = parseCsv(await readFile(result.csv, "utf8")).rows;
    assert.deepEqual(cli.map((row) => row.listing_id).sort(), filterRows(f.rows, plan).map((row) => row.listing_id).sort());
  }
});

test("A12: free is zero, missing last, unknown level stays unknown, defaults hide full/cancelled/duplicates", () => {
  const row = (id, changes = {}) => ({ listing_id: id, date: "2026-09-05", start_time: "23:00", end_time: "01:00", end_day_offset: "1", fee_min_twd: "", venue_name: "", scraped_at: "", status: "open", dedupe_status: "unique", beginner_friendly: "", ...changes });
  const rows = [row("unknown"), row("free", { fee_min_twd: "0" }), row("paid", { fee_min_twd: "200", beginner_friendly: "true" }), row("full", { status: "full" }), row("cancelled", { status: "cancelled" }), row("duplicate", { dedupe_status: "duplicate" })];
  assert.deepEqual(filterRows(rows, browserPlan({})).map((r) => r.listing_id), ["unknown", "free", "paid"]);
  assert.deepEqual(filterRows(rows, browserPlan({ fee: "0" })).map((r) => r.listing_id), ["free"]);
  assert.deepEqual(filterRows(rows, browserPlan({ beginner: "true" })).map((r) => r.listing_id), ["paid"]);
  assert.deepEqual(rows.slice(0, 3).sort((a, b) => compareBrowserRows(a, b, "fee")).map((r) => r.listing_id), ["free", "paid", "unknown"]);
  const times = [row("weekly", { date: "", recurrence_weekdays: "6" }), row("dated"), row("undated", { date: "", start_time: "" }), row("missing-start", { start_time: "" })];
  assert.deepEqual(times.sort((a, b) => compareBrowserRows(a, b, "timeDesc")).map((r) => r.listing_id), ["dated", "missing-start", "weekly", "undated"]);
  assert.equal(safeLink("javascript:alert(1)"), null); assert.equal(safeLink("data:text/html,x"), null);
});

test("page shows load errors for inconsistent publication data", async () => {
  const f = await fixture(); const dom = new JSDOM(f.html);
  dom.window.document.getElementById("session-data").textContent = '{"result":{},"rows":[]}';
  assert.equal(mountBrowser(dom.window.document), null);
  assert.equal(dom.window.document.getElementById("error").hidden, false);
  dom.window.close();
});

test("date groups keep sessions together, headers sort, prices are numeric and original text links to the post", async () => {
  const f = await fixture();
  const dom = new JSDOM(f.html, { runScripts: "dangerously", url: "https://local.example" });
  const d = dom.window.document;
  assert.equal(d.querySelector("#sort"), null);
  d.getElementById("view-grouped").click();
  assert.equal(d.querySelectorAll("tr.date-group").length, 2);
  const fees = [...d.querySelectorAll("tr[data-listing-id] .fee-amount")].map(cell => cell.textContent);
  assert.deepEqual(fees, ["", "250"]);
  const button = d.querySelector('[data-sort="fee"]'); button.click();
  assert.equal(button.parentElement.getAttribute("aria-sort"), "ascending");
  button.click(); assert.equal(button.parentElement.getAttribute("aria-sort"), "descending");
  assert.ok(d.querySelector('a.original-post[href^="https://www.facebook.com/"] pre'));
  assert.equal(d.querySelectorAll("tr.date-group").length, 2);
  assert.equal(d.querySelectorAll(".row-date").length, 0);
  assert.equal(d.getElementById("view-grouped").getAttribute("aria-pressed"), "true");
  d.getElementById("view-flat").click();
  d.querySelector('[data-sort="time"]').click();
  assert.equal(d.querySelectorAll("tr.date-group").length, 0);
  assert.equal(d.querySelectorAll(".row-date").length, 2);
  d.getElementById("view-grouped").click();
  assert.equal(button.parentElement.getAttribute("aria-sort"), "descending");
  d.getElementById("view-flat").click();
  assert.equal(d.querySelector('[data-sort="time"]').parentElement.getAttribute("aria-sort"), "ascending");
  dom.window.close();
});

test("sorting stays within date groups with numeric fees and unknown prices last", async () => {
  const { compareGroupedRows } = await import("../scripts/browser-runtime.mjs");
  const rows = [
    { listing_id: "a", date: "2026-09-02", start_time: "20:00", fee_min_twd: "100" },
    { listing_id: "b", date: "2026-09-02", start_time: "10:00", fee_min_twd: "20" },
    { listing_id: "c", date: "2026-09-01", start_time: "12:00", fee_min_twd: "500" },
    { listing_id: "d", date: "2026-09-02", start_time: "09:00", fee_min_twd: "" },
  ];
  assert.deepEqual([...rows].sort((a,b) => compareGroupedRows(a,b)).map(r=>r.listing_id), ["c","d","b","a"]);
  assert.deepEqual([...rows].sort((a,b) => compareGroupedRows(a,b,"fee")).map(r=>r.listing_id), ["c","b","a","d"]);
  assert.deepEqual([...rows].sort((a,b) => compareGroupedRows(a,b,"fee",true)).map(r=>r.listing_id), ["c","a","b","d"]);
});


test("ungrouped sorting compares the selected field across all dates, with unknowns last", async () => {
  const { compareUngroupedRows } = await import("../scripts/browser-runtime.mjs");
  const rows = [
    { listing_id: "early", date: "2026-09-01", start_time: "20:00", fee_min_twd: "300" },
    { listing_id: "late", date: "2026-09-05", start_time: "09:00", fee_min_twd: "50" },
    { listing_id: "tie", date: "2026-09-03", start_time: "12:00", fee_min_twd: "50" },
    { listing_id: "unknown", date: "2026-08-01", start_time: "", fee_min_twd: "" },
  ];
  const sorted = (field, descending = false) => [...rows].sort((a,b) => compareUngroupedRows(a,b,field,descending)).map(r=>r.listing_id);
  assert.deepEqual(sorted("fee"), ["tie","late","early","unknown"]);
  assert.deepEqual(sorted("fee",true), ["early","tie","late","unknown"]);
  assert.deepEqual(sorted("time"), ["late","tie","early","unknown"]);
});

test("date sorting is independent of clock time and keeps weekly dates first and unknown dates last", async () => {
  const { compareUngroupedRows } = await import("../scripts/browser-runtime.mjs");
  const rows = [
    {listing_id:"late",date:"2026-09-05",start_time:"09:00"},
    {listing_id:"early",date:"2026-09-01",start_time:"20:00"},
    {listing_id:"weekly",date:"",recurrence_weekdays:"6",start_time:"08:00"},
    {listing_id:"unknown",date:"",recurrence_weekdays:"",start_time:"07:00"},
  ];
  assert.deepEqual([...rows].sort((a,b)=>compareUngroupedRows(a,b,"date")).map(r=>r.listing_id),["weekly","early","late","unknown"]);
  assert.deepEqual([...rows].sort((a,b)=>compareUngroupedRows(a,b,"date",true)).map(r=>r.listing_id),["weekly","late","early","unknown"]);
});

test("selection survives filters and exclusion; copy includes source once and clipboard failure offers fallback", async () => {
  const f = await fixture();
  const dom = new JSDOM(f.html, {runScripts:"dangerously",url:"https://local.example"});
  const d=dom.window.document, $=id=>d.getElementById(id);
  const pick=d.querySelector('#rows tr[data-listing-id]');pick.click();
  assert.equal($("selection-panel").hidden,false);
  assert.equal(d.querySelectorAll('#selection-rows details[open]').length,1);
  assert.equal(d.querySelectorAll('#selection-rows .selection-card').length,1);
  $("q").value="no-match-xyz";$("q").dispatchEvent(new dom.window.Event("input",{bubbles:true}));
  assert.equal(d.querySelectorAll('#rows tr[data-listing-id]').length,0);
  assert.equal(d.querySelectorAll('#selection-rows .selection-card').length,1);
  $("copy-selection").click();await new Promise(r=>setTimeout(r,0));
  assert.equal($("copy-fallback").hidden,false);
  assert.match($("copy-text").value,/原文：/);
  let copied;
  Object.defineProperty(dom.window.navigator,"clipboard",{value:{writeText:async text=>{copied=text;}}});
  $("copy-selection").click();await new Promise(r=>setTimeout(r,0));assert.equal(copied,$("copy-text").value);
  $("filters").reset();await new Promise(r=>setTimeout(r,0));assert.equal(d.querySelector('#rows tr[data-listing-id]').getAttribute('aria-selected'),'true');
  $("clear-selection").click();assert.equal($("selection-bar").hidden,true);assert.equal(d.querySelectorAll('#rows tr.is-selected').length,0);
  dom.window.close();
});

test("excluding author adds a removable condition, preserves chosen rows and exports matching CLI filters", async () => {
  const f=await fixture();const setupDom=new JSDOM(f.html);
  const data=JSON.parse(setupDom.window.document.getElementById("session-data").textContent);
  // Both different people have the same display name; only the URL identifies them.
  data.result.source_posts.forEach(post=>{post.raw.is_anonymous=false;});
  data.result.listings.forEach((listing,i)=>{listing.source.author_name="同名作者";listing.source.author_url=`https://www.facebook.com/profile.php?id=${100+i}`;data.rows[i].author_url=listing.source.author_url;});
  const scriptData=setupDom.window.document.getElementById("session-data");scriptData.textContent=JSON.stringify(data).replace(/</g,"\\u003c");
  const dom=new JSDOM(setupDom.serialize(),{runScripts:"dangerously"});setupDom.window.close();
  const d=dom.window.document;
  d.querySelector('#rows tr[data-listing-id]').click();d.querySelector('[data-exclude-author]').click();
  assert.equal(d.querySelectorAll('#rows tr[data-listing-id]').length,1);
  assert.equal(d.querySelectorAll('#author-filters button').length,1);
  assert.match(d.getElementById('selection-rows').textContent,/已排除此作者/);
  d.querySelector('#author-filters button').click();assert.equal(d.querySelectorAll('#rows tr[data-listing-id]').length,2);
  d.querySelector('[data-exclude-author]').click();d.getElementById('filters').reset();await new Promise(r=>setTimeout(r,0));
  assert.equal(d.querySelectorAll('#author-filters button').length,0);assert.equal(d.querySelectorAll('#rows tr.is-selected').length,1);
  const plan=browserPlan({full:true,cancelled:true,excludedAuthorUrls:[data.rows[0].author_url]});
  assert.deepEqual(filterRows(data.rows,plan).map(r=>r.listing_id),[data.rows[1].listing_id]);
  dom.window.close();
});

test("UI enforces selection count and full-copy length without truncating source text",async()=>{
 const f=await fixture();const base=new JSDOM(f.html);const el=base.window.document.getElementById('session-data');const data=JSON.parse(el.textContent);
 const listing=data.result.listings[0],row=data.rows[0];data.result.listings=[];data.rows=[];
 for(let i=0;i<51;i++){
  const l=structuredClone(listing);l.listing_id=`limit-${i}`;l.source_post_id=`source-${i}`;l.source.post_key=`post-${i}`;
  if(i===0)l.raw_text='文'.repeat(100000);
  data.result.listings.push(l);data.rows.push({...row,listing_id:l.listing_id});
 }
 el.textContent=JSON.stringify(data).replace(/</g,'\\u003c');const dom=new JSDOM(base.serialize(),{runScripts:'dangerously'});base.window.close();const d=dom.window.document;
 const picks=[...d.querySelectorAll('#rows tr[data-listing-id]')];picks[0].click();assert.equal(d.getElementById('copy-selection').disabled,true);
 assert.equal(d.querySelector('#selection-rows pre').textContent.length,100000);
 picks[0].click();for(let i=1;i<51;i++)picks[i].click();
 assert.equal(d.querySelectorAll('#rows tr.is-selected').length,50);
 picks[0].click();assert.equal(picks[0].getAttribute('aria-selected'),'false');assert.match(d.getElementById('selection-message').textContent,/最多選取 50/);
 assert.equal(d.getElementById('copy-selection').disabled,false);dom.window.close();
});

test("whole-row selection excludes interactive elements and text selection, and supports keyboard",async()=>{
 const f=await fixture();const dom=new JSDOM(f.html,{runScripts:'dangerously'});const d=dom.window.document;
 assert.equal(d.querySelectorAll('#rows input[type="checkbox"]').length,0);
 assert.equal(d.querySelector('.pick-heading'),null);
 const row=d.querySelector('#rows tr[data-listing-id]');
 row.querySelector('.time').click();assert.equal(row.getAttribute('aria-selected'),'true');
 const toggle=row.querySelector('.details-toggle');
 assert.equal(toggle.getAttribute('aria-expanded'),'false');
 toggle.click();assert.equal(row.getAttribute('aria-selected'),'true');
 assert.equal(toggle.getAttribute('aria-expanded'),'true');assert.equal(row.querySelector('.contact-details').hidden,false);
 row.querySelector('.contact-details p').click();assert.equal(row.getAttribute('aria-selected'),'true');
 toggle.click();assert.equal(row.querySelector('.contact-details').hidden,true);
 assert.equal(row.querySelector('.author-menu'),null);
 for(const link of row.querySelectorAll('.primary-links > *'))assert.match(link.textContent,/↗$/);
 const a=row.querySelector('a');a.addEventListener('click',e=>e.preventDefault());a.click();assert.equal(row.getAttribute('aria-selected'),'true');
 const range=d.createRange();range.selectNodeContents(row.querySelector('.time'));dom.window.getSelection().addRange(range);
 row.click();assert.equal(row.getAttribute('aria-selected'),'true');dom.window.getSelection().removeAllRanges();
 row.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}));assert.equal(row.getAttribute('aria-selected'),'false');
 row.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.equal(row.getAttribute('aria-selected'),'true');
 row.click();assert.equal(row.getAttribute('aria-selected'),'false');
 dom.window.close();
});

test("author name opens one dismissible filter popover without selecting a session", async()=>{
 const f=await fixture();const dom=new JSDOM(f.html,{runScripts:'dangerously'});const d=dom.window.document;
 const triggers=[...d.querySelectorAll('.author-trigger')];assert.ok(triggers.length>=2);
 const popup=t=>d.getElementById(t.getAttribute('aria-controls'));
 triggers[0].click();assert.equal(popup(triggers[0]).hidden,false);
 assert.equal(triggers[0].closest('tr').getAttribute('aria-selected'),'false');
 triggers[1].click();assert.equal(popup(triggers[0]).hidden,true);assert.equal(popup(triggers[1]).hidden,false);
 d.body.click();assert.equal(popup(triggers[1]).hidden,true);
 triggers[0].click();d.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'}));
 assert.equal(popup(triggers[0]).hidden,true);assert.equal(d.activeElement,triggers[0]);
 triggers[0].click();triggers[0].click();assert.equal(popup(triggers[0]).hidden,true);
 triggers[0].click();popup(triggers[0]).querySelector('button').click();
 assert.equal(d.querySelectorAll('.author-chip').length,1);assert.equal(d.querySelectorAll('tr.is-selected').length,0);
 dom.window.close();
});

test("scroll controls follow page boundaries independent of selection and avoid selection bar",async()=>{
 const f=await fixture();const dom=new JSDOM(f.html,{runScripts:'dangerously'});const d=dom.window.document,w=dom.window;
 let height=2000,y=0;
 Object.defineProperty(d.documentElement,'scrollHeight',{get:()=>height});
 Object.defineProperty(w,'innerHeight',{value:800,configurable:true});
 Object.defineProperty(w,'scrollY',{get:()=>y});
 const update=()=>w.dispatchEvent(new w.Event('scroll'));
 const top=d.getElementById('scroll-top'),bottom=d.getElementById('scroll-bottom');
 update();assert.equal(top.hidden,true);assert.equal(bottom.hidden,false);
 y=500;update();assert.equal(top.hidden,false);assert.equal(bottom.hidden,false);
 y=1200;update();assert.equal(top.hidden,false);assert.equal(bottom.hidden,true);
 let target;w.matchMedia=()=>({matches:true});w.scrollTo=options=>{target=options};
 top.click();assert.deepEqual({...target},{top:0,behavior:'instant'});
 y=0;update();bottom.click();assert.equal(target.top,1200);
 const bar=d.getElementById('selection-bar');bar.hidden=false;bar.getBoundingClientRect=()=>({height:120});
 update();assert.equal(d.getElementById('scroll-navigation').style.bottom,'136px');
 height=600;update();assert.equal(top.hidden,true);assert.equal(bottom.hidden,true);
 dom.window.close();
});

test("active filter chips clear only their own condition and keep selected sessions",async()=>{
 const f=await fixture();const dom=new JSDOM(f.html,{runScripts:'dangerously'});const d=dom.window.document,w=dom.window;
 const $=id=>d.getElementById(id);
 assert.deepEqual([...d.querySelectorAll('.filters input,.filters select')].map(e=>e.id),['q','play_format','beginner','fee','from','date','weekday','dateMode']);
 d.querySelector('#rows tr[data-listing-id]').click();
 const set=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event('input',{bubbles:true}));};
 set('q','板橋');set('fee','0');set('from','12:00');set('beginner','false');
 assert.match(d.querySelector('[data-clear-filter="fee"]').textContent,/≤ 0/);
 assert.match(d.querySelector('[data-clear-filter="from"]').textContent,/12:00 起/);
 d.querySelector('[data-clear-filter="q"]').click();
 assert.equal($('q').value,'');assert.equal($('fee').value,'0');assert.equal($('from').value,'12:00');
 assert.equal(d.querySelectorAll('.selection-card').length,1);
 set('date','2026-09-06');set('weekday','0');set('dateMode','all');
 assert.ok(d.querySelector('[data-clear-filter="dateMode"]'));
 d.querySelector('[data-clear-filter="dateMode"]').click();assert.equal($('dateMode').value,'any');
 assert.equal($('date').value,'2026-09-06');assert.equal($('weekday').value,'0');
 $('duplicates').checked=true;$('duplicates').dispatchEvent(new w.Event('change',{bubbles:true}));
 d.querySelector('[data-clear-filter="duplicates"]').click();assert.equal($('duplicates').checked,false);
 $('filters').reset();await new Promise(r=>setTimeout(r,0));
 assert.equal(d.querySelectorAll('.filter-chip').length,0);assert.equal(d.querySelectorAll('.selection-card').length,1);
 dom.window.close();
});

test("play format displays, filters as one choice, copies, and clears through its chip",async()=>{
 const f=await fixture();
 f.result.listings[0].play_format="mixed_doubles";f.rows[0].play_format="mixed_doubles";
 f.result.listings[1].play_format="singles";f.rows[1].play_format="singles";
 const base=new JSDOM(f.html);base.window.document.getElementById('session-data').textContent=JSON.stringify({result:f.result,rows:f.rows,csv:f.csv}).replace(/</g,'\\u003c');
 const dom=new JSDOM(base.serialize(),{runScripts:'dangerously'});base.window.close();const d=dom.window.document;
 const select=d.getElementById('play_format');assert.equal(select.multiple,false);
 select.value="doubles";select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
 const rows=d.querySelectorAll('#rows tr[data-listing-id]');assert.equal(rows.length,1);
 assert.equal(rows[0].querySelector('.play-format').textContent,"混雙");
 rows[0].click();assert.match(d.querySelector('.selection-facts').textContent,/玩法混雙/);
 d.getElementById('copy-selection').click();await new Promise(r=>setTimeout(r,0));
 assert.match(d.getElementById('copy-text').value,/混雙/);
 d.querySelector('[data-clear-filter="play_format"]').click();assert.equal(select.value,"");
 assert.equal(d.querySelectorAll('#rows tr[data-listing-id]').length,2);
 assert.equal(d.querySelectorAll('.selection-card').length,1);
 dom.window.close();
});

test('sortable headers cycle ascending, descending, none independently in both modes',async()=>{
 const f=await fixture();const dom=new JSDOM(f.html,{runScripts:'dangerously'});const d=dom.window.document;
 assert.equal(d.querySelector('[data-sort="contact"]'),null);
 assert.equal(d.getElementById('play_format').closest('section').className,'filters');
 for(const mode of ['grouped','flat']){
  d.getElementById('view-'+mode).click();
  const ids=()=>[...d.querySelectorAll('#rows tr[data-listing-id]')].map(r=>r.dataset.listingId);
  const initial=ids();
  for(const button of d.querySelectorAll('[data-sort]')){
   if(mode==='grouped'&&button.dataset.sort==='date')continue;
   for(const state of ['ascending','descending','none']){
    button.click();assert.equal(button.parentElement.getAttribute('aria-sort'),state);
    assert.equal(d.getElementById('view-'+mode).getAttribute('aria-pressed'),'true');
   }
   assert.deepEqual(ids(),initial);
  }
 }
 const row=d.querySelector('#rows tr[data-listing-id]');
 const labels=[...row.children].map(c=>c.dataset.label);
 assert.ok(labels.indexOf('玩法')<labels.indexOf('程度／用球／單場人數'));
 assert.equal(row.querySelector('.price .hourly-price'),null);
 assert.ok(row.querySelector('.hourly-rate'));
 assert.ok(row.querySelector('.contact-line .primary-links'));
 assert.ok(row.querySelector('.contact-line .author-line'));
 dom.window.close();
});

test('restored headers, matching source links and borderless details preserve flat default',async()=>{
 const f=await fixture();const dom=new JSDOM(f.html,{runScripts:'dangerously'});const d=dom.window.document;
 assert.equal(d.getElementById('mobile-sort'),null);assert.equal(d.getElementById('sort-dialog'),null);
 assert.equal(d.getElementById('view-flat').getAttribute('aria-pressed'),'true');
 const row=d.querySelector('#rows tr[data-listing-id]');row.click();
 const links=[...row.querySelector('.primary-links').children];
 const preview=[...d.querySelector('.selection-links').children];
 assert.equal(preview.length,3);
 assert.equal(preview[2].textContent,'作者個人檔案 ↗');
 assert.match(preview[2].getAttribute('href'),/^https:\/\/www\.facebook\.com\/profile\.php\?id=\d+$/);
 for(let i=0;i<2;i++){
  assert.equal(preview[i].textContent,links[i].textContent);
  assert.equal(preview[i].getAttribute('href'),links[i].getAttribute('href'));
  assert.equal(preview[i].getAttribute('aria-disabled'),links[i].getAttribute('aria-disabled'));
 }
 assert.equal(row.querySelector('.details-toggle').classList.contains('subtle-button'),false);
 row.querySelector('.details-toggle').click();assert.equal(row.querySelector('.contact-details').hidden,false);
 dom.window.close();
});


test("skill cell stacks level and shuttlecock text, including missing values", async () => {
  const f = await fixture();
  const value = '勝利B-04、碳音MAX <img src=x onerror=alert(1)>';
  f.result.listings[0].shuttlecock = value;
  f.result.listings[1].shuttlecock = null;
  const path = join(f.directory, 'shuttlecock.html');
  await buildBrowser(f.result, f.csv, path);
  const dom = new JSDOM(await readFile(path, 'utf8'), { runScripts: 'dangerously', url: 'https://local.example/' });
  for (const [index, listing] of f.result.listings.entries()) {
    const row = [...dom.window.document.querySelectorAll('tr[data-listing-id]')].find(row => row.dataset.listingId === listing.listing_id);
    const cell = row.querySelector('td[data-label="程度／用球／單場人數"]');
    assert.equal(cell.children.length, 1); // One content container beside the mobile label.
    assert.deepEqual([...cell.firstElementChild.children].map(node => node.textContent), [listing.skill.description || '程度未標示', '用球：' + (index === 0 ? value : '未標示'), `場地：${listing.court_count == null ? '未標示' : listing.court_count + ' 面'}；總人數：${listing.availability.capacity == null ? '未標示' : listing.availability.capacity + ' 人'}`]);
    assert.equal(cell.querySelector('img'), null);
  }
  dom.window.close();
});


test("clear button restores unfiltered results and removes chips after native reset", async () => {
  const f = await fixture();
  const dom = new JSDOM(f.html, {runScripts: 'dangerously', url: 'https://local.example/'});
  const d = dom.window.document;
  const count = () => d.querySelectorAll('tr[data-listing-id]').length;
  const initial = count();
  d.querySelector('tr[data-listing-id]').click();
  d.getElementById('fee').value = '0';
  d.getElementById('fee').dispatchEvent(new dom.window.Event('input', {bubbles:true}));
  assert.equal(count(), 0);
  assert.ok(d.querySelector('[data-clear-filter="fee"]'));
  d.getElementById('clear').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(d.getElementById('fee').value, '');
  assert.equal(d.getElementById('condition-filters').children.length, 0);
  assert.equal(count(), initial);
  assert.equal(d.querySelectorAll('tr.is-selected').length, 1);
  dom.window.close();
});

test("author menu adds only a direct profile option and keeps source links and filtering", async () => {
  const f = await fixture();
  const dom = new JSDOM(f.html, {runScripts:'dangerously',url:'https://local.example/'});
  const d = dom.window.document;
  const row = d.querySelector('tr[data-listing-id]');
  const sources = [...row.querySelectorAll('.primary-links a')].map(a=>[a.textContent,a.href]);
  const authorUrl = f.result.listings.find(x=>x.listing_id===row.dataset.listingId).source.author_url;
  row.querySelector('.author-trigger').click();
  const popup = row.querySelector('.author-popover');
  assert.equal(popup.hidden,false);
  const link = popup.querySelector('a');
  const id = new URL(authorUrl).searchParams.get('id') || authorUrl.match(/\/user\/(\d+)/)?.[1];
  assert.equal(link.href,`https://www.facebook.com/profile.php?id=${id}`);
  assert.equal(link.textContent,'前往 Facebook 個人檔案');
  assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
  assert.equal(row.getAttribute('aria-selected'),'false');
  assert.deepEqual([...row.querySelectorAll('.primary-links a')].map(a=>[a.textContent,a.href]),sources);
  assert.equal(popup.querySelectorAll('a').length,1);
  popup.querySelector('[data-exclude-author]').click();
  assert.equal(d.querySelectorAll(`tr[data-listing-id="${row.dataset.listingId}"]`).length,0);
  dom.window.close();
});

test("anonymous authors never get a personal profile link", async () => {
  const f=await fixture();
  f.result.source_posts.forEach(post=>{post.raw.is_anonymous=true;});
  const path=join(f.directory,'anonymous-profile.html');
  await buildBrowser(f.result,f.csv,path);
  const dom=new JSDOM(await readFile(path,'utf8'),{runScripts:'dangerously'});
  assert.equal(dom.window.document.querySelectorAll('.author-popover a').length,0);
  dom.window.close();
});
