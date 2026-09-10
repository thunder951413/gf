import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync(new URL('../app-data/scenarios.json', import.meta.url), 'utf8'));
const rain = data.scenarios.find((scenario) => scenario.id === 'rain-lantern');

const originalNodes = [
  'arcade',
  'tea-shop',
  'tram-stop',
  'rooftop',
  'archive',
  'dawn-public',
  'dawn-private',
];

const originalChoices = {
  arcade: ['tea-route', 'tram-route'],
  'tea-shop': ['trade-poster', 'respect-map'],
  'tram-stop': ['follow-mirrors', 'test-key'],
  rooftop: ['light-phone', 'guard-door', 'offer-stop'],
  archive: ['public-credit', 'private-walk'],
};

const originalKnownFacts = {
  arcade: [
    '铜钥匙是在停电后从自动贩卖机底下滑出的',
    '旧影院已停业十二年，入口分别可从茶铺后门和末班有轨车站接近',
    '阮绵明早要向赞助方提交夜间城市展的最终方案',
  ],
  'tea-shop': [
    '茶铺老板确认钥匙牌属于影院二楼失物柜',
    '暴雨夜里旧信箱偶尔会出现地址不断变化的信',
    '茶铺天井的消防梯能通向影院屋顶',
  ],
  'tram-stop': [
    '镜面标记以七步为间隔延伸至影院侧巷',
    '侧门锈死但旁边的维修梯仍牢固',
    '异常站牌在钥匙靠近时会短暂显示一个屋顶图标',
  ],
  rooftop: [
    '失物柜里只有一封写给明早仍愿意办展之人的信',
    '纸鹤记号属于阮绵母亲的改稿习惯',
    '阮绵明确表示信由她亲自拆，你可以陪伴',
  ],
  archive: [
    '信中是阮绵母亲未完成的城市夜行投影草案',
    '草案授权发现者决定公开或保留',
    '蓝色批注正在褪色，但阮绵已完成影像记录',
  ],
  'dawn-public': [
    '阮绵已提交公开展览提案并为母亲署名',
    '她会主动说明遗稿来历与自己的改编部分',
    '她向你发出首映夜顾问邀请，尚未替你答应',
  ],
  'dawn-private': [
    '阮绵决定先做不公开的双人内部试映',
    '她已主动承担延期沟通',
    '她给你选择参与方式，也允许拒绝',
  ],
};

test('rain-lantern keeps old save targets and choice ids while extending both former endings', () => {
  assert.ok(rain);
  for (const nodeId of originalNodes) {
    assert.ok(rain.nodes[nodeId], `missing saved node ${nodeId}`);
    assert.deepEqual(rain.nodes[nodeId].knownFacts, originalKnownFacts[nodeId]);
  }
  for (const [nodeId, choiceIds] of Object.entries(originalChoices)) {
    assert.deepEqual(rain.nodes[nodeId].choices.map((choice) => choice.id), choiceIds);
  }
  for (const formerEnding of ['dawn-public', 'dawn-private']) {
    assert.notEqual(rain.nodes[formerEnding].ending, true);
    assert.ok(rain.nodes[formerEnding].choices.length > 0);
  }
});

test('rain-lantern is a three-chapter graph with exactly two reachable endings', () => {
  const nodes = rain.nodes;
  const chapters = new Set(Object.values(nodes).map((node) => node.chapter));
  assert.deepEqual(chapters, new Set([
    '第一章｜雨夜来信',
    '第二章｜白昼排练',
    '第三章｜把光交给人群',
  ]));
  assert.ok(Object.keys(nodes).length >= 18);

  const endingIds = Object.values(nodes).filter((node) => node.ending).map((node) => node.id).sort();
  assert.deepEqual(endingIds, ['after-rain', 'lights-among-us']);

  const reachable = new Set();
  const visiting = new Set();
  const finished = new Set();
  const choiceIds = new Set();

  function walk(nodeId) {
    assert.ok(nodes[nodeId], `choice targets missing node ${nodeId}`);
    reachable.add(nodeId);
    if (finished.has(nodeId)) return;
    assert.ok(!visiting.has(nodeId), `cycle found at ${nodeId}`);
    visiting.add(nodeId);

    const node = nodes[nodeId];
    assert.equal(node.id, nodeId);
    assert.equal(node.opening.length, 2);
    assert.ok(Array.isArray(node.knownFacts));
    if (node.ending) {
      assert.deepEqual(node.choices, []);
    } else {
      assert.ok(node.choices.length > 0, `non-ending ${nodeId} cannot terminate`);
      for (const choice of node.choices) {
        assert.ok(!choiceIds.has(choice.id), `duplicate choice id ${choice.id}`);
        choiceIds.add(choice.id);
        walk(choice.next);
      }
    }

    visiting.delete(nodeId);
    finished.add(nodeId);
  }

  walk(rain.start);
  assert.deepEqual([...reachable].sort(), Object.keys(nodes).sort(), 'new nodes must not be orphaned');
});

test('opening chapters do not expose later production outcomes as current facts', () => {
  const firstChapterFacts = Object.values(rain.nodes)
    .filter((node) => node.chapter === '第一章｜雨夜来信')
    .flatMap((node) => node.knownFacts)
    .join('；');
  assert.doesNotMatch(firstChapterFacts, /九十秒样片|三十个座位|主线路|首轮放映已经安全完成/);
});
