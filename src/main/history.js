'use strict';

// Local-only dictation history (JSON Lines). Nothing leaves the machine.

const fs = require('node:fs');
const path = require('node:path');

// Published xAI prices (USD), used only for the local spend estimate.
const PRICE_PER_SECOND = {
  'grok-voice-3': 0.08 / 60, // Voice Agent API: $0.08 per session minute
  'grok-stt': 0.2 / 3600, // streaming STT: $0.20 per audio hour
};

class History {
  constructor(dir, { limit = 500 } = {}) {
    this.file = path.join(dir, 'history.jsonl');
    this.limit = limit;
    this.entries = [];
    try {
      this.entries = fs.readFileSync(this.file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { /* first run */ }
    if (this.entries.length > limit) this._rewrite();
  }

  add(entry) {
    const e = { id: cryptoId(), ts: new Date().toISOString(), ...entry };
    e.estCostUsd = estimateCost(e.engine, e.billedSeconds);
    this.entries.push(e);
    if (this.entries.length > this.limit) this._rewrite();
    else fs.appendFileSync(this.file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    return e;
  }

  list(n = 100) {
    return this.entries.slice(-n).reverse();
  }

  last() {
    return this.entries[this.entries.length - 1] || null;
  }

  usage() {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let month = 0;
    let all = 0;
    let words = 0;
    for (const e of this.entries) {
      all += e.estCostUsd || 0;
      words += (e.text || '').split(/\s+/).filter(Boolean).length;
      if ((e.ts || '').startsWith(monthKey)) month += e.estCostUsd || 0;
    }
    return { monthUsd: round(month), totalUsd: round(all), dictations: this.entries.length, words };
  }

  clear() {
    this.entries = [];
    this._rewrite();
  }

  _rewrite() {
    this.entries = this.limit > 0 ? this.entries.slice(-this.limit) : [];
    const body = this.entries.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(this.file, body ? `${body}\n` : '', { mode: 0o600 });
  }
}

function estimateCost(engine, seconds = 0) {
  return round((PRICE_PER_SECOND[engine] || 0) * seconds, 5);
}

function round(n, d = 4) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function cryptoId() {
  return require('node:crypto').randomUUID();
}

module.exports = { History, estimateCost, PRICE_PER_SECOND };
