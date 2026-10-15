'use strict';

// Loads the real AudioWorklet source with stand-ins for the audio-thread globals.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '../src/renderer/recorder/pcm-worklet.js'), 'utf8');

function load(sampleRate) {
  let Proc;
  const posted = [];
  class AudioWorkletProcessor {
    constructor() { this.port = { postMessage: (m) => posted.push(m), onmessage: null }; }
  }
  vm.runInNewContext(SRC, { sampleRate, AudioWorkletProcessor, registerProcessor: (_n, c) => { Proc = c; }, Math, Int16Array });
  return { proc: new Proc(), posted };
}

function feed(proc, rate, seconds, f = 440) {
  const total = Math.round(rate * seconds);
  for (let off = 0; off < total; off += 128) {
    const block = new Float32Array(Math.min(128, total - off));
    for (let i = 0; i < block.length; i += 1) block[i] = 0.5 * Math.sin((2 * Math.PI * f * (off + i)) / rate);
    proc.process([[block]]);
  }
}

const samples = (posted) => posted.reduce((n, m) => n + m.pcm.byteLength / 2, 0);

for (const rate of [48000, 44100, 24000, 16000]) {
  test(`resamples ${rate} Hz input to 24 kHz 100 ms chunks`, () => {
    const { proc, posted } = load(rate);
    feed(proc, rate, 1);
    proc.port.onmessage({ data: 'flush' });
    assert.ok(Math.abs(samples(posted) - 24000) <= 2, `got ${samples(posted)} samples for 1 s`);
    assert.ok(posted.slice(0, -1).every((m) => m.pcm.byteLength === 4800), 'full chunks are 100 ms');
    const rms = posted.at(-2).level;
    assert.ok(Math.abs(rms - 0.5 / Math.SQRT2) < 0.01, `sine RMS preserved, got ${rms}`);
  });
}

test('resampled 440 Hz tone keeps its pitch', () => {
  const { proc, posted } = load(48000);
  feed(proc, 48000, 0.5, 440);
  const pcm = new Int16Array(posted[2].pcm);
  let crossings = 0;
  for (let i = 1; i < pcm.length; i += 1) if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) crossings += 1;
  // 100 ms of 440 Hz ≈ 88 zero crossings
  assert.ok(Math.abs(crossings - 88) <= 2, `crossings ${crossings}`);
});

test('flush emits the partial tail', () => {
  const { proc, posted } = load(48000);
  feed(proc, 48000, 0.15);
  proc.port.onmessage({ data: 'flush' });
  const last = posted.at(-1);
  assert.equal(last.final, true);
  assert.equal(samples(posted), 3600);
});

test('digital silence reports level exactly 0', () => {
  const { proc, posted } = load(48000);
  for (let i = 0; i < 400; i += 1) proc.process([[new Float32Array(128)]]);
  assert.ok(posted.length > 0 && posted.every((m) => m.level === 0));
});
