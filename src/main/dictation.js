'use strict';

// Orchestrates one dictation: mic -> Grok -> (polish) -> paste -> history.
// All side effects are injected so the flow can be tested without Electron.

const { EventEmitter } = require('node:events');
const { GrokVoiceSession } = require('../xai/realtime');
const { GrokSttSession } = require('../xai/stt');
const { SESSION_INSTRUCTIONS, buildPolishInstructions, choosePolished } = require('../xai/polish');

const MIN_SPEECH_BYTES = 24000 * 2 * 0.25; // 250 ms of audio

function createEngine(settings, apiKey, overrides = {}) {
  if (settings.engine === 'grok-stt') {
    return new GrokSttSession({
      apiKey,
      model: settings.sttModel,
      language: settings.language,
      keyterms: settings.dictionary,
      ...overrides,
    });
  }
  return new GrokVoiceSession({
    apiKey,
    model: settings.voiceModel,
    instructions: SESSION_INSTRUCTIONS,
    language: settings.language,
    keyterms: settings.dictionary,
    liveCaptions: settings.liveCaptions,
    ...overrides,
  });
}

class DictationController extends EventEmitter {
  /**
   * deps: {
   *   getSettings(), getApiKey(), createEngine(settings, key),
   *   recorder: { start(deviceId), stop() },
   *   insert(text), frontmostApp(), waitForKeysReleased(),
   *   history: { add(entry) }, ui: { state(s), level(n), caption(t), sound(name), notify(msg, kind) },
   * }
   */
  constructor(deps) {
    super();
    this.deps = deps;
    this.log = deps.log || (() => {});
    this.state = 'idle'; // idle | listening | processing
    this.current = null;
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.deps.ui.state({ state, ...extra });
    this.emit('state', state);
  }

  async start({ handsFree = false } = {}) {
    if (this.state !== 'idle') {
      this.log('dictation', 'start ignored', { state: this.state });
      return false;
    }
    const { deps } = this;
    const settings = deps.getSettings();
    const apiKey = deps.getApiKey();
    if (!apiKey) {
      deps.ui.notify('Add your xAI API key in GrokWhispers settings to start dictating.', 'error');
      deps.ui.sound('error');
      this.emit('needs-key');
      return false;
    }

    const session = {
      startedAt: Date.now(),
      settings,
      appName: '',
      engine: deps.createEngine(settings, apiKey),
      handsFree,
      cancelled: false,
      acceptingAudio: true, // stays true until the recorder has flushed its last chunk
    };
    this.current = session;
    // The overlay appears when the session arms, so shortcut false-starts don't flash it.
    this.state = 'listening';
    this.emit('state', 'listening');

    deps.frontmostApp().then((name) => { session.appName = name || ''; }).catch(() => {});
    session.engine.on('partial', (t) => { if (this.current === session) deps.ui.caption(t); });
    session.engine.on('failure', (err) => {
      this.log('engine', 'failure', { error: err.message });
      session.failure = err;
      // Surface a dropped connection right away instead of letting the user keep talking.
      if (this.current === session && this.state === 'listening') this.stop();
    });

    // Arm after a short grace period, so a chord-prefixed shortcut (e.g. Ctrl+Option+T)
    // never opens a billed Grok session or beeps. Audio captured meanwhile is buffered.
    session.armTimer = setTimeout(() => this._arm(session), deps.armDelayMs ?? 150);
    session.maxTimer = setTimeout(() => this.stop(), settings.maxSeconds * 1000);
    try {
      await deps.recorder.start(settings.micDeviceId);
    } catch (err) {
      this.log('dictation', 'mic start failed', { error: err.message });
      this._abort(session, `Microphone unavailable: ${err.message}`);
      return false;
    }
    return this.current === session;
  }

  _arm(session, { quiet = false } = {}) {
    if (this.current !== session || session.armed) return;
    session.armed = true;
    clearTimeout(session.armTimer);
    if (!quiet) {
      this.deps.ui.state({ state: 'listening', handsFree: session.handsFree });
      if (session.settings.sounds) this.deps.ui.sound('start');
    }
    const t0 = Date.now();
    session.engine.connect().then(
      () => this.log('engine', 'ready', { engine: session.settings.engine, ms: Date.now() - t0 }),
      (err) => this.log('engine', 'connect failed', { error: err.message, ms: Date.now() - t0 }),
    );
  }

  lock() {
    if (this.state === 'listening' && this.current) {
      this.current.handsFree = true;
      if (this.current.armed) this.deps.ui.state({ state: 'listening', handsFree: true });
    }
  }

  onAudio(chunk, level) {
    const s = this.current;
    if (!s || !s.acceptingAudio) return;
    s.chunks = (s.chunks || 0) + 1;
    s.peak = Math.max(s.peak || 0, level || 0);
    s.levelSum = (s.levelSum || 0) + (level || 0);
    s.engine.sendAudio(chunk);
    if (this.state === 'listening') this.deps.ui.level(level);
  }

  async toggle() {
    if (this.state === 'idle') return this.start({ handsFree: true });
    if (this.state === 'listening') return this.stop();
    return false;
  }

  async stop() {
    const s = this.current;
    if (this.state !== 'listening' || !s) return null;
    const { deps } = this;
    clearTimeout(s.maxTimer);
    clearTimeout(s.armTimer);
    const wasArmed = s.armed;
    this.state = 'processing';
    if (wasArmed) {
      this._setState('processing', { step: 'transcribing' });
      if (s.settings.sounds) deps.ui.sound('stop');
    }

    let entry = null;
    try {
      await deps.recorder.stop(); // resolves after the final partial chunk was delivered
      s.acceptingAudio = false;
      if (s.failure) throw s.failure;
      if (s.engine.audioBytes < MIN_SPEECH_BYTES) {
        deps.ui.notify('Hold the hotkey while you speak.', 'info');
        return null;
      }
      if (!wasArmed) {
        // Very short press: connect only now that there's enough audio to transcribe.
        this._arm(s, { quiet: true });
        this._setState('processing', { step: 'transcribing' });
      }

      const tFinish = Date.now();
      const raw = await s.engine.finish();
      this.log('engine', 'transcribed', {
        chars: raw.length,
        audioBytes: s.engine.audioBytes,
        ms: Date.now() - tFinish,
        audio: audioStats(s),
        server: s.engine.diagnostics,
      });
      if (s.cancelled) return null;
      if (!raw) {
        deps.ui.notify('No speech detected.', 'info');
        return null;
      }

      let text = raw;
      let polishedUsed = 'raw';
      let divergence = 0;
      if (s.settings.polish && typeof s.engine.polish === 'function') {
        this._setState('processing', { step: 'polishing' });
        try {
          const polished = await s.engine.polish(buildPolishInstructions({
            transcript: raw,
            style: s.settings.style,
            appName: s.appName,
            dictionary: s.settings.dictionary,
            language: s.settings.language,
          }));
          const choice = choosePolished(raw, polished);
          text = choice.text;
          polishedUsed = choice.used;
          divergence = choice.score;
          this.log('engine', 'polished', { used: choice.used, divergence: Math.round(choice.score * 100) / 100 });
        } catch (err) {
          polishedUsed = 'raw-fallback';
          this.log('engine', 'polish failed', { error: err.message });
        }
      }
      s.engine.close();
      if (s.cancelled) return null;

      await deps.waitForKeysReleased();
      if (s.cancelled) return null;
      let inserted = true;
      try {
        await deps.insert(text);
      } catch (err) {
        inserted = false;
        const where = err.leftOnClipboard ? 'so the text is on your clipboard' : 'but the text is saved in History';
        deps.ui.notify(`Couldn't insert automatically, ${where}. ${err.message}`, 'error');
      }

      entry = deps.history.add({
        text,
        raw,
        app: s.appName,
        engine: s.settings.engine,
        polish: polishedUsed,
        divergence: Math.round(divergence * 100) / 100,
        durationMs: Date.now() - s.startedAt,
        audioSeconds: Math.round((s.engine.audioBytes / 48000) * 10) / 10,
        billedSeconds: Math.round(s.engine.billedSeconds * 10) / 10,
        inserted,
      });
      this.emit('done', entry);
      return entry;
    } catch (err) {
      this.log('dictation', 'stop failed', { error: err.message, cancelled: s.cancelled, audio: audioStats(s), server: s.engine.diagnostics });
      if (!s.cancelled) {
        deps.ui.notify(friendlyError(err), 'error');
        if (s.settings.sounds) deps.ui.sound('error');
      }
      return null;
    } finally {
      s.engine.close();
      if (this.current === s) {
        this.current = null;
        this._setState('idle');
      }
    }
  }

  async cancel() {
    const s = this.current;
    if (!s) return;
    s.cancelled = true;
    s.acceptingAudio = false;
    clearTimeout(s.maxTimer);
    clearTimeout(s.armTimer);
    s.engine.cancel();
    this.current = null;
    this._setState('idle');
    if (s.settings.sounds && s.armed) this.deps.ui.sound('cancel'); // silent for shortcut false-starts
    try { await this.deps.recorder.stop(); } catch { /* ignore */ }
  }

  _abort(session, message) {
    session.acceptingAudio = false;
    clearTimeout(session.maxTimer);
    clearTimeout(session.armTimer);
    session.engine.close();
    if (this.current !== session) return; // a newer dictation owns the UI now
    this.deps.recorder.stop().catch(() => {}); // queued after any in-flight start, so the mic closes
    this.current = null;
    this._setState('idle');
    this.deps.ui.notify(message, 'error');
    if (session.settings.sounds) this.deps.ui.sound('error');
  }
}

// RMS level of the captured audio, to tell silence from a server problem.
function audioStats(s) {
  const chunks = s.chunks || 0;
  return { chunks, peak: round3(s.peak || 0), mean: round3(chunks ? s.levelSum / chunks : 0) };
}
const round3 = (n) => Math.round(n * 1000) / 1000;

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/401|api key|unauthor/i.test(msg)) return 'xAI rejected your API key. Check it in Settings.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network/i.test(msg)) return 'Can\'t reach api.x.ai. Check your connection.';
  if (/Timed out/i.test(msg)) return 'Grok Voice took too long to respond. Please try again.';
  return msg;
}

module.exports = { DictationController, createEngine, friendlyError };
