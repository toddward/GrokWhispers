// Hidden window that owns the microphone.
const api = window.grokRecorder;
const SAMPLE_RATE = 24000;

let active = null; // { stream, ctx, node, done }

async function start(deviceId, gen) {
  if (active) await stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      // Raw audio transcribes best; browser DSP smears consonants.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  let ctx;
  let node;
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
    const mute = ctx.createGain();
    mute.gain.value = 0; // keep the graph pulled without audible output
    source.connect(node).connect(mute).connect(ctx.destination);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    throw err;
  }

  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  node.port.onmessage = (e) => {
    const { pcm, level, final } = e.data;
    if (pcm.byteLength) api.chunk(new Uint8Array(pcm), level, gen);
    if (final) resolveDone();
  };
  active = { stream, ctx, node, done };
}

async function stop() {
  const a = active;
  if (!a) return;
  active = null;
  a.node.port.postMessage('flush');
  await Promise.race([a.done, new Promise((r) => setTimeout(r, 500))]);
  a.stream.getTracks().forEach((t) => t.stop());
  await a.ctx.close().catch(() => {});
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
    api.reply(cmd.id, { ok: false, error: err.message || String(err) });
  }
}

api.ready();
