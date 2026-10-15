'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startMock } = require('./mock-xai');
const { GrokVoiceSession } = require('../src/xai/realtime');
const { GrokSttSession, mergeFinalTranscript } = require('../src/xai/stt');

const pcm = (ms) => Buffer.alloc((24000 * 2 * ms) / 1000, 1);

test('Grok Voice 3.0: buffers early audio, commits, transcribes, polishes', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const s = new GrokVoiceSession({
    apiKey: 'test-key', url: mock.realtimeUrl, instructions: 'SYS', language: 'en', keyterms: ['Kubernetes', 'kubernetes', ' xAI '],
  });
  const partials = [];
  s.on('partial', (p) => partials.push(p));
  s.connect();
  s.sendAudio(pcm(100)); // before session.updated -> must be buffered, not dropped
  s.sendAudio(pcm(100));
  await s.readyPromise;
  s.sendAudio(pcm(300));

  const raw = await s.finish();
  assert.match(raw, /\(24000 bytes\)$/, 'all 500 ms of audio reached the server');
  assert.deepEqual(partials, ['um so']);

  const polished = await s.polish('format please');
  assert.equal(polished, 'So, what time is the meeting tomorrow?');
  s.close();

  const url = new URL(mock.log.urls[0], 'ws://x');
  assert.equal(url.searchParams.get('model'), 'grok-voice-3.0');
  assert.equal(url.searchParams.get('reasoning.effort'), 'none');

  const update = mock.log.realtime.find((e) => e.type === 'session.update');
  assert.deepEqual(update.session.turn_detection, { type: null });
  assert.deepEqual(update.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(update.session.audio.input.transport, 'binary');
  assert.deepEqual(update.session.audio.input.transcription.keyterms, ['Kubernetes', 'xAI']);
  assert.equal(update.session.audio.input.transcription.language_hint, 'en');
  assert.ok(mock.log.realtime.filter((e) => e.type === '<binary>').every((e) => !e.beforeConfigured));

  const create = mock.log.realtime.find((e) => e.type === 'response.create');
  assert.deepEqual(create.response.modalities, ['text']);
  assert.equal(create.response.instructions, 'format please');
});

test('Grok Voice: retries session.update without caption model when rejected', async (t) => {
  const mock = await startMock({ realtime: { rejectTranscriptionModel: true } });
  t.after(() => mock.close());
  const s = new GrokVoiceSession({ apiKey: 'test-key', url: mock.realtimeUrl });
  await s.connect();
  const updates = mock.log.realtime.filter((e) => e.type === 'session.update');
  assert.equal(updates.length, 2);
  assert.equal(updates[1].session.audio.input.transcription.model, undefined);
  s.close();
});

test('Grok Voice: non-caption setup error fails fast with the server message', async (t) => {
  const mock = await startMock({ realtime: { rejectAll: 'Invalid language_hint: english' } });
  t.after(() => mock.close());
  const s = new GrokVoiceSession({ apiKey: 'test-key', url: mock.realtimeUrl, timeoutMs: 5000 });
  const t0 = Date.now();
  await assert.rejects(s.connect(), /Invalid language_hint/);
  assert.ok(Date.now() - t0 < 1000);
});

test('Grok Voice: refuses a session that stays in server VAD mode', async (t) => {
  const mock = await startMock({ realtime: { forceVad: true } });
  t.after(() => mock.close());
  const s = new GrokVoiceSession({ apiKey: 'test-key', url: mock.realtimeUrl, timeoutMs: 5000 });
  await assert.rejects(s.connect(), /manual turns are required/);
});

for (const [mode, expected] of [
  ['itemAdded', 'delivered via item added'],
  ['captionsOnly', 'only live captions arrived'],
  ['earlySegment', 'first part of the sentence'],
  ['commitError', 'first part of the sentence'],
]) {
  test(`Grok Voice: transcript recovered when server uses ${mode}`, async (t) => {
    const mock = await startMock({ realtime: { mode: mode === 'commitError' ? 'earlyThenError' : mode } });
    t.after(() => mock.close());
    const s = new GrokVoiceSession({ apiKey: 'test-key', url: mock.realtimeUrl, timeoutMs: 5000 });
    await s.connect();
    if (mode === 'commitError') {
      // a segment completed during speech, then the commit is rejected as empty
      s._onEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'seg_1', transcript: 'first part of the sentence' });
    }
    s.sendAudio(pcm(500));
    const t0 = Date.now();
    const text = await s.finish({ graceMs: 200 });
    assert.equal(text, expected);
    assert.ok(Date.now() - t0 < 2000, 'no long hang');
    s.close();
  });
}

test('Grok Voice: total silence after commit resolves empty instead of hanging 20 s', async (t) => {
  const mock = await startMock({ realtime: { mode: 'earlySegment', transcript: '' } });
  t.after(() => mock.close());
  const s = new GrokVoiceSession({ apiKey: 'test-key', url: mock.realtimeUrl, timeoutMs: 20000 });
  await s.connect();
  s.sendAudio(pcm(150)); // below the segment threshold: server sends nothing
  const t0 = Date.now();
  assert.equal(await s.finish({ graceMs: 200 }), '');
  assert.ok(Date.now() - t0 < 2000);
  s.close();
});

test('Grok Voice: too little audio returns empty without committing', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const s = new GrokVoiceSession({ apiKey: 'test-key', url: mock.realtimeUrl });
  s.connect();
  s.sendAudio(pcm(40));
  assert.equal(await s.finish(), '');
  assert.ok(!mock.log.realtime.some((e) => e.type === 'input_audio_buffer.commit'));
  s.close();
});

test('Grok Voice: bad API key surfaces a clear error', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const s = new GrokVoiceSession({ apiKey: 'wrong', url: mock.realtimeUrl, timeoutMs: 3000 });
  await assert.rejects(s.connect(), /401/);
});

test('Grok STT: streams PCM, merges finals, sends audio.done', async (t) => {
  const mock = await startMock();
  t.after(() => mock.close());
  const s = new GrokSttSession({ apiKey: 'test-key', url: mock.sttUrl, language: 'en-US', keyterms: ['GrokWhispers'] });
  const partials = [];
  s.on('partial', (p) => partials.push(p));
  s.connect();
  s.sendAudio(pcm(200));
  await s.readyPromise;
  const text = await s.finish();
  assert.equal(text, 'Hello world. This is a test.');
  assert.ok(partials.includes('Hello world. this is'));
  assert.ok(mock.log.stt.some((e) => e.type === 'audio.done'));

  const url = new URL(mock.log.urls[0], 'ws://x');
  assert.equal(url.searchParams.get('sample_rate'), '24000');
  assert.equal(url.searchParams.get('encoding'), 'pcm');
  assert.equal(url.searchParams.get('language'), 'en');
  assert.equal(url.searchParams.get('format'), 'true');
  assert.equal(url.searchParams.get('model'), 'grok-voice-transcribe-2.0');
  assert.deepEqual(url.searchParams.getAll('keyterm'), ['GrokWhispers']);
  assert.ok(Math.abs(s.billedSeconds - 0.2) < 1e-9);
});

test('mergeFinalTranscript handles full or partial transcript.done', () => {
  assert.equal(mergeFinalTranscript(['Hello world.', 'This is a test.'], 'Hello world. This is a test.'), 'Hello world. This is a test.');
  assert.equal(mergeFinalTranscript(['Hello world.'], 'This is a test.'), 'Hello world. This is a test.');
  assert.equal(mergeFinalTranscript([], 'Only done.'), 'Only done.');
  assert.equal(mergeFinalTranscript(['A b c.'], ''), 'A b c.');
});
