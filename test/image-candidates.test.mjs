import test from 'node:test';
import assert from 'node:assert/strict';
import {imageCandidatePool,imageCoverageReport,itemActivities,locationScopeMatches} from '../lib/image-candidates.mjs';

const asset=(id,extra={})=>({id,name:id,activities:['work'],desktopEligible:true,cutoutUrl:`/${id}.png`,seasons:['summer'],environment:'indoor',...extra});

test('candidate pools strictly filter the requested season, environment, and transparent approval',()=>{
 const items=[asset('match'),asset('winter',{seasons:['winter']}),asset('outside',{environment:'outdoor'}),asset('unapproved',{desktopEligible:false})];
 const pool=imageCandidatePool(items,{group:'work',season:'summer',environment:'indoor'});
 assert.deepEqual(pool.candidates.map(item=>item.id),['match']);assert.equal(pool.fallbackUsed,false);
});

test('sleep never crosses the awake boundary and coverage reports auditable ids per matrix cell',()=>{
 const items=[asset('awake'),asset('sleep',{activities:['sleep']}),asset('reader',{activities:['reading','work']})];
 assert.deepEqual(imageCandidatePool(items,{group:'sleep',season:'summer',environment:'indoor'}).candidates.map(item=>item.id),['sleep']);
 assert.ok(!imageCandidatePool(items,{group:'work',season:'summer',environment:'indoor'}).candidates.some(item=>item.id==='sleep'));
 const cell=imageCoverageReport(items).groups.work.summer.indoor;
 assert.deepEqual(cell.ids,['awake','reader']);assert.equal(cell.count,2);assert.equal(cell.specificCount,2);
});

test('explicit activities override stale descriptive metadata, including an explicit empty list',()=>{
 const stale=asset('stale',{name:'睡前休息',activity:'rest',activities:['work']});
 const cleared=asset('cleared',{name:'睡前休息',activity:'rest',activities:[]});
 assert.deepEqual(itemActivities(stale),['work']);
 assert.deepEqual(itemActivities(cleared),[]);
 const rest=imageCandidatePool([stale],{group:'rest',season:'summer',environment:'indoor'});
 assert.equal(rest.specificCount,0);assert.equal(rest.fallbackUsed,true);
 assert.ok(!imageCandidatePool([cleared],{group:'sleep',season:'summer',environment:'indoor'}).candidates.length);
});

test('restricted location scopes require an actual matching runtime location while catalogue coverage remains inventory-wide',()=>{
 const items=[asset('legacy'),asset('private',{locationScope:'home'}),asset('swim',{locationScope:'waterfront'})];
 assert.deepEqual(imageCandidatePool(items,{group:'work',season:'summer',environment:'indoor',location:'咖啡馆'}).candidates.map(item=>item.id),['legacy']);
 assert.deepEqual(imageCandidatePool(items,{group:'work',season:'summer',environment:'indoor',location:'家里卧室'}).candidates.map(item=>item.id),['legacy','private']);
 assert.deepEqual(imageCandidatePool(items,{group:'work',season:'summer',environment:'indoor'}).candidates.map(item=>item.id),['legacy']);
 assert.deepEqual(imageCandidatePool(items,{group:'work',season:'summer',environment:'indoor',location:'城市旅行中'}).candidates.map(item=>item.id),['legacy']);
 assert.ok(locationScopeMatches('waterfront','酒店游泳池'));assert.ok(!locationScopeMatches('home','酒店大堂客房区'));
 const cell=imageCoverageReport(items).groups.work.summer.indoor;
 assert.deepEqual(cell.ids,['legacy','private','swim']);
});

test('waterfront swimwear is not selected for a riverside city stroll',()=>{
 const swim=asset('swim',{locationScope:'waterfront',environment:'outdoor',activities:['travel']});
 for(const location of ['苏州平江路河边','湖边散步','城市码头'])assert.equal(imageCandidatePool([swim],{group:'travel',season:'summer',environment:'outdoor',location}).candidates.length,0);
 assert.equal(imageCandidatePool([swim],{group:'travel',season:'summer',environment:'outdoor',location:'酒店泳池'}).candidates.length,1);
});
