'use strict';

const path = require('node:path');
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, screen,
  systemPreferences, safeStorage, shell, globalShortcut, Notification, powerMonitor,
} = require('electron');

const { Config } = require('./config');
const { History } = require('./history');
const { ChordMachine, ChordRecorder, describeChord } = require('./hotkey');
const { insertText, frontmostAppName, which, isWayland, pickClipboard } = require('./inject');
const { DictationController, createEngine } = require('./dictation');
const { GrokVoiceSession } = require('../xai/realtime');
const logger = require('./log');
const { log } = logger;

const IS_MAC = process.platform === 'darwin';
const WAYLAND = process.platform === 'linux' && isWayland();
const SMOKE = process.argv.includes('--smoke-test');
const MIC_TEST = process.argv.includes('--mic-test');
const ROOT = path.join(__dirname, '..', '..');
const asset = (...p) => path.join(ROOT, 'assets', ...p);
const renderer = (...p) => path.join(ROOT, 'src', 'renderer', ...p);
const preload = (name) => path.join(ROOT, 'src', 'preload', `${name}.js`);

const NATIVE_WAYLAND = WAYLAND && (Boolean(process.env.GROKWHISPERS_NATIVE_WAYLAND) || !process.env.DISPLAY);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (WAYLAND && !NATIVE_WAYLAND && !process.argv.some((a) => a.startsWith('--ozone-platform'))) {
  // Native Wayland can't keep an overlay on top or position it, so run under
  // XWayland. The Ozone platform is fixed before JS runs, hence the relaunch.
  app.relaunch({ args: [...process.argv.slice(1), '--ozone-platform=x11'] });
  app.exit(0);
} else if (NATIVE_WAYLAND) {
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}

// A second launch forwards its CLI verb (--toggle etc.) to the running instance and exits.
const PRIMARY = SMOKE || MIC_TEST || app.requestSingleInstanceLock();
if (!PRIMARY) app.quit();

let uiohook = null;
try {
  if (!WAYLAND && !process.env.GROKWHISPERS_NO_UIOHOOK) uiohook = require('uiohook-napi');
} catch (err) {
  console.warn('[grokwhispers] uiohook-napi unavailable:', err.message);
}

let config;
let history;
let dictation;
let chord;
let tray;
let overlayWin;
let recorderWin;
let settingsWin;
let hotkeyRecorder = null;
let overlayHideTimer = null;

// ---------- recorder (hidden window that owns the mic) ----------

let recorderReady;
const pendingReplies = new Map();
let cmdSeq = 0;

let markRecorderReady = () => {};
let recorderGen = 0; // id of the latest start command; chunks from older captures are dropped
let recorderCrashes = [];

function recorderCommand(type, extra = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const id = ++cmdSeq;
    const t0 = Date.now();
    const timer = setTimeout(() => {
      pendingReplies.delete(id);
      log('recorder', `${type} timed out`, { id, ms: timeoutMs });
      reject(new Error(`recorder ${type} timed out`));
    }, timeoutMs);
    pendingReplies.set(id, (res) => {
      clearTimeout(timer);
      if (type !== 'devices') log('recorder', `${type} ${res.ok ? 'ok' : 'failed'}`, { id, ms: Date.now() - t0, error: res.error });
      if (res.ok) resolve(res);
      else reject(new Error(res.error));
    });
    if (type === 'start') recorderGen = id;
    recorderReady.then(() => recorderWin.webContents.send('recorder:command', { id, type, ...extra }));
  });
}

function resetRecorderReady() {
  recorderReady = new Promise((r) => { markRecorderReady = r; });
}

function createRecorderWindow() {
  resetRecorderReady();
  recorderWin = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    webPreferences: { preload: preload('recorder'), sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  lockDown(recorderWin);
  recorderWin.webContents.on('render-process-gone', () => {
    for (const cb of pendingReplies.values()) cb({ ok: false, error: 'recorder crashed' });
    pendingReplies.clear();
    resetRecorderReady();
    const now = Date.now();
    recorderCrashes = recorderCrashes.filter((t) => now - t < 60000).concat(now);
    if (recorderCrashes.length > 3) {
      ui.notify('The microphone process keeps crashing. Restart GrokWhispers.', 'error');
      return;
    }
    if (!recorderWin.isDestroyed()) recorderWin.reload();
  });
  recorderWin.loadFile(renderer('recorder', 'index.html'));
}

const fromRecorder = (e) => recorderWin && !recorderWin.isDestroyed() && e.sender === recorderWin.webContents;

ipcMain.on('recorder:ready', (e) => { if (fromRecorder(e)) markRecorderReady(); });
ipcMain.on('recorder:log', (e, msg, data) => { if (fromRecorder(e)) log('mic', String(msg).slice(0, 200), data); });

ipcMain.on('recorder:reply', (e, id, res) => {
  if (!fromRecorder(e)) return;
  const cb = pendingReplies.get(id);
  if (cb) { pendingReplies.delete(id); cb(res); }
});

let micTestSink = null;

ipcMain.on('recorder:chunk', (e, pcm, level, gen) => {
  if (!fromRecorder(e) || gen !== recorderGen) return;
  if (micTestSink) return micTestSink(level);
  if (!dictation) return;
  dictation.onAudio(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), level);
});

// No window in this app should ever navigate away or open new windows.
function lockDown(win) {
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

const recorder = {
  start: (deviceId) => recorderCommand('start', { deviceId }),
  stop: () => recorderCommand('stop'),
};

// ---------- overlay ----------

function createOverlayWindow() {
  const W = 440;
  const H = 170;
  overlayWin = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    type: IS_MAC ? 'panel' : 'toolbar',
    hiddenInMissionControl: true,
    webPreferences: { preload: preload('overlay'), sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  lockDown(overlayWin);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  overlayWin.loadFile(renderer('overlay', 'index.html'));
}

function showOverlay() {
  clearTimeout(overlayHideTimer);
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [w, h] = overlayWin.getSize();
  overlayWin.setPosition(Math.round(workArea.x + (workArea.width - w) / 2), Math.round(workArea.y + workArea.height - h - 24));
  if (!overlayWin.isVisible()) overlayWin.showInactive();
}

function hideOverlaySoon(ms) {
  clearTimeout(overlayHideTimer);
  overlayHideTimer = setTimeout(() => overlayWin?.hide(), ms);
}

const sendOverlay = (ch, payload) => overlayWin?.webContents.send(ch, payload);
let noticeUntil = 0;

const ui = {
  state(s) {
    sendOverlay('overlay:state', s);
    if (s.state === 'idle') hideOverlaySoon(Math.max(400, noticeUntil - Date.now()));
    else showOverlay();
    updateTray(s.state);
  },
  level: (n) => sendOverlay('overlay:level', n),
  caption: (t) => { if (config.settings.liveCaptions) sendOverlay('overlay:caption', t); },
  sound: (name) => sendOverlay('overlay:sound', name),
  notify(message, kind = 'info') {
    log('notice', kind, { message });
    showOverlay();
    sendOverlay('overlay:notice', { message, kind });
    const ms = kind === 'error' ? 6500 : 3000;
    noticeUntil = Date.now() + ms;
    if (dictation?.state === 'idle') hideOverlaySoon(ms);
    if (kind === 'error' && Notification.isSupported() && !SMOKE) {
      new Notification({ title: 'GrokWhispers', body: message, silent: true }).show();
    }
  },
};

// ---------- settings window ----------

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 520,
    title: 'GrokWhispers Settings',
    show: false,
    webPreferences: { preload: preload('settings'), sandbox: true, contextIsolation: true },
  });
  settingsWin.setMenuBarVisibility(false);
  lockDown(settingsWin);
  settingsWin.loadFile(renderer('settings', 'index.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  if (IS_MAC) app.dock?.show();
  settingsWin.on('closed', () => {
    settingsWin = null;
    if (IS_MAC) app.dock?.hide();
  });
}

// Settings IPC is only honored from the settings window itself.
function handleSettings(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents) throw new Error('unauthorized sender');
    return fn(e, ...args);
  });
}

function notifySettingsChanged() {
  settingsWin?.webContents.send('settings:changed');
  rebuildTrayMenu();
}

handleSettings('settings:get', () => ({
  settings: config.settings,
  apiKeySource: config.apiKeySource(),
  hotkeyLabel: hotkeyLabel(),
  platform: process.platform,
}));

handleSettings('settings:update', (_e, patch) => {
  const s = config.update(patch);
  if ('hotkey' in patch || 'handsFreeOnTap' in patch) chord?.configure({ chord: s.hotkey, handsFreeOnTap: s.handsFreeOnTap });
  history.limit = s.historyLimit;
  rebuildTrayMenu();
  return s;
});

handleSettings('settings:setApiKey', (_e, key) => {
  const src = config.setApiKey(key);
  rebuildTrayMenu();
  return src;
});

handleSettings('settings:testApiKey', async () => {
  const key = config.getApiKey();
  if (!key) return { ok: false, error: 'No API key saved.' };
  const model = config.settings.voiceModel;
  const t0 = Date.now();
  const s = new GrokVoiceSession({ apiKey: key, model, timeoutMs: 10000 });
  try {
    await s.connect();
    return { ok: true, model, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    s.close();
  }
});

handleSettings('hotkey:record', () => {
  if (!uiohook) {
    return { ok: false, error: WAYLAND
      ? 'Hold-to-talk hotkeys are unavailable on Wayland. Bind a desktop shortcut to "grokwhispers --toggle" instead.'
      : 'Keyboard hook unavailable. Check Accessibility permission.' };
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { hotkeyRecorder = null; resolve({ ok: false, error: 'No keys pressed.' }); }, 10000);
    hotkeyRecorder = {
      rec: new ChordRecorder(),
      done(keys) {
        clearTimeout(timer);
        hotkeyRecorder = null;
        if (keys.includes('Escape')) return resolve({ ok: false, error: 'Esc is reserved for cancelling.' });
        // The hook can't swallow keys, so a plain key would fire on every keystroke.
        if (!keys.some((k) => /^(Ctrl|Alt|Shift|Meta)/.test(k))) {
          return resolve({ ok: false, error: 'Include at least one modifier key (Ctrl, Option/Alt, Shift, Cmd/Super).' });
        }
        config.update({ hotkey: keys });
        chord.configure({ chord: keys });
        chord.reset();
        rebuildTrayMenu();
        resolve({ ok: true, label: hotkeyLabel() });
      },
    };
  });
});

handleSettings('recorder:devices', () => recorderCommand('devices').catch((e) => ({ ok: false, error: e.message })));

handleSettings('history:list', () => ({ entries: history.list(200), usage: history.usage() }));
handleSettings('history:clear', () => { history.clear(); return true; });
handleSettings('clipboard:copy', (_e, text) => { pickClipboard(clipboard).writeText(String(text)); return true; });

handleSettings('app:permissions', () => permissionReport());
handleSettings('app:openPermission', async (_e, kind) => {
  if (!IS_MAC) return;
  if (kind === 'microphone') {
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  } else if (kind === 'accessibility') {
    systemPreferences.isTrustedAccessibilityClient(true);
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  }
});

function permissionReport() {
  if (IS_MAC) {
    const mic = systemPreferences.getMediaAccessStatus('microphone');
    const ax = systemPreferences.isTrustedAccessibilityClient(false);
    return [
      { id: 'microphone', name: 'Microphone', ok: mic === 'granted', detail: 'Needed to hear you.', action: mic === 'granted' ? null : 'Grant' },
      { id: 'accessibility', name: 'Accessibility', ok: ax, detail: 'Needed to detect the hotkey and paste text. Restart GrokWhispers after granting it.', action: ax ? null : 'Open' },
    ];
  }
  const tools = WAYLAND ? ['wtype', 'ydotool'] : ['xdotool'];
  const found = tools.filter((t) => which(t));
  const wlClipboard = Boolean(which('wl-copy') && which('wl-paste'));
  return [
    ...(WAYLAND ? [{ id: 'wlclip', name: 'Clipboard tool (wl-clipboard)', ok: wlClipboard, detail: wlClipboard ? 'wl-copy / wl-paste found.' : 'Install wl-clipboard so GrokWhispers can set the clipboard on Wayland.' }] : []),
    { id: 'session', name: `Display server: ${WAYLAND ? 'Wayland' : 'X11'}`, ok: true, detail: WAYLAND ? 'Bind a desktop shortcut to "grokwhispers --toggle" for dictation.' : 'Global hold-to-talk hotkey is active.' },
    { id: 'hook', name: 'Keyboard hook', ok: Boolean(uiohook), detail: uiohook ? 'uiohook is running.' : 'Not available. Use the --toggle shortcut or the tray menu instead.' },
    { id: 'paste', name: `Paste tool (${tools.join(' or ')})`, ok: found.length > 0 || (!WAYLAND && Boolean(uiohook)), detail: found.length ? `Found: ${found.join(', ')}` : `Install ${tools.join(' or ')} for reliable pasting.` },
  ];
}

// ---------- hotkey ----------

let fallbackShortcut = '';

function hotkeyLabel() {
  if (!uiohook) {
    const viaShortcut = fallbackShortcut ? `${fallbackShortcut} (toggle)` : '';
    if (WAYLAND) return viaShortcut ? `${viaShortcut} or grokwhispers --toggle` : 'Desktop shortcut → grokwhispers --toggle';
    return viaShortcut || 'Unavailable';
  }
  return describeChord(config.settings.hotkey);
}

function keyNameMap() {
  const map = new Map();
  for (const [name, code] of Object.entries(uiohook.UiohookKey)) if (!map.has(code)) map.set(code, name);
  const K = uiohook.UiohookKey;
  for (const n of ['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight', 'Escape', 'Space']) {
    if (K[n] !== undefined) map.set(K[n], n);
  }
  return map;
}

function setupHotkeys() {
  const s = config.settings;
  chord = new ChordMachine({ chord: s.hotkey, handsFreeOnTap: s.handsFreeOnTap });
  chord.on('start', async () => {
    // If dictation couldn't start (e.g. no API key), don't leave the chord armed.
    if (!(await dictation.start()) && dictation.state === 'idle') chord.reset();
  });
  chord.on('lock', () => dictation.lock());
  chord.on('stop', () => dictation.stop());
  chord.on('cancel', () => dictation.cancel());
  for (const ev of ['start', 'lock', 'stop', 'cancel']) chord.on(ev, () => log('hotkey', ev, { pressed: [...chord.pressed].filter(isModifierName) }));
  dictation.on('state', (st) => {
    log('dictation', st);
    if (st === 'idle') chord.reset();
  });

  if (uiohook) {
    const names = keyNameMap();
    const { uIOhook } = uiohook;
    const onKey = (down) => (e) => {
      hookEvents += 1;
      // Ignore the keystrokes we synthesize ourselves while inserting text.
      if (injecting) { injectedEventsIgnored += 1; return; }
      const k = names.get(e.keycode) || `Key${e.keycode}`;
      if (hotkeyRecorder) {
        if (down) return hotkeyRecorder.rec.keydown(k);
        const done = hotkeyRecorder.rec.keyup(k);
        if (done) hotkeyRecorder.done(done);
        return;
      }
      if (isModifierName(k) || k === 'Escape') log('key', `${down ? 'down' : 'up'} ${k}`, { state: chord.state });
      if (down) chord.keydown(k);
      else chord.keyup(k);
    };
    uIOhook.on('keydown', onKey(true));
    uIOhook.on('keyup', onKey(false));
    uIOhook.on('mousemove', () => { hookEvents += 1; });
    try {
      uIOhook.start();
      log('hook', 'started');
      startHookWatchdog();
    } catch (err) {
      log('hook', 'failed to start', { error: err.message, code: err.code });
      console.warn('[grokwhispers] could not start keyboard hook:', err.message);
      uiohook = null;
    }
  }

  // Toggle shortcut fallback when the hook is unavailable. Under XWayland a
  // global grab only fires while an X11 window is focused, so don't offer it there.
  if (!uiohook && (!WAYLAND || NATIVE_WAYLAND)) {
    const [accel, label] = IS_MAC ? ['Control+Alt+Shift+Space', '⌃⌥⇧Space'] : ['Control+Alt+Space', 'Ctrl+Alt+Space'];
    try {
      if (globalShortcut.register(accel, toggleHandsFree)) fallbackShortcut = label;
    } catch { /* portal may be unavailable */ }
    if (!fallbackShortcut) console.warn('[grokwhispers] no global shortcut available; use --toggle or the tray menu');
  }

  // Keyups can be missed across sleep or the lock screen.
  for (const ev of ['resume', 'unlock-screen']) powerMonitor.on(ev, () => chord.clearPressed());
}

let hookEvents = 0;
let injecting = false;
let injectedEventsIgnored = 0;

const isModifierName = (k) => /^(Ctrl|Alt|Shift|Meta)(Right)?$/.test(k);

// macOS silently disables an event tap whose callback stalls, and the hook
// library only re-enables it in some cases. If the cursor moves but the hook
// has seen nothing at all, the tap is dead: restart it.
function startHookWatchdog() {
  let lastCount = hookEvents;
  let lastPoint = screen.getCursorScreenPoint();
  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    const moved = p.x !== lastPoint.x || p.y !== lastPoint.y;
    if (moved && hookEvents === lastCount && !injecting) {
      log('hook', 'stalled: cursor moved but no hook events; restarting');
      try {
        uiohook.uIOhook.stop();
        uiohook.uIOhook.start();
        chord.clearPressed();
        log('hook', 'restarted');
      } catch (err) {
        log('hook', 'restart failed', { error: err.message });
      }
    }
    lastCount = hookEvents;
    lastPoint = p;
  }, 3000).unref?.();
}

// Tray, CLI and fallback-shortcut activation. If starting fails, un-arm the chord.
function toggleHandsFree() {
  chord?.forceLock();
  return dictation.toggle().then((ok) => {
    if (!ok && dictation.state === 'idle') chord?.reset();
  });
}

function waitForKeysReleased(maxMs = 1500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (!chord?.modifiersHeld() || Date.now() - t0 > maxMs) return resolve();
      setTimeout(tick, 20);
    };
    tick();
  });
}

// ---------- tray ----------

function trayImage(active) {
  if (IS_MAC) {
    const img = nativeImage.createFromPath(asset(active ? 'trayActiveTemplate.png' : 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(asset(active ? 'tray-active.png' : 'tray.png'));
}

function createTray() {
  tray = new Tray(trayImage(false));
  tray.setToolTip('GrokWhispers');
  rebuildTrayMenu();
}

function updateTray(state) {
  if (!tray) return;
  tray.setImage(trayImage(state !== 'idle'));
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const s = config.settings;
  const st = dictation?.state || 'idle';
  const last = history.last();
  const set = (patch) => { config.update(patch); notifySettingsChanged(); };
  const menu = Menu.buildFromTemplate([
    { label: st === 'idle' ? `Hold ${hotkeyLabel()} to dictate` : st === 'listening' ? 'Listening…' : 'Processing…', enabled: false },
    { label: st === 'listening' ? 'Stop dictation' : 'Start dictation (hands-free)', enabled: st !== 'processing', click: toggleHandsFree },
    { type: 'separator' },
    { label: 'Paste last dictation', enabled: Boolean(last), click: () => insert(last.text).catch((e) => ui.notify(`Couldn't paste: ${e.message}`, 'error')) },
    { label: 'Copy last dictation', enabled: Boolean(last), click: () => pickClipboard(clipboard).writeText(last.text) },
    { type: 'separator' },
    {
      label: 'Engine',
      submenu: [
        { label: 'Grok Voice 3.0 (transcribe + polish)', type: 'radio', checked: s.engine === 'grok-voice-3', click: () => set({ engine: 'grok-voice-3' }) },
        { label: 'Grok Speech-to-Text (economy)', type: 'radio', checked: s.engine === 'grok-stt', click: () => set({ engine: 'grok-stt' }) },
      ],
    },
    { label: 'Polish with Grok', type: 'checkbox', checked: s.polish, enabled: s.engine === 'grok-voice-3', click: (i) => set({ polish: i.checked }) },
    {
      label: 'Style',
      submenu: ['auto', 'casual', 'formal', 'verbatim'].map((v) => ({
        label: v[0].toUpperCase() + v.slice(1), type: 'radio', checked: s.style === v, click: () => set({ style: v }),
      })),
    },
    { type: 'separator' },
    { label: config.apiKeySource() === 'none' ? 'Add xAI API key…' : 'Settings…', click: openSettings },
    { label: 'Quit GrokWhispers', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
}

// ---------- wiring ----------

async function insert(text) {
  const s = config.settings;
  const t0 = Date.now();
  injecting = true;
  injectedEventsIgnored = 0;
  try {
    const res = await insertText(text, {
      clipboard,
      uiohook,
      method: s.insertMethod,
      shortcut: s.pasteShortcut,
      restore: s.restoreClipboard,
    });
    log('insert', 'ok', { ...res, chars: text.length, ms: Date.now() - t0 });
    return res;
  } catch (err) {
    log('insert', 'failed', { method: s.insertMethod, error: err.message, leftOnClipboard: Boolean(err.leftOnClipboard), ms: Date.now() - t0 });
    throw err;
  } finally {
    // Let trailing synthetic key events drain, then forget any key state they left behind.
    setTimeout(() => {
      injecting = false;
      log('insert', 'guard released', { ignoredEvents: injectedEventsIgnored });
      chord?.clearPressed();
    }, 150);
  }
}

function handleArgs(argv) {
  if (!dictation) return; // still starting up
  if (argv.includes('--toggle')) toggleHandsFree();
  else if (argv.includes('--start')) { if (dictation.state === 'idle') toggleHandsFree(); }
  else if (argv.includes('--stop')) dictation.stop();
  else if (argv.includes('--cancel')) dictation.cancel();
  else if (argv.includes('--settings')) openSettings();
}

app.on('second-instance', (_e, argv) => {
  if (!config) return; // still starting up
  if (!argv.some((a) => /^--(toggle|start|stop|cancel)$/.test(a))) openSettings();
  else handleArgs(argv);
});

app.on('window-all-closed', () => {}); // tray app keeps running with no windows
app.on('activate', () => { if (config) openSettings(); }); // relaunch from Finder/Launchpad

app.whenReady().then(async () => {
  if (!PRIMARY) return;
  if (IS_MAC) app.dock?.hide();
  const dir = app.getPath('userData');
  logger.init(app.getPath('logs'));
  config = new Config(dir, { safeStorage });
  log('app', 'start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform}-${process.arch}`,
    packaged: app.isPackaged,
    wayland: WAYLAND,
    uiohookLoaded: Boolean(uiohook),
    accessibility: IS_MAC ? systemPreferences.isTrustedAccessibilityClient(false) : null,
    settings: (({ engine, insertMethod, pasteShortcut, hotkey, handsFreeOnTap, polish }) => ({ engine, insertMethod, pasteShortcut, hotkey, handsFreeOnTap, polish }))(config.settings),
  });
  history = new History(dir, { limit: config.settings.historyLimit });

  createRecorderWindow();
  createOverlayWindow();

  dictation = new DictationController({
    getSettings: () => config.settings,
    getApiKey: () => config.getApiKey(),
    createEngine,
    recorder,
    insert,
    frontmostApp: () => frontmostAppName(),
    waitForKeysReleased,
    history,
    ui,
    log,
  });
  dictation.on('needs-key', openSettings);
  dictation.on('done', () => rebuildTrayMenu());

  if (SMOKE) return runSmokeTest();
  if (MIC_TEST) return runMicTest();

  if (IS_MAC) {
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      systemPreferences.askForMediaAccess('microphone').catch(() => {});
    }
    if (!systemPreferences.isTrustedAccessibilityClient(false)) {
      systemPreferences.isTrustedAccessibilityClient(true); // shows the system prompt
    }
  }

  setupHotkeys();
  createTray();
  if (config.apiKeySource() === 'none') openSettings();
  handleArgs(process.argv);
});

app.on('will-quit', () => {
  try { uiohook?.uIOhook.stop(); } catch { /* ignore */ }
  globalShortcut.unregisterAll();
});

// Opens and closes the mic several times in a row, like consecutive dictations,
// and reports levels. Exact zeros mean the capture delivered digital silence.
async function runMicTest() {
  if (IS_MAC && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }
  const results = [];
  try {
    await recorderReady;
    for (let i = 1; i <= 3; i += 1) {
      const levels = [];
      micTestSink = (l) => levels.push(l);
      await recorder.start(config.settings.micDeviceId);
      await new Promise((r) => setTimeout(r, 1500));
      await recorder.stop();
      micTestSink = null;
      const peak = Math.max(0, ...levels);
      results.push({ capture: i, chunks: levels.length, peak: Math.round(peak * 10000) / 10000, zeroChunks: levels.filter((l) => l === 0).length });
      await new Promise((r) => setTimeout(r, 400));
    }
    const ok = results.every((r) => r.chunks > 0 && r.peak > 0);
    log('mic-test', ok ? 'pass' : 'fail', results);
    console.log(JSON.stringify({ result: ok ? 'MIC TEST PASS' : 'MIC TEST FAIL', results }));
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.log(JSON.stringify({ result: 'MIC TEST ERROR', error: err.message, results }));
    app.exit(2);
  }
}

// Launch every window, confirm the renderers load, then exit. Used by `npm run smoke`.
async function runSmokeTest() {
  const timeout = setTimeout(() => { console.error('SMOKE FAIL: timeout'); app.exit(1); }, 20000);
  try {
    openSettings();
    await Promise.all([
      recorderReady,
      new Promise((r) => overlayWin.webContents.once('did-finish-load', r)),
      new Promise((r) => settingsWin.webContents.once('did-finish-load', r)),
    ]);
    ui.state({ state: 'listening', handsFree: true });
    ui.level(0.1);
    ui.caption('smoke test caption');
    ui.state({ state: 'idle' });
    const got = await settingsWin.webContents.executeJavaScript('document.getElementById("hotkey").textContent.length > 0');
    if (!got) throw new Error('settings UI did not render');
    console.log('SMOKE OK');
    clearTimeout(timeout);
    app.exit(0);
  } catch (err) {
    console.error('SMOKE FAIL:', err.message);
    app.exit(1);
  }
}
