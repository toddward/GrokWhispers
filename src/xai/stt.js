'use strict';

// "Economy" engine: xAI streaming Speech-to-Text (grok-voice-transcribe-2.0).
// Much cheaper than the Grok Voice 3.0 agent session, but no LLM polish step;
// formatting comes from the server's inverse text normalization (`format=true`).
//
//   connect -> transcript.created (ready) -> binary PCM frames
//   transcript.partial (interim / is_final segments)
//   {"type":"audio.done"} -> transcript.done -> server closes

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { EventWaiters, serverError } = require('./waiters');
const { cleanKeyterms, SAMPLE_RATE, BYTES_PER_SECOND } = require('./realtime');

const STT_URL = 'wss://api.x.ai/v1/stt';
const FORMAT_LANGUAGES = new Set(['ar', 'de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'sv', 'vi', 'zh']);
const MIN_AUDIO_BYTES = BYTES_PER_SECOND / 10;
const MAX_BUFFERED_BYTES = BYTES_PER_SECOND * 60 * 10;

class GrokSttSession extends EventEmitter {
  constructor({
    apiKey,
    model = 'grok-voice-transcribe-2.0',
    url = STT_URL,
    language = 'en',
    keyterms = [],
    timeoutMs = 20000,
    WebSocketImpl = WebSocket,
  }) {
    super();
    if (!apiKey) throw new Error('Missing xAI API key');
    Object.assign(this, { apiKey, model, url, language, keyterms, timeoutMs, WebSocketImpl });
    this.waiters = new EventWaiters();
    this.pending = [];
    this.pendingBytes = 0;
    this.bytesSent = 0;
    this.finals = [];
    this.interim = '';
    this.isReady = false;
    this.closed = false;
    this.connectedAt = 0;
    this.closedAt = 0;
  }

  buildUrl() {
    const u = new URL(this.url);
    const p = u.searchParams;
    p.set('sample_rate', String(SAMPLE_RATE));
    p.set('encoding', 'pcm');
    p.set('model', this.model);
    p.set('interim_results', 'true');
    const lang = (this.language || '').split('-')[0].toLowerCase();
    if (lang) {
      p.set('language', lang);
      if (FORMAT_LANGUAGES.has(lang)) p.set('format', 'true');
    }
    for (const t of cleanKeyterms(this.keyterms)) p.append('keyterm', t);
    return u.toString();
  }

  connect() {
    if (this.readyPromise) return this.readyPromise;
    this.ws = new this.WebSocketImpl(this.buildUrl(), {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'User-Agent': 'GrokWhispers/0.1' },
    });
    this.connectedAt = Date.now();
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let ev;
      try { ev = JSON.parse(data.toString()); } catch { return; }
      this._onEvent(ev);
    });
    this.ws.on('error', (err) => this._fail(err));
    this.ws.on('close', (code) => {
      this.closedAt = this.closedAt || Date.now();
      if (!this.closed) this._fail(new Error(`Grok STT connection closed (${code})`));
    });
    this.ws.on('unexpected-response', (_req, res) => {
      this._fail(new Error(res.statusCode === 401 ? 'xAI rejected the API key (401)' : `xAI handshake failed (HTTP ${res.statusCode})`));
    });
    this.readyPromise = this.waiters
      .waitFor((ev) => ev.type === 'transcript.created', { timeoutMs: this.timeoutMs, label: 'transcript.created' })
      .then(() => {
        this.isReady = true;
        this._flush();
      });
    this.readyPromise.catch(() => {});
    return this.readyPromise;
  }

  _onEvent(ev) {
    if (ev.type === 'transcript.partial' && ev.text) {
      if (ev.is_final) {
        this.finals.push(ev.text.trim());
        this.interim = '';
      } else {
        this.interim = ev.text.trim();
      }
      this.emit('partial', [...this.finals, this.interim].filter(Boolean).join(' '));
    } else if (ev.type === 'error') {
      if (!this.isReady) {
        this._fail(serverError(ev));
        return;
      }
      this.emit('serverError', ev.error || ev);
    }
    this.waiters.dispatch(ev);
  }

  sendAudio(chunk) {
    if (this.closed) return;
    if (this.isReady && this.ws.readyState === 1) {
      this.ws.send(chunk, { binary: true });
      this.bytesSent += chunk.length;
    } else if (this.pendingBytes < MAX_BUFFERED_BYTES) {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
    }
  }

  get audioBytes() {
    return this.bytesSent + this.pendingBytes;
  }

  _flush() {
    const chunks = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    for (const c of chunks) this.sendAudio(c);
  }

  async finish() {
    await this.connect();
    if (this.closed) throw this.failure || new Error('Session closed');
    if (this.bytesSent < MIN_AUDIO_BYTES) return '';
    const done = this.waiters.waitFor((ev) => ev.type === 'transcript.done', {
      timeoutMs: this.timeoutMs,
      rejectOnError: true,
      label: 'transcript.done',
    });
    this.ws.send(JSON.stringify({ type: 'audio.done' }));
    const ev = await done;
    this.closed = true; // server closes the socket after transcript.done
    this.closedAt = Date.now();
    return mergeFinalTranscript(this.finals, ev.text);
  }

  cancel() {
    this.close();
  }

  close() {
    if (this.closed && !this.ws) return;
    this.closed = true;
    this.closedAt = this.closedAt || Date.now();
    this.waiters.failAll(new Error('Session closed'));
    try { this.ws?.close(1000); } catch { /* ignore */ }
  }

  get diagnostics() {
    return { finals: this.finals.length, interimChars: this.interim.length };
  }

  get billedSeconds() {
    // Streaming STT is billed on audio duration, not connection time.
    return this.bytesSent / BYTES_PER_SECOND;
  }

  _fail(err) {
    if (this.closed) return;
    this.failure = err;
    this.closed = true;
    this.closedAt = Date.now();
    this.emit('failure', err);
    this.waiters.failAll(err);
    try { this.ws?.terminate(); } catch { /* ignore */ }
  }
}

// transcript.done may carry the full transcript or only the flushed remainder;
// prefer whichever reading keeps every finalized segment.
function mergeFinalTranscript(finals, doneText) {
  const assembled = finals.filter(Boolean).join(' ').trim();
  const tail = (doneText || '').trim();
  if (!tail) return assembled;
  if (!assembled) return tail;
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (norm(tail).includes(norm(assembled))) return tail;
  if (norm(assembled).includes(norm(tail))) return assembled;
  return `${assembled} ${tail}`;
}

module.exports = { GrokSttSession, mergeFinalTranscript, STT_URL };
