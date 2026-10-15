'use strict';

// Small diagnostic log (~/Library/Logs/GrokWhispers or ~/.config/GrokWhispers/logs).
// Records states, timings and errors only, never transcripts or typed keys.

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
let file = null;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'grokwhispers.log');
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && st.size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    file = null;
  }
  return file;
}

function log(scope, msg, data) {
  const line = `${new Date().toISOString()} [${scope}] ${msg}${data === undefined ? '' : ` ${safeJson(data)}`}`;
  if (process.env.GROKWHISPERS_DEBUG) console.log(line);
  if (!file) return;
  try { fs.appendFileSync(file, `${line}\n`); } catch { /* best effort */ }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = { init, log, get file() { return file; } };
