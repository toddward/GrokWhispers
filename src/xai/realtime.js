'use strict';

// Grok Voice 3.0 client over the xAI Realtime WebSocket API.
//
// Dictation flow (manual turn mode, i.e. push-to-talk):
//   connect -> session.created -> session.update -> session.updated (ready)
//   binary PCM frames while the hotkey is held
//   input_audio_buffer.commit  -> conversation.item.input_audio_transcription.completed  (raw ASR)
//   response.create (text only, formatter instructions) -> response.output_text.delta* -> response.done
//
// Protocol reference: https://docs.x.ai/developers/rest-api-reference/inference/voice

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { EventWaiters, serverError } = require('./waiters');

const REALTIME_URL = 'wss://api.x.ai/v1/realtime';
const SAMPLE_RATE = 24000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit mono
const MIN_AUDIO_BYTES = BYTES_PER_SECOND / 10; // 100 ms
const MAX_BUFFERED_BYTES = BYTES_PER_SECOND * 60 * 10;

class GrokVoiceSession extends EventEmitter {
  constructor({
    apiKey,
    model = 'grok-voice-3.0',
    url = REALTIME_URL,
    reasoningEffort = 'none',
    instructions = '',
    language = '',
    keyterms = [],
    liveCaptions = true,
    timeoutMs = 20000,
    WebSocketImpl = WebSocket,
  }) {
    super();
    if (!apiKey) throw new Error('Missing xAI API key');
    Object.assign(this, { apiKey, model, url, reasoningEffort, instructions, language, keyterms, liveCaptions, timeoutMs, WebSocketImpl });
    this.waiters = new EventWaiters();
    this.pending = [];
    this.pendingBytes = 0;
    this.bytesSent = 0;
    this.isReady = false;
    this.closed = false;
    this.retriedWithoutCaptionModel = false;
    this.connectedAt = 0;
    this.closedAt = 0;
  }

  connect() {
    if (this.readyPromise) return this.readyPromise;
    const u = new URL(this.url);
    u.searchParams.set('model', this.model);
    if (this.reasoningEffort) u.searchParams.set('reasoning.effort', this.reasoningEffort);

    this.ws = new this.WebSocketImpl(u.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}`, 'User-Agent': 'GrokWhispers/0.1' },
    });
    this.connectedAt = Date.now();
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return; // we request text-only responses
      let ev;
      try { ev = JSON.parse(data.toString()); } catch { return; }
      this._onEvent(ev);
    });
    this.ws.on('error', (err) => this._fail(err));
    this.ws.on('close', (code, reason) => {
      this.closedAt = this.closedAt || Date.now();
      if (!this.closed) this._fail(new Error(`Grok Voice connection closed (${code}${reason?.length ? `: ${reason}` : ''})`));
    });
    this.ws.on('unexpected-response', (_req, res) => {
      this._fail(new Error(res.statusCode === 401 ? 'xAI rejected the API key (401)' : `xAI handshake failed (HTTP ${res.statusCode})`));
    });

    this.readyPromise = this.waiters
      .waitFor((ev) => ev.type === 'session.updated', { timeoutMs: this.timeoutMs, label: 'session.updated' })
      .then((ev) => {
        // Push-to-talk needs manual turns; never stream into a server-VAD session.
        const td = ev.session?.turn_detection;
        if (td && td.type) {
          const err = new Error(`Grok Voice kept turn detection "${td.type}"; manual turns are required`);
          this._fail(err);
          throw err;
        }
        this.isReady = true;
        this._flush();
      });
    this.readyPromise.catch(() => {}); // surfaced via finish()
    return this.readyPromise;
  }

  sessionConfig({ includeCaptionModel = this.liveCaptions && !this.retriedWithoutCaptionModel } = {}) {
    const transcription = {};
    if (includeCaptionModel) transcription.model = 'grok-transcribe'; // enables live `.updated` captions
    if (this.language) transcription.language_hint = this.language;
    const terms = cleanKeyterms(this.keyterms);
    if (terms.length) transcription.keyterms = terms;
    return {
      type: 'session.update',
      session: {
        model: this.model,
        instructions: this.instructions,
        turn_detection: { type: null }, // manual push-to-talk turns
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: SAMPLE_RATE },
            transport: 'binary',
            transcription,
          },
        },
      },
    };
  }

  _onEvent(ev) {
    switch (ev.type) {
      case 'session.created':
        this._send(this.sessionConfig());
        break;
      case 'conversation.item.input_audio_transcription.updated':
        this.emit('partial', ev.transcript || '');
        break;
      case 'response.output_text.delta':
      case 'response.text.delta':
        this.responseText += ev.delta || '';
        break;
      case 'response.output_audio_transcript.delta':
        this.responseAudioTranscript += ev.delta || '';
        break;
      case 'error':
        if (!this.isReady) {
          // The caption model is an optional extension; if the server rejects it,
          // retry once without it. Any other setup error fails fast with its message.
          const e = ev.error || ev;
          const aboutCaptionModel = /transcription|grok-transcribe/i.test(`${e.param || ''} ${e.message || ''}`);
          if (aboutCaptionModel && this.liveCaptions && !this.retriedWithoutCaptionModel) {
            this.retriedWithoutCaptionModel = true;
            this._send(this.sessionConfig({ includeCaptionModel: false }));
            return;
          }
          this._fail(serverError(ev));
          return;
        }
        this.emit('serverError', ev.error || ev);
        break;
      default:
        break;
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

  // Commit the held audio and return the raw transcript.
  async finish() {
    await this.connect();
    if (this.closed) throw this.failure || new Error('Session closed');
    if (this.bytesSent < MIN_AUDIO_BYTES) return '';
    const done = this.waiters.waitFor(
      (ev) => ev.type === 'conversation.item.input_audio_transcription.completed',
      { timeoutMs: this.timeoutMs, rejectOnError: true, label: 'transcription' },
    );
    this._send({ type: 'input_audio_buffer.commit' });
    const ev = await done;
    return (ev.transcript || '').trim();
  }

  // Ask Grok Voice to turn the committed utterance into polished written text.
  async polish(instructions) {
    if (this.closed) throw this.failure || new Error('Session closed');
    this.responseText = '';
    this.responseAudioTranscript = '';
    const done = this.waiters.waitFor((ev) => ev.type === 'response.done', {
      timeoutMs: this.timeoutMs,
      rejectOnError: true,
      label: 'response.done',
    });
    this._send({ type: 'response.create', response: { modalities: ['text'], instructions } });
    await done;
    return (this.responseText || this.responseAudioTranscript).trim();
  }

  cancel() {
    if (this.isReady) this._send({ type: 'input_audio_buffer.clear' });
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.closedAt = Date.now();
    this.waiters.failAll(new Error('Session closed'));
    try { this.ws?.close(1000); } catch { /* already closed */ }
  }

  // Wall-clock seconds the socket was open; Grok Voice is billed per session minute.
  get billedSeconds() {
    if (!this.connectedAt) return 0;
    return ((this.closedAt || Date.now()) - this.connectedAt) / 1000;
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
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

function cleanKeyterms(terms) {
  const out = [];
  const seen = new Set();
  for (const raw of terms || []) {
    const t = String(raw).trim().slice(0, 50);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === 100) break;
  }
  return out;
}

module.exports = { GrokVoiceSession, cleanKeyterms, SAMPLE_RATE, BYTES_PER_SECOND, REALTIME_URL };
