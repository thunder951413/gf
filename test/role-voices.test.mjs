import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server.mjs';
import { startSpeech } from '../lib/integrations.mjs';

const appDataDir = path.resolve('app-data');
const settings = {
  model_profile: 'balanced', qwen_max_new_tokens: 321, qwen_chunk_size: 48, qwen_seed: 73,
  qwen_temperature: 0.72, qwen_top_p: 0.91, qwen_top_k: 33, qwen_repetition_penalty: 1.08,
  qwen_non_streaming_mode: true, qwen_append_silence: false, qwen_min_new_tokens: 12,
  qwen_clone_mode: 'icl',
};
const defaultVoices = [
  { id: 'voice-miyue', name: '龙安柔', referencePath: '/catalog/default-miyue.wav', transcript: '晓薇的参考文本。' },
  { id: 'voice-wenxi', name: '龙安欢', referencePath: '/catalog/default-wenxi.wav', transcript: '闻溪的参考文本。' },
  { id: 'voice-zhixia', name: '龙星', referencePath: '/catalog/default-zhixia.wav', transcript: '' },
  { id: 'voice-extra', name: '测试音色', referencePath: '/catalog/extra.wav', transcript: '测试音色自己的参考文本。' },
];

const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function request(base, pathname, options) {
  const response = await fetch(`${base}${pathname}`, options);
  return { status: response.status, body: await response.json() };
}
function fakeIntegrations(state) {
  return {
    fetchFeed: async () => ({ title: 'empty', items: [] }),
    fetchSinaHotTopics: async () => ({ items: [] }),
    probeTts: async () => ({ available: true, state: 'ready', stt: { available: false, state: 'unavailable' } }),
    listSpeechVoices: async () => ({ voices: state.voices.map(voice => ({ ...voice })), settings: { ...settings } }),
    startSpeech: async (text, options) => { state.starts.push({ text, options }); return { jobId: `job_${state.starts.length}` }; },
    readSpeechStatus: async () => ({ state: 'finished' }),
    getSpeechAudio: async () => ({ body: Buffer.from('RIFF'), contentType: 'audio/wav' }),
    closeSpeech: async () => ({ ok: true }),
    transcribeAudio: async () => ({ text: '' }),
  };
}
async function openApp(dataDir, state) {
  const app = await createApp({
    appDataDir, dataDir, initialFeeds: [], integrations: fakeIntegrations(state), env: {},
    startProactive: false, startRecall: false, startResearch: false, startLife: false,
    startDossiers: false, startChatQueue: false, replySleep: async () => {},
  });
  const address = await app.listen(0);
  return { app, base: `http://127.0.0.1:${address.port}` };
}

test('role defaults initialize by voice name and assignments survive a repository restart', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-role-voices-'));
  const state = { voices: defaultVoices, starts: [] };
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let opened = await openApp(dataDir, state);
  const initial = await request(opened.base, '/api/voice/catalog');
  assert.equal(initial.status, 200);
  assert.ok(initial.body.voices.every(voice => !Object.hasOwn(voice, 'referencePath') && !Object.hasOwn(voice, 'path') && !Object.hasOwn(voice, 'audio_path')));
  assert.deepEqual(Object.fromEntries(Object.entries(initial.body.assignments).map(([role, voice]) => [role, voice.name])), {
    miyue: '龙安柔', wenxi: '龙安欢', zhixia: '龙星',
  });
  assert.equal((await request(opened.base, '/api/voice/roles', json({ roleId: 'wenxi', voiceId: 'voice-extra' }))).status, 200);
  await opened.app.close();

  opened = await openApp(dataDir, state);
  t.after(() => opened.app.close());
  const restarted = await request(opened.base, '/api/voice/catalog');
  assert.equal(restarted.body.assignments.wenxi.voiceId, 'voice-extra');
  assert.equal(restarted.body.assignments.wenxi.name, '测试音色');
});

test('preview honors requested/catalog/global voices, rejects missing selections, and never trusts a submitted path', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-role-preview-'));
  const state = { voices: defaultVoices, starts: [] };
  const { app, base } = await openApp(dataDir, state);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await request(base, '/api/voice/catalog');

  const requested = await request(base, '/api/voice/preview', json({
    roleId: 'miyue', voiceId: 'voice-extra', referencePath: '/outside/catalog/injected.wav',
  }));
  assert.equal(requested.status, 200);
  assert.equal(state.starts.at(-1).options.voice.id, 'voice-extra');
  assert.equal(state.starts.at(-1).options.voice.referencePath, '/catalog/extra.wav');
  assert.notEqual(state.starts.at(-1).options.voice.referencePath, '/outside/catalog/injected.wav');
  assert.equal(state.starts.at(-1).options.settings.qwen_max_new_tokens, settings.qwen_max_new_tokens);

  await request(base, '/api/voice/roles', json({ roleId: 'miyue', voiceId: null }));
  assert.equal((await request(base, '/api/voice/preview', json({ roleId: 'miyue' }))).status, 200);
  assert.deepEqual(state.starts.at(-1).options, {});

  await request(base, '/api/voice/roles', json({ roleId: 'zhixia', voiceId: 'voice-extra' }));
  state.voices = defaultVoices.filter(voice => voice.id !== 'voice-extra');
  await request(base, '/api/voice/catalog?refresh=1');
  const missing = await request(base, '/api/voice/preview', json({ roleId: 'zhixia' }));
  assert.equal(missing.status, 503);
  assert.equal(missing.body.code, 'VOICE_UNAVAILABLE');
  assert.equal((await request(base, '/api/voice/roles', json({ roleId: 'wenxi', voiceId: '/arbitrary/path.wav' }))).status, 400);
});

test('message speech uses its persisted role assignment', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-role-message-'));
  const state = { voices: defaultVoices, starts: [] };
  const { app, base } = await openApp(dataDir, state);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await request(base, '/api/voice/catalog');
  const [, assistant] = app.store.saveChatTurn({ role: 'wenxi', text: '测试输入', reply: '这是闻溪要朗读的回复。' });
  const response = await request(base, '/api/voice/start', json({ messageId: assistant.id }));
  assert.equal(response.status, 200);
  assert.equal(state.starts.at(-1).text, assistant.text);
  assert.equal(state.starts.at(-1).options.voice.name, '龙安欢');
});

test('speech adapter sends catalog voice cloning fields and preserves whitelisted model settings', async () => {
  const forms = [];
  const options = {
    baseUrl: 'http://127.0.0.1:1', env: {}, envFile: '/not-read',
    fetchImpl: async (_url, init) => { forms.push(new URLSearchParams(String(init.body))); return Response.json({ job_id: `adapter_${forms.length}` }); },
  };
  await startSpeech('使用全局设置', options);
  assert.equal(forms[0].get('use_service_settings'), '1');
  assert.equal(forms[0].has('example_audio_path'), false);

  await startSpeech('使用指定音色', { ...options, voice: defaultVoices[0], settings });
  const icl = forms[1];
  assert.equal(icl.get('use_service_settings'), '0');
  assert.equal(icl.get('voice_name'), '龙安柔');
  assert.equal(icl.get('example_audio_path'), '/catalog/default-miyue.wav');
  assert.equal(icl.get('qwen_clone_mode'), 'icl');
  assert.equal(icl.get('qwen_reference_text'), defaultVoices[0].transcript);
  assert.deepEqual(Object.fromEntries([
    'model_profile', 'max_new_tokens', 'codec_chunk_frames', 'seed', 'temperature', 'top_p', 'top_k',
    'repetition_penalty', 'qwen_non_streaming_mode', 'qwen_append_silence', 'qwen_min_new_tokens',
  ].map(key => [key, icl.get(key)])), {
    model_profile: 'balanced', max_new_tokens: '321', codec_chunk_frames: '48', seed: '73',
    temperature: '0.72', top_p: '0.91', top_k: '33', repetition_penalty: '1.08',
    qwen_non_streaming_mode: '1', qwen_append_silence: '0', qwen_min_new_tokens: '12',
  });

  await startSpeech('无参考文本时回退', { ...options, voice: defaultVoices[2], settings });
  assert.equal(forms[2].get('qwen_clone_mode'), 'xvec');
  assert.equal(forms[2].get('qwen_reference_text'), '');
});
