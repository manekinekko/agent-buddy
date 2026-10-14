import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');

test('voice settings explain permissions, session separation and unencrypted Wi-Fi audio', () => {
  assert.match(html, /Voice history is kept in its own persisted Copilot CLI session/);
  assert.match(html, /It is not the current Copilot app chat/);
  assert.match(html, /run shell commands and edit files/);
  assert.match(html, /Wi-Fi audio is not encrypted/);
  assert.match(html, /microphone and speaker audio travel over plain HTTP/);
});

test('voice controls are capability-gated and expose dependencies and recovery actions', () => {
  assert.match(html, /id="tab-voice"[^>]*hidden/);
  assert.match(html, /id="voice-microphone-state"/);
  assert.match(html, /id="voice-speaker-state"/);
  assert.match(html, /id="voice-dep-whisper"/);
  assert.match(html, /id="voice-dep-model"/);
  assert.match(html, /id="voice-dep-ffmpeg"/);
  assert.match(html, /id="voice-dep-copilot"/);
  assert.match(html, /id="voice-session-reset"/);
  assert.match(html, /id="voice-cancel"/);
  assert.match(html, /id="voice-tts-test"/);
  assert.match(script, /status\?\.capabilities/);
  assert.match(script, /capabilities\.speaker === false/);
  assert.match(script, /capabilities\.microphone !== false/);
});
