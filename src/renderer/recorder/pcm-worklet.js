// Runs on the audio thread. The AudioContext is created at 24 kHz (Grok Voice's
// native rate), so Chromium resamples the mic for us; here we convert Float32
// to 16-bit little-endian PCM and post 100 ms chunks with an RMS level.

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.buf = new Int16Array(this.size);
    this.n = 0;
    this.sumSq = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.emit(true);
    };
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
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += 1) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.n += 1;
      this.sumSq += s * s;
      if (this.n === this.size) this.emit(false);
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
