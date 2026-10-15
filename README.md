# GrokWhispers

Hold a hotkey, speak, let go, and your words appear as clean text in whatever app you're using. GrokWhispers is a voice-typing tray app for **macOS and Linux**, powered by [xAI Grok Voice 3.0](https://x.ai/news/grok-voice-3).

- **No subscription and no account.** You bring your own xAI API key and pay xAI directly for what you use. GrokWhispers has no servers, telemetry, or paywall.
- **Works in any app.** Text goes into the focused field through the clipboard plus a synthesized paste, and your clipboard is restored afterwards.
- **Polished, not just transcribed.** Grok Voice 3.0 removes filler words, applies self-corrections ("at 3, no actually 4" becomes "at 4"), and adds punctuation in a style that fits the destination app.
- **Private by design.** History stays in a local file on your machine, and the API key is stored in your OS keychain.

## How it works

```
 hotkey down ─► mic (AudioWorklet, 24 kHz PCM16, 100 ms chunks)
                    │ IPC
                    ▼
            main process ── binary WebSocket frames ──► wss://api.x.ai/v1/realtime?model=grok-voice-3.0
                    │                                    (manual turns, turn_detection: null)
 hotkey up ─► input_audio_buffer.commit ──► conversation.item.input_audio_transcription.completed
                    │                                   (raw transcript; live captions while speaking)
                    ▼
            response.create {modalities:["text"], formatter instructions}
                    │                                   ──► response.output_text.delta … response.done
                    ▼
            divergence guard: if Grok answered instead of formatting, use the raw transcript
                    ▼
            clipboard snapshot → write text → ⌘V / Ctrl+V → restore clipboard (500 ms)
```

| Engine | What it does | xAI list price |
|---|---|---|
| **Grok Voice 3.0** (default) | Realtime speech-to-speech model used for transcription plus an LLM polish pass in the same session | ~$0.08 per session minute |
| **Grok Speech-to-Text** (economy) | `grok-voice-transcribe-2.0` streaming with server-side number/date formatting, no LLM rewrite | ~$0.20 per audio hour |

A session opens only while you dictate and closes right after the text is pasted, so a 10-second dictation costs about a cent with Grok Voice 3.0. The History tab shows your estimated spend.

## Install

Requirements: Node.js ≥ 22.12 and an [xAI API key](https://console.x.ai).

```bash
git clone git@github.com:toddward/GrokWhispers.git
cd GrokWhispers
npm install        # also downloads the Electron runtime
npm start
```

The settings window opens on first launch. Paste your API key, click **Test**, and you're ready.

You can also set `XAI_API_KEY` in the environment, which overrides the saved key.

### Build installers

```bash
npm run dist:mac     # .dmg + .zip
npm run dist:linux   # AppImage + .deb
```

Without a Developer ID, macOS builds are ad-hoc signed and run on the machine that built them. To get a notarizable build with the hardened runtime, set `CSC_LINK`/`CSC_NAME` to your Developer ID certificate before building. Release builds turn off Electron's `RunAsNode`, `NODE_OPTIONS` and `--inspect` fuses, so the app's microphone and Accessibility grants can't be borrowed by other processes.

## Using it

| Action | Default |
|---|---|
| Push-to-talk | Hold **⌃ Control + ⌥ Option** (macOS) or **Ctrl + Super** (Linux), speak, release |
| Hands-free | **Tap** the hotkey quickly, speak as long as you like, then tap again to insert |
| Cancel | **Esc** while listening |
| Paste / copy last dictation | Tray menu |

You can change the hotkey in Settings. Any combination works, such as Right ⌥ alone. If you press the chord together with another key within 300 ms (an ordinary shortcut like Ctrl+Alt+T), it's ignored.

**Settings:** engine, polish on/off, style (auto / casual / formal / verbatim), language hint, microphone, live captions, sounds, paste vs. type, and a custom vocabulary of up to 100 terms. The vocabulary is sent to Grok as recognition key terms.

## Platform notes

### macOS
On first run, grant **Microphone** and **Accessibility** permissions. Accessibility is needed to detect the hotkey and to paste. Restart GrokWhispers after granting Accessibility. The app lives in the menu bar and has no Dock icon.

**macOS virtual machines** (UTM, VirtualBuddy, Tart and other Apple Virtualization guests): the guest's "Apple Virtual Sound Device" can silence the microphone for a while after any sound plays, which makes the next dictation come back empty. GrokWhispers detects these VMs and turns its sound cues off by default. If dictations still come back as "No speech detected", check that the VM app has microphone access on the host Mac.

To check the mic pipeline, run `GrokWhispers.app/Contents/MacOS/GrokWhispers --mic-test`. It runs three back-to-back captures and writes the results to `~/Library/Logs/GrokWhispers/grokwhispers.log`. Add `--mic-test=full` to also run the overlay and cue steps.

### Linux (X11)
The global hold-to-talk hotkey works out of the box. Install `xdotool` for the most reliable pasting:
```bash
sudo apt install xdotool        # Debian/Ubuntu
sudo dnf install xdotool        # Fedora
```

### Linux (Wayland)
Wayland doesn't let apps watch the keyboard globally, so use a toggle instead:

1. Bind a desktop keyboard shortcut (GNOME: Settings → Keyboard → Custom Shortcuts; KDE: System Settings → Shortcuts) to:
   ```
   grokwhispers --toggle
   ```
   For a development checkout, run `npx electron /path/to/GrokWhispers --toggle`.
2. Install `wl-clipboard`, plus a paste tool. Use `wtype` on wlroots/KDE compositors, or `ydotool` ≥ 1.0 (with `ydotoold` running) on GNOME:
   ```bash
   sudo apt install wl-clipboard wtype     # or: ydotool
   ```

GrokWhispers relaunches itself under XWayland so its overlay can stay on top. Set `GROKWHISPERS_NATIVE_WAYLAND=1` to run as a native Wayland client instead, which also enables the Ctrl+Alt+Space portal shortcut where your desktop supports it.

`--start`, `--stop`, `--cancel`, and `--settings` are also available.

For terminals that paste with **Ctrl+Shift+V**, change *Paste shortcut* in Settings.

## Development

```bash
npm test         # unit + protocol tests against a local mock of the xAI APIs
npm run smoke    # launches Electron, loads every window, exits
npm run icons    # regenerate tray/app icons
```

Layout:

```
src/main/       main process: tray, windows, hotkey state machine, dictation flow, paste, settings, history
src/xai/        Grok Voice 3.0 realtime client, Grok STT client, polish prompt + divergence guard
src/renderer/   recorder (hidden mic window + AudioWorklet), overlay pill, settings UI
src/preload/    contextIsolated IPC bridges (all renderers are sandboxed)
test/           node:test suites + mock xAI WebSocket server
```

## Privacy

Audio goes only to `api.x.ai`, and only while you hold the hotkey or are in hands-free mode. Transcripts, history, and settings stay in your app data folder (`~/Library/Application Support/GrokWhispers` or `~/.config/GrokWhispers`). There's no analytics.

## License

MIT
