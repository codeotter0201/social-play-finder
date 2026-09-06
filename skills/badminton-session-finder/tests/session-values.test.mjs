import test from 'node:test';
import assert from 'node:assert/strict';
import {durationMinutes,durationLabel,hourlyPriceLabel} from '../scripts/lib/session-values.mjs';
import {compareUngroupedRows} from '../scripts/browser-runtime.mjs';
const schedule={start_time:'19:00',end_time:'21:30',end_day_offset:0};
test('duration uses session time, accepts overnight, sorts numerically and keeps unknown last',()=>{
 assert.equal(durationMinutes(schedule),150);assert.equal(durationLabel(schedule),'2.5 HR');
 assert.equal(durationMinutes({start_time:'23:00',end_time:'01:00',end_day_offset:1}),120);
 for(const change of [{end_time:null},{end_day_offset:null},{end_time:'18:00'},{end_time:'19:00'},{end_time:'25:00'}])assert.equal(durationMinutes({...schedule,...change}),null);
 const rows=[{listing_id:'long',date:'2026-09-01',...schedule},{listing_id:'short',date:'2026-09-02',...schedule,end_time:'20:00'},{listing_id:'unknown',date:'2026-09-03',...schedule,end_time:''}];
 assert.deepEqual([...rows].sort((a,b)=>compareUngroupedRows(a,b,'duration')).map(r=>r.listing_id),['short','long','unknown']);
 assert.deepEqual([...rows].sort((a,b)=>compareUngroupedRows(a,b,'duration',true)).map(r=>r.listing_id),['long','short','unknown']);
});
test('hourly price pairs the lowest fee with its own duration and condition',()=>{
 const listing={schedule,price_options:[{amount:300,duration_minutes:150,condition:null},{amount:200,duration_minutes:60,condition:'同行價'}]};
 assert.deepEqual(hourlyPriceLabel(listing),'200/hr');
 listing.price_options=[{amount:250,duration_minutes:null,condition:null}];assert.deepEqual(hourlyPriceLabel(listing),'100/hr');
 listing.schedule={...schedule,end_time:null};assert.deepEqual(hourlyPriceLabel(listing),'');
 listing.price_options=[{amount:0,duration_minutes:120,condition:null}];assert.deepEqual(hourlyPriceLabel(listing),'0/hr');
 listing.price_options=[{amount:200,duration_minutes:0,condition:null}];assert.deepEqual(hourlyPriceLabel(listing),'');
});

test('hourly price chooses lowest rate among lowest-fee options and sorts numerically with unknown last',async()=>{
 const {hourlyPrice}=await import('../scripts/lib/session-values.mjs');
 const listing={schedule,price_options:[{amount:200,duration_minutes:60},{amount:200,duration_minutes:120},{amount:300,duration_minutes:240}]};
 assert.equal(hourlyPrice(listing),100);assert.equal(hourlyPriceLabel(listing),'100/hr');
 const rows=[{listing_id:'a',hourly_rate:100},{listing_id:'b',hourly_rate:9},{listing_id:'c',hourly_rate:null},{listing_id:'d',hourly_rate:0}];
 assert.deepEqual([...rows].sort((a,b)=>compareUngroupedRows(a,b,'hourly_rate')).map(r=>r.listing_id),['d','b','a','c']);
 assert.deepEqual([...rows].sort((a,b)=>compareUngroupedRows(a,b,'hourly_rate',true)).map(r=>r.listing_id),['a','b','d','c']);
});
