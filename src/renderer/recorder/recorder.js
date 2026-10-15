// Hidden window that owns the microphone.
//
// The AudioContext is created once and suspended between dictations.
// Re-creating the capture graph for every dictation can make Chromium on macOS
// deliver pure digital silence on later captures, so only the mic stream is
// opened per dictation, and a silent start (exact zeros) reopens the mic.
const api = window.grokRecorder;

const SILENT_START_CHUNKS = 4; // 400 ms of exact zeros
const MAX_REOPENS = 2;

let ctx = null;
let workletLoaded = false;
let active = null; // { stream, source, node, done, gen }

async function audioContext() {
  if (!ctx || ctx.state === 'closed') {
    ctx = new AudioContext({ latencyHint: 'interactive' }); // device's native rate
    workletLoaded = false;
  }
  if (!workletLoaded) {
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    workletLoaded = true;
  }
  if (ctx.state !== 'running') await ctx.resume();
  return ctx;
}

function openMic(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      // Raw audio transcribes best; browser DSP smears consonants.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
}

function describeTrack(stream) {
  const t = stream.getAudioTracks()[0];
  if (!t) return { track: 'none' };
  const s = t.getSettings ? t.getSettings() : {};
  return { label: t.label, muted: t.muted, readyState: t.readyState, deviceRate: s.sampleRate, ctxRate: ctx?.sampleRate, ctxState: ctx?.state };
}

async function start(deviceId, gen) {
  if (active) await stop();
  const c = await audioContext();
  const stream = await openMic(deviceId);
  let source;
  let node;
  try {
    source = c.createMediaStreamSource(stream);
    node = new AudioWorkletNode(c, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
    const mute = c.createGain();
    mute.gain.value = 0; // keep the graph pulled without audible output
    source.connect(node).connect(mute).connect(c.destination);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw err;
  }
  api.log('mic opened', { gen, ...describeTrack(stream) });

  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const session = { stream, source, node, done, gen, zeroChunks: 0, heard: false, reopens: 0 };

  node.port.onmessage = (e) => {
    const { pcm, level, final } = e.data;
    if (pcm.byteLength) api.chunk(new Uint8Array(pcm), level, gen);
    if (final) { resolveDone(); return; }
    // Silent-start guard: exact digital zeros mean the capture didn't start.
    if (!session.heard) {
      if (level > 0) session.heard = true;
      else if (++session.zeroChunks >= SILENT_START_CHUNKS && session.reopens < MAX_REOPENS) {
        session.zeroChunks = 0;
        session.reopens += 1;
        reopen(session, deviceId);
      }
    }
  };
  active = session;
}

async function reopen(session, deviceId) {
  api.log('silent start detected; reopening mic', { gen: session.gen, attempt: session.reopens, ...describeTrack(session.stream) });
  try {
    const fresh = await openMic(deviceId);
    if (active !== session) { fresh.getTracks().forEach((t) => t.stop()); return; }
    session.source.disconnect();
    session.stream.getTracks().forEach((t) => t.stop());
    session.stream = fresh;
    session.source = ctx.createMediaStreamSource(fresh);
    session.source.connect(session.node);
    api.log('mic reopened', { gen: session.gen, ...describeTrack(fresh) });
  } catch (err) {
    api.log('mic reopen failed', { error: err.message });
  }
}

async function stop() {
  const a = active;
  if (!a) return;
  active = null;
  a.node.port.postMessage('flush');
  await Promise.race([a.done, new Promise((r) => setTimeout(r, 500))]);
  try { a.source.disconnect(); a.node.disconnect(); } catch { /* already disconnected */ }
  a.stream.getTracks().forEach((t) => t.stop());
  if (ctx && ctx.state === 'running') await ctx.suspend().catch(() => {});
  api.log('mic closed', { gen: a.gen, heardAudio: a.heard, reopens: a.reopens });
}

// Commands run strictly in order, so a stop that arrives while getUserMedia is
// still pending runs after the start completes and closes the mic.
let queue = Promise.resolve();
api.onCommand((cmd) => {
  queue = queue.then(() => handle(cmd));
});

async function handle(cmd) {
  try {
    if (cmd.type === 'start') {
      await start(cmd.deviceId, cmd.id);
      api.reply(cmd.id, { ok: true });
    } else if (cmd.type === 'stop') {
      await stop();
      api.reply(cmd.id, { ok: true });
    } else if (cmd.type === 'devices') {
      const devices = await navigator.mediaDevices.enumerateDevices();
      api.reply(cmd.id, {
        ok: true,
        devices: devices.filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' })),
      });
    }
  } catch (err) {
    api.log('command failed', { type: cmd.type, error: err.message || String(err) });
    api.reply(cmd.id, { ok: false, error: err.message || String(err) });
  }
}

api.ready();
