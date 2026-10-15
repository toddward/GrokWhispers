'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChordMachine, ChordRecorder, describeChord } = require('../src/main/hotkey');
const { choosePolished, buildPolishInstructions, divergence } = require('../src/xai/polish');
const { planPaste, planType } = require('../src/main/inject');

function machine(opts = {}) {
  let t = 0;
  const m = new ChordMachine({ chord: ['Ctrl', 'Alt'], now: () => t, ...opts });
  const events = [];
  for (const e of ['start', 'stop', 'lock', 'cancel']) m.on(e, () => events.push(e));
  return { m, events, advance: (ms) => { t += ms; } };
}

test('hold chord starts, release stops', () => {
  const { m, events, advance } = machine();
  m.keydown('Ctrl');
  m.keydown('AltRight'); // generic Alt matches the right-hand key
  m.keydown('AltRight'); // auto-repeat ignored
  advance(1200);
  m.keyup('Ctrl');
  m.keyup('AltRight');
  assert.deepEqual(events, ['start', 'stop']);
  assert.equal(m.state, 'idle');
});

test('quick tap locks hands-free; next press stops', () => {
  const { m, events, advance } = machine();
  m.keydown('Ctrl'); m.keydown('Alt'); advance(120); m.keyup('Alt'); m.keyup('Ctrl');
  assert.deepEqual(events, ['start', 'lock']);
  advance(5000);
  m.keydown('Ctrl'); m.keydown('Alt');
  assert.deepEqual(events, ['start', 'lock', 'stop']);
  m.keyup('Alt'); m.keyup('Ctrl');
  assert.equal(m.state, 'idle');
  m.keydown('Ctrl'); m.keydown('Alt');
  assert.equal(events.at(-1), 'start', 'can start again afterwards');
});

test('chord used as a shortcut (Ctrl+Alt+T) cancels instead of dictating', () => {
  const { m, events, advance } = machine();
  m.keydown('Ctrl'); m.keydown('Alt'); advance(50); m.keydown('T');
  m.keyup('T'); m.keyup('Alt'); m.keyup('Ctrl');
  assert.deepEqual(events, ['start', 'cancel']);
  assert.equal(m.state, 'idle');
});

test('external reset while chord is held does not re-trigger on repeated shortcut', () => {
  const { m, events, advance } = machine();
  // Wire like main.js: dictation goes idle synchronously and resets the chord.
  m.on('cancel', () => m.reset());
  m.keydown('Ctrl'); m.keydown('Alt'); advance(30);
  m.keydown('T'); m.keyup('T'); advance(30);
  m.keydown('T'); m.keyup('T'); advance(30);
  m.keyup('Alt'); m.keyup('Ctrl');
  assert.deepEqual(events, ['start', 'cancel']);
  assert.equal(m.state, 'idle');
  m.keydown('Ctrl'); m.keydown('Alt');
  assert.equal(events.at(-1), 'start');
});

test('typing other keys late in a long hold does not cancel', () => {
  const { m, events, advance } = machine();
  m.keydown('Ctrl'); m.keydown('Alt'); advance(800); m.keydown('T'); m.keyup('T');
  advance(100); m.keyup('Alt');
  assert.deepEqual(events, ['start', 'stop']);
});

test('Esc cancels hands-free', () => {
  const { m, events, advance } = machine();
  m.keydown('Ctrl'); m.keydown('Alt'); advance(100); m.keyup('Alt'); m.keyup('Ctrl');
  m.keydown('Escape');
  assert.deepEqual(events, ['start', 'lock', 'cancel']);
  assert.equal(m.state, 'idle');
});

test('tap-to-lock can be disabled', () => {
  const { m, events, advance } = machine({ handsFreeOnTap: false });
  m.keydown('Ctrl'); m.keydown('Alt'); advance(100); m.keyup('Alt');
  assert.deepEqual(events, ['start', 'stop']);
});

test('chord recorder and labels', () => {
  const r = new ChordRecorder();
  r.keydown('Space'); r.keydown('Meta');
  assert.equal(r.keyup('Space'), null);
  assert.deepEqual(r.keyup('Meta'), ['Meta', 'Space']);
  assert.equal(describeChord(['Ctrl', 'Alt'], 'darwin'), '⌃ Control + ⌥ Option');
  assert.equal(describeChord(['Ctrl', 'Meta'], 'linux'), 'Ctrl + Super');
});

test('polish guard rejects an assistant-style answer, keeps a faithful rewrite', () => {
  const raw = 'um so what time is the meeting tomorrow';
  const good = choosePolished(raw, 'So, what time is the meeting tomorrow?');
  assert.equal(good.used, 'polished');
  const answer = choosePolished(raw, 'I don\'t have access to your calendar, but you can check Google Calendar for details.');
  assert.equal(answer.used, 'raw');
  assert.equal(answer.text, raw);
  assert.equal(choosePolished(raw, '').used, 'raw');
  assert.equal(choosePolished('hello there', '"Hello there."').text, 'Hello there.');
  assert.ok(divergence('send it at 3 no actually 4', 'Send it at 4.') < 0.55);
});

test('polish instructions carry context', () => {
  const p = buildPolishInstructions({ transcript: 'hi team', style: 'formal', appName: 'Mail', dictionary: ['Kubernetes'], language: 'en' });
  assert.match(p, /NOT a conversational assistant/);
  assert.match(p, /Destination app: Mail/);
  assert.match(p, /Preferred spellings: Kubernetes/);
  assert.match(p, /<<<\nhi team\n>>>/);
});

test('paste plans per platform', () => {
  const none = () => null;
  const all = () => '/usr/bin/x';
  assert.deepEqual(planPaste({ platform: 'darwin', env: {}, has: none })[0], { kind: 'uiohook', key: 'V', modifiers: ['Meta'] });

  const x11 = planPaste({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11' }, has: all });
  assert.deepEqual(x11[0], { kind: 'exec', cmd: 'xdotool', args: ['key', '--clearmodifiers', 'ctrl+v'] });
  assert.equal(x11.at(-1).kind, 'uiohook');

  const term = planPaste({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11' }, has: all, shortcut: 'ctrl+shift+v' });
  assert.deepEqual(term[0].args, ['key', '--clearmodifiers', 'ctrl+shift+v']);

  const wl = planPaste({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' }, has: all });
  assert.deepEqual(wl[0], { kind: 'exec', cmd: 'wtype', args: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'] });
  assert.deepEqual(wl[1], { kind: 'exec', cmd: 'ydotool', args: ['key', '29:1', '47:1', '47:0', '29:0'] });

  assert.deepEqual(planType({ platform: 'linux', env: {}, has: all, text: 'hi' })[0].args, ['type', '--clearmodifiers', '--delay', '2', '--', 'hi']);
  assert.match(planType({ platform: 'darwin', env: {}, text: 'say "hi"' })[0].args[1], /keystroke "say \\"hi\\""/);
});
