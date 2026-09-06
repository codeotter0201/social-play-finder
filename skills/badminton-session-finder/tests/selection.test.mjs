import test from 'node:test';
import assert from 'node:assert/strict';
import {authorIdentity,buildSelectionCopy,MAX_SELECTED,MAX_COPY_CHARACTERS} from '../scripts/lib/selection.mjs';
import {courtCapacityLabel} from '../scripts/lib/session-values.mjs';
const listing=(id,raw='原文😀')=>({listing_id:id,source_post_id:id,source:{post_key:'post1',author_name:'小王',author_url:'https://www.facebook.com/profile.php?id=123',post_url:'https://www.facebook.com/groups/1/posts/2/'},schedule:{date:'2026-09-05',start_time:'19:00',end_time:'21:00',end_day_offset:0},venue:{name:'球館'},skill:{description:'4–6'},registration:{instructions:'私訊'},price_display:'200 元',raw_text:raw});
test('comparison keeps court count and total capacity without calculating per-court numbers or using vacancies',()=>{
 const a=listing('a');a.court_count=3;a.availability={capacity:24,vacancies:2,status:'open'};
 assert.equal(courtCapacityLabel(a),'場地：3 面；總人數：24 人');
 const text=buildSelectionCopy([a]).text;
 assert.ok(text.includes('程度／用球／單場人數'));
 assert.ok(text.includes('場地：3 面；總人數：24 人'));
 assert.ok(!text.includes('8 人'));assert.ok(!text.includes('2 人'));assert.ok(!text.includes('招生狀態'));
 a.availability.capacity=null;
 assert.equal(courtCapacityLabel(a),'場地：3 面；總人數：未標示');
 a.court_count=null;a.availability.capacity=24;
 assert.equal(courtCapacityLabel(a),'場地：未標示；總人數：24 人');
});
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

test('copy includes legacy profile URLs, shuttlecock, method-only contacts and source context',()=>{
 const a=listing('a');a.source.author_url='https://www.facebook.com/groups/42/user/123/';
 a.source.group_name='台中社團';a.source.group_url='https://www.facebook.com/groups/42/';a.source.scraped_at='2026-09-06T00:00:00Z';
 a.shuttlecock='RSL 3';a.registration={methods:['facebook_comment','facebook_message'],instructions:null};
 a.contact={registration_urls:['https://example.com/register']};
 const r=buildSelectionCopy([a]);
 for(const expected of ['作者個人檔案：https://www.facebook.com/profile.php?id=123','用球：RSL 3','貼文留言；Facebook 私訊','https://example.com/register','來源社團：台中社團','擷取時間：2026-09-06T00:00:00Z'])assert.ok(r.text.includes(expected),expected);
 assert.ok(r.text.includes('作者網址：https://www.facebook.com/groups/42/user/123/'));
 assert.ok(buildSelectionCopy([a],{anonymousSourceIds:new Set(['a'])}).text.includes('作者個人檔案：未提供'));
 a.source.author_profile_url='https://www.facebook.com/player.name';assert.ok(buildSelectionCopy([a]).text.includes('作者個人檔案：https://www.facebook.com/player.name'));
});
