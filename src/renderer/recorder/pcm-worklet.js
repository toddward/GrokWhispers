// Runs on the audio thread at the device's native rate. Resamples to 24 kHz
// (Grok Voice's native rate) with linear interpolation, converts Float32 to
// 16-bit little-endian PCM, and posts 100 ms chunks with an RMS level.

const TARGET_RATE = 24000;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // input samples per output sample
    this.t = 0; // fractional read position relative to the current block
    this.prev = 0; // last sample of the previous block (index -1)
    this.size = TARGET_RATE / 10;
    this.buf = new Int16Array(this.size);
    this.n = 0;
    this.sumSq = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.emit(true);
    };
  }

  push(s) {
    const v = Math.max(-1, Math.min(1, s));
    this.buf[this.n] = v < 0 ? v * 0x8000 : v * 0x7fff;
    this.n += 1;
    this.sumSq += v * v;
    if (this.n === this.size) this.emit(false);
  }

  emit(final) {
    const pcm = this.buf.slice(0, this.n);
    const level = this.n ? Math.sqrt(this.sumSq / this.n) : 0;
    this.port.postMessage({ pcm: pcm.buffer, level, final }, [pcm.buffer]);
    this.n = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    const last = ch.length - 1;
    let t = this.t;
    while (t <= last) {
      const i = Math.floor(t);
      const frac = t - i;
      const a = i < 0 ? this.prev : ch[i];
      const b = i + 1 <= last ? ch[i + 1] : a;
      this.push(a + (b - a) * frac);
      t += this.ratio;
    }
    this.t = t - ch.length;
    this.prev = ch[last];
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
