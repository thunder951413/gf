import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {InnerStateRepository} from '../lib/inner-state.mjs';
import {DailyLife} from '../lib/daily-life.mjs';
import {DailyLifeEffects} from '../lib/daily-life-effects.mjs';
import {CompanionRuntime} from '../lib/companion-runtime.mjs';

test('thirty days of real runtime transitions, repeated polls and restarts keep choices and effects consistent',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'life-month-'));let store,runtime,inner,now=new Date('2026-09-01T00:00:00Z'),seed=193;
  const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const boot=()=>{store=new Store({dataDir:dir,story:{start:'start',nodes:{start:{body:'',choices:[]}}},initialFeeds:[]});inner=new InnerStateRepository(store,{clock:()=>now,random});const daily=new DailyLife(store,{clock:()=>now,random});const effects=new DailyLifeEffects(store,inner,{clock:()=>now});runtime=new CompanionRuntime(store,{clock:()=>now,random,dailyLife:daily,getInputs:()=>({inner:inner.get()}),prepareDailyLife:view=>{effects.advance(view.events);return inner.get();}});};
  t.after(()=>{store?.close();fs.rmSync(dir,{recursive:true,force:true});});boot();
  const ids=new Set(),kinds=new Set();let effectsCount=0;
  for(let step=0;step<30*48;step++){
    now=new Date(Date.parse('2026-09-01T00:00:00Z')+step*30*60000);
    const view=runtime.advance(),events=view.dailyLife.events;
    assert.ok(events.length<=6);assert.ok(events.filter(e=>e.foreground).length<=1);
    for(const event of events){ids.add(event.id);kinds.add(event.kind);if(event.choice)assert.ok(event.choice.options.includes(event.choice.selected));}
    const metrics=inner.view().values;assert.ok(Object.values(metrics).every(n=>Number.isInteger(n)&&n>=0&&n<=100));
    const count=store.db.prepare("SELECT count(*) AS n FROM inner_state_events WHERE event_id LIKE 'daily:%'").get().n;
    assert.ok(count>=effectsCount);effectsCount=count;
    const repeat=runtime.advance();assert.equal(repeat.revision,view.revision);assert.deepEqual(repeat.dailyLife,view.dailyLife);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM inner_state_events WHERE event_id LIKE 'daily:%'").get().n,count);
    if(step===500||step===1000){store.close();boot();const restored=runtime.advance();assert.deepEqual(restored.dailyLife,view.dailyLife);}
  }
  assert.ok(ids.size>=10,`events=${ids.size}`);assert.ok(kinds.size>=5,`kinds=${kinds.size}`);assert.ok(effectsCount>0);assert.ok(effectsCount<=ids.size,'one authored effect per event');
});
