'use strict';

// Inserts text into whatever app has focus via the clipboard:
// snapshot clipboard -> write text -> synthesize paste ->
// restore the clipboard ~800 ms later (only if nothing else changed it).

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

function which(cmd, envPath = process.env.PATH || '') {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, cmd);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch { /* keep looking */ }
  }
  return null;
}

function isWayland(env = process.env) {
  return env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
}

// Ordered list of strategies for synthesizing the paste shortcut.
// Each is either {kind:'uiohook', key, modifiers} or {kind:'exec', cmd, args}.
function planPaste({ platform = process.platform, env = process.env, shortcut = 'auto', has = (c) => which(c, env.PATH) }) {
  const plans = [];
  if (platform === 'darwin') {
    plans.push({ kind: 'uiohook', key: 'V', modifiers: ['Meta'] });
    plans.push({ kind: 'exec', cmd: 'osascript', args: ['-e', 'tell application "System Events" to keystroke "v" using command down'] });
    return plans;
  }

  const combo = shortcut === 'ctrl+shift+v' ? ['ctrl', 'shift'] : ['ctrl'];
  if (shortcut === 'shift+insert') {
    if (isWayland(env)) {
      if (has('wtype')) plans.push({ kind: 'exec', cmd: 'wtype', args: ['-M', 'shift', '-k', 'Insert', '-m', 'shift'] });
      if (has('ydotool')) plans.push({ kind: 'exec', cmd: 'ydotool', args: ['key', '42:1', '110:1', '110:0', '42:0'] });
    } else if (has('xdotool')) {
      plans.push({ kind: 'exec', cmd: 'xdotool', args: ['key', '--clearmodifiers', 'shift+Insert'] });
    }
    plans.push({ kind: 'uiohook', key: 'Insert', modifiers: ['Shift'] });
    return plans;
  }

  if (isWayland(env)) {
    if (has('wtype')) {
      const args = [];
      for (const m of combo) args.push('-M', m);
      args.push('-k', 'v');
      for (const m of [...combo].reverse()) args.push('-m', m);
      plans.push({ kind: 'exec', cmd: 'wtype', args });
    }
    if (has('ydotool')) {
      // Linux input event codes: 29 = LEFTCTRL, 42 = LEFTSHIFT, 47 = V
      const codes = combo.map((m) => (m === 'ctrl' ? 29 : 42));
      const args = ['key', ...codes.map((c) => `${c}:1`), '47:1', '47:0', ...[...codes].reverse().map((c) => `${c}:0`)];
      plans.push({ kind: 'exec', cmd: 'ydotool', args });
    }
  } else if (has('xdotool')) {
    plans.push({ kind: 'exec', cmd: 'xdotool', args: ['key', '--clearmodifiers', combo.concat('v').join('+')] });
  }
  plans.push({ kind: 'uiohook', key: 'V', modifiers: combo.map((m) => (m === 'ctrl' ? 'Ctrl' : 'Shift')) });
  return plans;
}

// Strategies for typing text directly (fallback mode, no clipboard involved).
function planType({ platform = process.platform, env = process.env, text, has = (c) => which(c, env.PATH) }) {
  if (platform === 'darwin') {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return [{ kind: 'exec', cmd: 'osascript', args: ['-e', `tell application "System Events" to keystroke "${escaped}"`] }];
  }
  const plans = [];
  if (isWayland(env)) {
    if (has('wtype')) plans.push({ kind: 'exec', cmd: 'wtype', args: ['--', text] });
    if (has('ydotool')) plans.push({ kind: 'exec', cmd: 'ydotool', args: ['type', '--', text] });
  } else if (has('xdotool')) {
    plans.push({ kind: 'exec', cmd: 'xdotool', args: ['type', '--clearmodifiers', '--delay', '2', '--', text] });
  }
  return plans;
}

function run(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr?.toString().trim() || err.message}`));
      else resolve();
    });
  });
}

async function runPlans(plans, uiohook, timeoutMs) {
  const errors = [];
  for (const p of plans) {
    try {
      if (p.kind === 'uiohook') {
        if (!uiohook) throw new Error('uiohook unavailable');
        const { uIOhook, UiohookKey } = uiohook;
        uIOhook.keyTap(UiohookKey[p.key], p.modifiers.map((m) => UiohookKey[m]));
      } else {
        await run(p.cmd, p.args, timeoutMs);
      }
      return p;
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`Could not send keystrokes. ${errors.join('; ') || 'No input tool available.'}`);
}

function snapshotClipboard(clipboard) {
  const snap = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF() };
  const img = clipboard.readImage();
  if (img && !img.isEmpty()) snap.image = img;
  return snap;
}

function restoreClipboard(clipboard, snap) {
  const data = {};
  if (snap.text) data.text = snap.text;
  if (snap.html) data.html = snap.html;
  if (snap.rtf) data.rtf = snap.rtf;
  if (snap.image) data.image = snap.image;
  if (Object.keys(data).length) clipboard.write(data);
  else clipboard.clear();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A background app can't set the Wayland selection itself (compositors require
// input focus), so use wl-clipboard there. Only plain text survives a restore.
function waylandClipboard() {
  // wl-copy forks a server that holds the selection; feed it on stdin and don't wait on its stdout.
  const copy = (args, input) => execFileSync('wl-copy', args, { input, timeout: 1500, stdio: ['pipe', 'ignore', 'ignore'] });
  const writeText = (t) => copy([], t);
  return {
    textOnly: true,
    settleMs: 150, // GNOME's wl-copy briefly takes focus; let it return to the target app
    readText: () => {
      try {
        return execFileSync('wl-paste', ['--no-newline', '--type', 'text'], { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      } catch { return ''; }
    },
    readHTML: () => '',
    readRTF: () => '',
    readImage: () => null,
    writeText,
    write: (data) => (data.text ? writeText(data.text) : copy(['--clear'])),
    clear: () => copy(['--clear']),
  };
}

function pickClipboard(clipboard, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'linux' && isWayland(env) && which('wl-copy', env.PATH) && which('wl-paste', env.PATH)) return waylandClipboard();
  return clipboard;
}

async function insertText(text, { clipboard: electronClipboard, uiohook, method = 'paste', shortcut = 'auto', restore = true, restoreDelayMs = 800, platform, env } = {}) {
  if (!text) return { method: 'none' };
  const clipboard = pickClipboard(electronClipboard, { platform, env });

  // Typed newlines become Return (which sends chat messages), so multi-line text is pasted.
  if (method === 'type' && !text.includes('\n')) {
    const plans = planType({ platform, env, text });
    if (plans.length) {
      try {
        await runPlans(plans, uiohook, 4000 + text.length * 20);
        return { method: 'type' };
      } catch (e) {
        try {
          clipboard.writeText(text);
          e.leftOnClipboard = true;
        } catch { /* keep the original error */ }
        throw e;
      }
    }
    // fall through to paste when no typing tool exists
  }

  let snap = restore ? snapshotClipboard(clipboard) : null;
  // A text-only clipboard tool can't put back an image or file, so leave those alone.
  if (snap && clipboard.textOnly && !snap.text) snap = null;
  clipboard.writeText(text);
  await sleep(clipboard.settleMs || 30); // let the pasteboard settle before the target app reads it
  try {
    const used = await runPlans(planPaste({ platform, env, shortcut }), uiohook);
    if (snap) {
      setTimeout(() => {
        // Don't clobber something the user copied in the meantime.
        if (clipboard.readText() === text) restoreClipboard(clipboard, snap);
      }, restoreDelayMs);
    }
    return { method: 'paste', via: used.kind === 'exec' ? used.cmd : 'uiohook' };
  } catch (e) {
    // Leave the transcript on the clipboard so the user can paste manually.
    e.leftOnClipboard = true;
    throw e;
  }
}

async function frontmostAppName({ platform = process.platform, env = process.env } = {}) {
  const exec = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 400 }, (err, out) => resolve(err ? '' : out.toString().trim()));
  });
  try {
    if (platform === 'darwin') {
      // lsappinfo needs no Automation permission, unlike AppleScript/System Events.
      const asn = await exec('lsappinfo', ['front']);
      if (!asn) return '';
      const info = await exec('lsappinfo', ['info', '-only', 'name', asn]);
      const m = info.match(/"(?:LSDisplayName|name)"\s*=\s*"([^"]+)"/i);
      return m ? m[1] : '';
    }
    if (!isWayland(env) && which('xdotool', env.PATH)) {
      return await exec('xdotool', ['getactivewindow', 'getwindowclassname']);
    }
  } catch { /* best effort */ }
  return '';
}

module.exports = { insertText, planPaste, planType, frontmostAppName, which, isWayland, snapshotClipboard, restoreClipboard, pickClipboard };
