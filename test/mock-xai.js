'use strict';

// Minimal stand-in for api.x.ai's realtime and STT WebSockets, following the
// published event schemas closely enough to exercise the clients.

const http = require('node:http');
const { WebSocketServer } = require('ws');

function startMock({ realtime = {}, stt = {} } = {}) {
  const log = { realtime: [], stt: [], urls: [], headers: [] };
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    log.urls.push(req.url);
    log.headers.push(req.headers);
    if (req.headers.authorization !== 'Bearer test-key') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (req.url.startsWith('/v1/realtime')) realtimeSession(ws, realtime, log.realtime);
      else if (req.url.startsWith('/v1/stt')) sttSession(ws, stt, log.stt);
      else ws.close(1008);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        log,
        realtimeUrl: `ws://127.0.0.1:${port}/v1/realtime`,
        sttUrl: `ws://127.0.0.1:${port}/v1/stt`,
        close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); server.close(r); }),
      });
    });
  });
}

function realtimeSession(ws, opts, log) {
  const send = (o) => ws.send(JSON.stringify(o));
  let audioBytes = 0;
  let configured = false;
  send({ type: 'session.created', session: { id: 'sess_1' } });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      audioBytes += data.length;
      log.push({ type: '<binary>', bytes: data.length, beforeConfigured: !configured });
      return;
    }
    const ev = JSON.parse(data.toString());
    log.push(ev);
    switch (ev.type) {
      case 'session.update':
        if (opts.rejectAll) {
          send({ type: 'error', error: { type: 'invalid_request_error', message: opts.rejectAll } });
          return;
        }
        if (opts.forceVad) {
          send({ type: 'session.updated', session: { ...ev.session, turn_detection: { type: 'server_vad' } } });
          return;
        }
        if (opts.rejectTranscriptionModel && ev.session.audio?.input?.transcription?.model) {
          send({ type: 'error', error: { type: 'invalid_request_error', message: 'Unknown field: audio.input.transcription.model' } });
          return;
        }
        configured = true;
        send({ type: 'session.updated', session: ev.session });
        break;
      case 'input_audio_buffer.commit':
        send({ type: 'input_audio_buffer.committed', item_id: 'msg_1' });
        if (ev && ws.readyState === 1) {
          send({ type: 'conversation.item.input_audio_transcription.updated', item_id: 'msg_1', transcript: 'um so' });
          setTimeout(() => send({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'msg_1',
            transcript: opts.transcript ?? `um so what time is the meeting tomorrow (${audioBytes} bytes)`,
          }), 5);
        }
        break;
      case 'response.create': {
        send({ type: 'response.created', response: { id: 'resp_1' } });
        const out = opts.polished ?? 'So, what time is the meeting tomorrow?';
        const parts = out.match(/.{1,8}/gs) || [];
        parts.forEach((p, i) => setTimeout(() => send({ type: i % 2 ? 'response.text.delta' : 'response.output_text.delta', delta: p }), i));
        setTimeout(() => send({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } }), parts.length + 5);
        break;
      }
      default:
        break;
    }
  });
}

function sttSession(ws, opts, log) {
  const send = (o) => ws.send(JSON.stringify(o));
  let bytes = 0;
  send({ type: 'transcript.created' });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      bytes += data.length;
      log.push({ type: '<binary>', bytes: data.length });
      if (bytes >= 4800 && !log.sentPartials) {
        log.sentPartials = true;
        send({ type: 'transcript.partial', text: 'hello', is_final: false, speech_final: false });
        send({ type: 'transcript.partial', text: 'Hello world.', is_final: true, speech_final: false });
        send({ type: 'transcript.partial', text: 'this is', is_final: false, speech_final: false });
      }
      return;
    }
    const ev = JSON.parse(data.toString());
    log.push(ev);
    if (ev.type === 'audio.done') {
      send({ type: 'transcript.partial', text: 'This is a test.', is_final: true, speech_final: true });
      send({ type: 'transcript.done', text: opts.doneText ?? 'Hello world. This is a test.', duration: bytes / 48000 });
      setTimeout(() => ws.close(1000), 5);
    }
  });
}

module.exports = { startMock };
