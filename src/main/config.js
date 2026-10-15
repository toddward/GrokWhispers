'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { defaultChord } = require('./hotkey');

const DEFAULTS = {
  engine: 'grok-voice-3', // 'grok-voice-3' (agent + polish) | 'grok-stt' (economy, transcription only)
  voiceModel: 'grok-voice-3.0',
  sttModel: 'grok-voice-transcribe-2.0',
  polish: true,
  style: 'auto',
  language: 'en',
  dictionary: [],
  hotkey: defaultChord(),
  handsFreeOnTap: true,
  insertMethod: 'paste', // 'paste' | 'type'
  pasteShortcut: 'auto', // 'auto' | 'ctrl+shift+v' | 'shift+insert'  (Linux only)
  restoreClipboard: true,
  sounds: true,
  liveCaptions: true,
  micDeviceId: '',
  maxSeconds: 360,
  historyLimit: 500,
};

class Config {
  constructor(dir, { safeStorage } = {}) {
    this.file = path.join(dir, 'settings.json');
    this.safeStorage = safeStorage;
    fs.mkdirSync(dir, { recursive: true });
    const stored = readJson(this.file);
    this.data = { ...DEFAULTS };
    for (const [k, v] of Object.entries(stored)) {
      if (!(k in DEFAULTS) || isValid(k, v)) this.data[k] = v; // drop corrupt values, keep key material
    }
  }

  get settings() {
    const { apiKeyEnc, apiKeyPlain, apiKeyBackend, ...rest } = this.data;
    return rest;
  }

  update(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULTS && isValid(k, v)) this.data[k] = v;
    }
    this.save();
    return this.settings;
  }

  // API key: env var wins; otherwise the OS keychain via Electron safeStorage.
  getApiKey() {
    if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY.trim();
    if (this.data.apiKeyEnc && this.safeStorage?.isEncryptionAvailable()) {
      try {
        return this.safeStorage.decryptString(Buffer.from(this.data.apiKeyEnc, 'base64'));
      } catch {
        return '';
      }
    }
    return this.data.apiKeyPlain || '';
  }

  apiKeySource() {
    if (process.env.XAI_API_KEY) return 'env';
    if (this.data.apiKeyEnc) {
      const backend = this.data.apiKeyBackend || this.safeStorage?.getSelectedStorageBackend?.();
      return backend === 'basic_text' ? 'file' : 'keychain';
    }
    if (this.data.apiKeyPlain) return 'file';
    return 'none';
  }

  setApiKey(key) {
    const k = (key || '').trim();
    delete this.data.apiKeyEnc;
    delete this.data.apiKeyPlain;
    delete this.data.apiKeyBackend;
    if (k) {
      if (this.safeStorage?.isEncryptionAvailable()) {
        this.data.apiKeyEnc = this.safeStorage.encryptString(k).toString('base64');
        // On Linux without a keyring, safeStorage falls back to a hardcoded key.
        this.data.apiKeyBackend = this.safeStorage.getSelectedStorageBackend?.() || 'os';
      } else {
        this.data.apiKeyPlain = k; // file is written 0600 below
      }
    }
    this.save();
    return this.apiKeySource();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

const ENUMS = {
  engine: ['grok-voice-3', 'grok-stt'],
  style: ['auto', 'casual', 'formal', 'verbatim'],
  insertMethod: ['paste', 'type'],
  pasteShortcut: ['auto', 'ctrl+shift+v', 'shift+insert'],
};

function isValid(key, v) {
  if (ENUMS[key]) return ENUMS[key].includes(v);
  switch (key) {
    case 'hotkey':
      return Array.isArray(v) && v.length > 0 && v.length <= 4 && v.every((k) => typeof k === 'string' && k.length < 24);
    case 'dictionary':
      return Array.isArray(v) && v.length <= 100 && v.every((w) => typeof w === 'string');
    case 'maxSeconds':
      return Number.isInteger(v) && v >= 10 && v <= 1200;
    case 'historyLimit':
      return Number.isInteger(v) && v >= 1 && v <= 10000;
    case 'language':
      return typeof v === 'string' && /^([A-Za-z]{2,3}(-[A-Za-z0-9]{2,4})?)?$/.test(v);
    default:
      return typeof v === typeof DEFAULTS[key];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

module.exports = { Config, DEFAULTS, isValid };
