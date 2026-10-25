import fs from 'node:fs';
import path from 'node:path';

const sourceAppDataDir = path.resolve('app-data');

function testRole(base, { id, name, title, mode }) {
  return {
    ...structuredClone(base),
    id,
    name,
    title,
    description: `${name}测试角色，仅用于验证 ${mode} 模式。`,
    initialMessage: `${name}测试会话已开始。`,
    systemPrompt: `你是测试角色${name}。只用于自动化测试，按当前上下文自然回复。`,
    interaction: { ...base.interaction, mode, lifeEvents: mode === 'companion' },
    profile: { ...base.profile, relationship: '自动化测试角色' },
  };
}

export function testRoles() {
  const [miyue] = JSON.parse(fs.readFileSync(path.join(sourceAppDataDir, 'roles.json'), 'utf8'));
  return [
    miyue,
    testRole(miyue, { id: 'wenxi', name: '闻溪', title: '信息测试', mode: 'information' }),
    testRole(miyue, { id: 'zhixia', name: '知夏', title: '情境测试', mode: 'scenario' }),
  ];
}
