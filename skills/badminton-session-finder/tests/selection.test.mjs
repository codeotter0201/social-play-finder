import test from 'node:test';
import assert from 'node:assert/strict';
import {authorIdentity,buildSelectionCopy,MAX_SELECTED,MAX_COPY_CHARACTERS} from '../scripts/lib/selection.mjs';
const listing=(id,raw='原文😀')=>({listing_id:id,source_post_id:id,source:{post_key:'post1',author_name:'小王',author_url:'https://www.facebook.com/profile.php?id=123',post_url:'https://www.facebook.com/groups/1/posts/2/'},schedule:{date:'2026-09-05',start_time:'19:00',end_time:'21:00',end_day_offset:0},venue:{name:'球館'},skill:{description:'4–6'},registration:{instructions:'私訊'},price_display:'200 元',raw_text:raw});
test('copy keeps a row per session but deduplicates source text and counts Unicode characters',()=>{
 const r=buildSelectionCopy([listing('a'),listing('b')]);assert.equal(r.sourceCount,1);assert.equal(r.text.split('原文😀').length-1,1);assert.equal(r.characters,[...r.text].length);assert.equal(r.withinLimit,true);
 assert.equal(buildSelectionCopy([listing('a','中'.repeat(MAX_COPY_CHARACTERS))]).withinLimit,false);
 assert.throws(()=>buildSelectionCopy(Array.from({length:MAX_SELECTED+1},(_,i)=>listing(String(i)))),/最多/);
});
test('author identity ignores tracking and names, handles aliases and refuses anonymous/generic URLs',()=>{
 const a=listing('a');assert.equal(authorIdentity(a),'facebook:id:123');
 a.source.author_url='https://www.facebook.com/groups/42/user/123/?ref=abc';assert.equal(authorIdentity(a),'facebook:id:123');
 assert.equal(authorIdentity(a,true),null);a.source.author_name='匿名成員';assert.equal(authorIdentity(a),null);
 a.source.author_name='小王';a.source.author_url='https://www.facebook.com/groups/';assert.equal(authorIdentity(a),null);
 a.source.author_url='javascript:alert(1)';assert.equal(authorIdentity(a),null);
});
