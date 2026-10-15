const api = window.grokOverlay;
const $ = (id) => document.getElementById(id);
const pill = $('pill');
const label = $('label');
const badge = $('badge');
const caption = $('caption');
const notice = $('notice');
const bars = [...document.querySelectorAll('#bars i')];
const history = new Array(bars.length).fill(0);

let noticeTimer = null;

api.on('overlay:state', ({ state, handsFree, step }) => {
  pill.dataset.state = state;
  if (state === 'idle') {
    pill.classList.add('hidden');
    caption.classList.add('hidden');
    caption.textContent = '';
    history.fill(0);
    renderBars();
    return;
  }
  notice.classList.add('hidden');
  pill.classList.remove('hidden');
  badge.classList.toggle('hidden', !(state === 'listening' && handsFree));
  if (state === 'listening') label.textContent = handsFree ? 'Listening' : 'Listening — release to insert';
  if (state === 'processing') label.textContent = step === 'polishing' ? 'Polishing…' : 'Transcribing…';
});

api.on('overlay:level', (rms) => {
  // RMS -> perceptual 0..1 (≈ -60 dBFS floor)
  const db = 20 * Math.log10(rms + 1e-8);
  const v = Math.max(0, Math.min(1, (db + 60) / 50));
  history.push(v);
  history.shift();
  renderBars();
});

function renderBars() {
  bars.forEach((b, i) => {
    const center = 1 - Math.abs(i - (bars.length - 1) / 2) / bars.length;
    b.style.height = `${3 + history[i] * 17 * (0.6 + 0.4 * center)}px`;
  });
}

api.on('overlay:caption', (text) => {
  if (!text) return;
  caption.textContent = text.length > 220 ? `…${text.slice(-220)}` : text;
  caption.classList.remove('hidden');
});

api.on('overlay:notice', ({ message, kind }) => {
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.classList.remove('hidden');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.add('hidden'), kind === 'error' ? 6000 : 2500);
});

// Short synthesized cues, so no audio assets need to ship.
let audioCtx = null;
const CUES = {
  start: [[587, 0], [880, 0.07]],
  stop: [[880, 0], [587, 0.07]],
  cancel: [[440, 0], [330, 0.08]],
  error: [[220, 0], [196, 0.12]],
};

api.on('overlay:sound', (name) => {
  const cue = CUES[name];
  if (!cue) return;
  audioCtx = audioCtx || new AudioContext();
  const t0 = audioCtx.currentTime + 0.01;
  for (const [freq, offset] of cue) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0 + offset);
    gain.gain.linearRampToValueAtTime(0.12, t0 + offset + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.12);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + offset);
    osc.stop(t0 + offset + 0.14);
  }
});
