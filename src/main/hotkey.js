'use strict';

// Push-to-talk chord detection, independent of the key-event source.
//
//   hold chord          -> 'start' ... release -> 'stop'
//   quick tap (<tapMs)  -> 'start' then 'lock' (hands-free); tap again -> 'stop'
//   Esc while active    -> 'cancel'
//   chord + other key within tapMs (an ordinary shortcut like Ctrl+Alt+T) -> 'cancel'

const { EventEmitter } = require('node:events');

const GENERIC = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']);
const MODIFIERS = new Set(['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight']);

function tokenMatches(token, key) {
  return key === token || (GENERIC.has(token) && key === `${token}Right`);
}

class ChordMachine extends EventEmitter {
  constructor({ chord, tapMs = 300, handsFreeOnTap = true, now = () => Date.now() }) {
    super();
    this.pressed = new Set();
    this.state = 'idle'; // idle | holding | locked | suppressed
    this.now = now;
    this.configure({ chord, tapMs, handsFreeOnTap });
  }

  configure({ chord = this.chord, tapMs = this.tapMs, handsFreeOnTap = this.handsFreeOnTap }) {
    if (!Array.isArray(chord) || chord.length === 0) throw new Error('Hotkey chord must contain at least one key');
    this.chord = chord;
    this.tapMs = tapMs;
    this.handsFreeOnTap = handsFreeOnTap;
  }

  chordActive() {
    return this.chord.every((t) => [...this.pressed].some((k) => tokenMatches(t, k)));
  }

  isChordKey(key) {
    return this.chord.some((t) => tokenMatches(t, key));
  }

  anyChordKeyPressed() {
    return [...this.pressed].some((k) => this.isChordKey(k));
  }

  // Externally driven activation (tray click, CLI --toggle) enters hands-free.
  forceLock() {
    if (this.state === 'idle') this.state = 'locked';
  }

  // Called when dictation ends externally. If chord keys are still down (the
  // user is mid-shortcut), stay suppressed until they're released.
  reset() {
    this.state = this.anyChordKeyPressed() ? 'suppressed' : 'idle';
  }

  // After sleep/lock or a hook restart, keyups may have been missed.
  clearPressed() {
    this.pressed.clear();
    if (this.state === 'holding') {
      this.state = 'idle';
      this.emit('cancel'); // the release was never seen; don't paste a half-heard dictation
    } else if (this.state === 'suppressed') {
      this.state = 'idle';
    }
  }

  keydown(key) {
    if (this.pressed.has(key)) return; // auto-repeat
    this.pressed.add(key);

    if (key === 'Escape' && (this.state === 'holding' || this.state === 'locked')) {
      this.state = this.anyChordKeyPressed() ? 'suppressed' : 'idle';
      this.emit('cancel');
      return;
    }

    switch (this.state) {
      case 'idle':
        if (this.chordActive()) {
          this.state = 'holding';
          this.downAt = this.now();
          this.emit('start');
        }
        break;
      case 'holding':
        if (!this.isChordKey(key) && this.now() - this.downAt < this.tapMs) {
          this.state = 'suppressed';
          this.emit('cancel');
        }
        break;
      case 'locked':
        if (this.chordActive()) {
          this.state = 'suppressed';
          this.emit('stop');
        }
        break;
      default:
        break;
    }
  }

  keyup(key) {
    this.pressed.delete(key);
    if (this.state === 'holding' && !this.chordActive()) {
      const held = this.now() - this.downAt;
      if (this.handsFreeOnTap && held < this.tapMs) {
        this.state = 'locked';
        this.emit('lock');
      } else {
        this.state = 'idle';
        this.emit('stop');
      }
    } else if (this.state === 'suppressed' && !this.anyChordKeyPressed()) {
      this.state = 'idle';
    }
  }

  modifiersHeld() {
    return [...this.pressed].some((k) => MODIFIERS.has(k));
  }
}

// Records a chord: collects every key pressed until all are released.
class ChordRecorder {
  constructor() {
    this.down = new Set();
    this.seen = [];
  }

  keydown(key) {
    this.down.add(key);
    if (!this.seen.includes(key)) this.seen.push(key);
  }

  // Returns the finished chord once everything is released, else null.
  keyup(key) {
    this.down.delete(key);
    if (this.down.size > 0 || this.seen.length === 0) return null;
    const order = ['Ctrl', 'CtrlRight', 'Alt', 'AltRight', 'Shift', 'ShiftRight', 'Meta', 'MetaRight'];
    return [...this.seen].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }
}

function describeChord(chord, platform = process.platform) {
  const mac = platform === 'darwin';
  const names = {
    Ctrl: mac ? '⌃ Control' : 'Ctrl',
    CtrlRight: mac ? 'Right ⌃' : 'Right Ctrl',
    Alt: mac ? '⌥ Option' : 'Alt',
    AltRight: mac ? 'Right ⌥' : 'Right Alt',
    Shift: mac ? '⇧ Shift' : 'Shift',
    ShiftRight: 'Right Shift',
    Meta: mac ? '⌘ Command' : 'Super',
    MetaRight: mac ? 'Right ⌘' : 'Right Super',
  };
  return chord.map((k) => names[k] || k).join(' + ');
}

function defaultChord(platform = process.platform) {
  // uiohook can't observe the Fn/Globe key, so default to Ctrl+Option on macOS
  // and Ctrl+Super on Linux.
  return platform === 'darwin' ? ['Ctrl', 'Alt'] : ['Ctrl', 'Meta'];
}

module.exports = { ChordMachine, ChordRecorder, describeChord, defaultChord, tokenMatches };
