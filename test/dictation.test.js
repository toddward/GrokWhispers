'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { startMock } = require('./mock-xai');
const { DictationController, createEngine } = require('../src/main/dictation');
const { History } = require('../src/main/history');
const { DEFAULTS } = require('../src/main/config');

function harness(mock, settingsPatch = {}, { apiKey = 'test-key', armDelayMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
  const settings = { ...DEFAULTS, ...settingsPatch };
  const inserted = [];
  const ui = { states: [], notices: [], sounds: [], captions: [] };
  const history = new History(dir);
  const recorder = { started: 0, stopped: 0, start: async () => { recorder.started += 1; }, stop: async () => { recorder.stopped += 1; } };
  const ctl = new DictationController({
    getSettings: () => settings,
    getApiKey: () => apiKey,
    createEngine: (s, key) => createEngine(s, key, { url: s.engine === 'grok-stt' ? mock.sttUrl : mock.realtimeUrl }),
    recorder,
    insert: async (text) => { inserted.push(text); },
    frontmostApp: async () => 'Slack',
    waitForKeysReleased: async () => {},
    armDelayMs,
    history,
    ui: {
      state: (s) => ui.states.push(s.state + (s.step ? `:${s.step}` : '')),
      level: () => {},
      caption: (c) => ui.captions.push(c),
      sound: (n) => ui.sounds.push(n),
      notify: (m, k) => ui.notices.push(`${k}:${m}`),
    },
  });
  return { ctl, inserted, ui, history, recorder };
}

const begin = async (ctl) => { await ctl.start(); await new Promise((r) => setTimeout(r, 2)); };

const speak = (ctl, ms) => {
  for (let i = 0; i < ms / 100; i += 1) ctl.onAudio(Buffer.alloc(4800, 2), 0.1);
};

test('end to end with Grok Voice 3.0: polished text is inserted and logged', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { ctl, inserted, ui, history, recorder } = harness(mock);
  await begin(ctl);
  speak(ctl, 1000);
  const entry = await ctl.stop();
  assert.deepEqual(inserted, ['So, what time is the meeting tomorrow?']);
  assert.equal(entry.polish, 'polished');
  assert.equal(entry.app, 'Slack');
  assert.equal(entry.audioSeconds, 1);
  assert.ok(entry.estCostUsd >= 0);
  assert.deepEqual(ui.states, ['listening', 'processing:transcribing', 'processing:polishing', 'idle']);
  assert.deepEqual(ui.sounds, ['start', 'stop']);
  assert.equal(recorder.stopped, 1);
  assert.equal(history.list().length, 1);
  const create = mock.log.realtime.find((e) => e.type === 'response.create');
  assert.match(create.response.instructions, /Destination app: Slack/);
});

test('final audio chunk flushed during stop() is still sent', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { ctl, recorder } = harness(mock);
  recorder.stop = async () => { ctl.onAudio(Buffer.alloc(2400, 2), 0.1); }; // 50 ms tail
  await begin(ctl);
  speak(ctl, 500);
  await ctl.stop();
  const completed = mock.log.realtime.filter((e) => e.type === '<binary>').reduce((n, e) => n + e.bytes, 0);
  assert.equal(completed, 24000 + 2400);
});

test('falls back to raw transcript when Grok answers instead of formatting', async (t) => {
  const mock = await startMock({ realtime: { transcript: 'what is the capital of France', polished: 'The capital of France is Paris, a city known for the Eiffel Tower.' } });
  t.after(() => mock.close());
  const { ctl, inserted } = harness(mock);
  await begin(ctl);
  speak(ctl, 800);
  const entry = await ctl.stop();
  assert.deepEqual(inserted, ['what is the capital of France']);
  assert.equal(entry.polish, 'raw');
});

test('economy engine (Grok STT) inserts the transcript without polish', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { ctl, inserted, ui } = harness(mock, { engine: 'grok-stt' });
  await begin(ctl);
  speak(ctl, 500);
  const entry = await ctl.stop();
  assert.deepEqual(inserted, ['Hello world. This is a test.']);
  assert.equal(entry.engine, 'grok-stt');
  assert.ok(!ui.states.includes('processing:polishing'));
});

test('too-short press inserts nothing', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { ctl, inserted, ui } = harness(mock);
  await begin(ctl);
  speak(ctl, 100);
  assert.equal(await ctl.stop(), null);
  assert.deepEqual(inserted, []);
  assert.match(ui.notices[0], /Hold the hotkey/);
  assert.equal(ctl.state, 'idle');
});

test('a press shorter than the arm delay never connects, beeps, or shows the overlay', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { ctl, ui, inserted } = harness(mock, {}, { armDelayMs: 1000 });
  await ctl.start();
  speak(ctl, 100);
  assert.equal(await ctl.stop(), null);
  await ctl.cancel();
  assert.equal(mock.log.urls.length, 0, 'no Grok session opened');
  assert.deepEqual(ui.sounds, []);
  assert.ok(!ui.states.includes('listening'));
  assert.deepEqual(inserted, []);
});

test('shortcut false-start (cancel before arm) is silent and opens no session', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { ctl, ui } = harness(mock, {}, { armDelayMs: 1000 });
  await ctl.start();
  await ctl.cancel();
  assert.equal(mock.log.urls.length, 0);
  assert.deepEqual(ui.sounds, []);
});

test('cancel discards audio', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { ctl, inserted, ui } = harness(mock);
  await begin(ctl);
  speak(ctl, 600);
  await ctl.cancel();
  assert.equal(ctl.state, 'idle');
  assert.deepEqual(inserted, []);
  assert.equal(ui.sounds.at(-1), 'cancel');
});

test('missing API key prompts for one', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { ctl, ui } = harness(mock, {}, { apiKey: '' });
  let asked = false;
  ctl.on('needs-key', () => { asked = true; });
  assert.equal(await ctl.start(), false);
  assert.ok(asked);
  assert.match(ui.notices[0], /API key/);
});

test('rejected key gives a friendly error and returns to idle', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const { ctl, ui, inserted } = harness(mock, {}, { apiKey: 'nope' });
  await begin(ctl);
  speak(ctl, 600);
  await ctl.stop();
  assert.deepEqual(inserted, []);
  assert.match(ui.notices.at(-1), /rejected your API key/);
  assert.equal(ctl.state, 'idle');
});
