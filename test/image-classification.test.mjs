import test from 'node:test';
import assert from 'node:assert/strict';
import {imageClassification} from '../lib/image-classification.mjs';

test('explicit image classification overrides all inferred signals, including empty seasons and any environment',()=>{
  assert.deepEqual(imageClassification({name:'冬日街角',tags:['海边'],sceneIds:['summer-coast'],seasons:[],environment:'any'}),{seasons:[],environment:'any'});
  assert.deepEqual(imageClassification({name:'夏日海边',seasons:['winter'],environment:'indoor'}),{seasons:['winter'],environment:'indoor'});
});

test('legacy classification prefers descriptive text and strong outdoor clues before scene fallbacks',()=>{
  assert.deepEqual(imageClassification({name:'冬日街角黑大衣',tags:['街角'],sceneIds:['autumn-cafe']}),{seasons:['winter'],environment:'outdoor'});
  assert.deepEqual(imageClassification({name:'卧室人物',sceneIds:['summer-coast']}),{seasons:['summer'],environment:'indoor'});
  assert.deepEqual(imageClassification({name:'落叶书店酒红风衣',activity:'散步'}),{seasons:[],environment:'outdoor'});
  assert.deepEqual(imageClassification({name:'普通人物',activity:'阅读'}),{seasons:[],environment:'indoor'});
  assert.deepEqual(imageClassification({name:'普通人物'}),{seasons:[],environment:'any'});
});

test('legacy season words in metadata win before scene season names',()=>{
  assert.deepEqual(imageClassification({tags:['春日'],sceneIds:['winter-home']}).seasons,['spring']);
  assert.deepEqual(imageClassification({sceneIds:['spring-study','summer-coast']}).seasons,['spring','summer']);
});
