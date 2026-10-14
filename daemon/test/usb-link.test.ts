import assert from 'node:assert/strict';
import test from 'node:test';
import {SerialPortMock} from 'serialport';
import {UsbTransport} from '../src/usb-transport.js';

const MockBinding = SerialPortMock.binding;
type MockPortBinding = Awaited<ReturnType<typeof MockBinding.open>>;
const path = process.platform === 'win32' ? 'COM9' : '/dev/cu.usbmodem9001';
// The preferred port passes the platform's port-name filter on every CI runner.
process.env.AGENT_COMPANION_PORT = path;
const openPort = MockBinding.open.bind(MockBinding);

// A device on the mock port that answers INFO, orientation, state, and upload requests. After
// an upload it restarts, and `silentAfterRestart` makes it stop answering, as a wedged USB link does.
function fakeDevice(options: {silentAfterRestart: boolean; silent?: boolean; stuckDrain?: boolean}) {
  MockBinding.reset();
  MockBinding.createPort(path, {echo: false, record: false, vendorId: '303a', productId: '1001'});
  const state = {character: 'copilot', silent: options.silent ?? false, received: 0, uploading: false};
  MockBinding.open = async openOptions => {
    const binding: MockPortBinding = await openPort(openOptions);
    const write = binding.write.bind(binding);
    // Like tcdrain on macOS when the device stops reading its USB port: it never returns.
    const drain = binding.drain.bind(binding);
    binding.drain = () => state.silent && options.stuckDrain ? new Promise<void>(() => undefined) : drain();
    const reply = (line: string): void => { setImmediate(() => binding.isOpen && binding.emitData(`${line}\n`)); };
    binding.write = async (buffer: Buffer) => {
      await write(buffer);
      if (state.silent) return;
      const text = buffer.toString('latin1');
      if (state.uploading) {
        state.received += buffer.length;
        if (state.received < 8) return reply(`UPLOAD_ACK received=${state.received}`);
        state.uploading = false;
        state.character = 'bunny';
        reply('UPLOAD_OK character=bunny stalls=0 resyncs=0 rebooting');
        if (options.silentAfterRestart) state.silent = true;
        else setTimeout(() => reply('READY: character=bunny'), 5);
        return;
      }

      if (text === 'i') return reply(`INFO protocol=12 firmware=0123456789abcdef character=${state.character}`);
      if (text === 'o') return reply('ORIENTATION_SETTINGS offset_tenths=0');
      if (text === 'u') {
        state.uploading = true;
        state.received = 0;
        return reply('UPLOAD_READY max_bytes=4096 chunk=256');
      }
      const command = /^!(\w+)\n$/.exec(text);
      if (command) reply(`COMMAND accepted=${command[1]}`);
    };
    return binding;
  };
  return state;
}

function fakeVoiceDevice(options: {capture?: Buffer; trailerId?: number} = {}) {
  MockBinding.reset();
  MockBinding.createPort(path, {echo: false, record: false, vendorId: '303a', productId: '1001'});
  const capture = options.capture ?? Buffer.from([0x0a, 0xff, 0xc3, 0x28, 0x00, 0x80, 0x0d, 0x0a]);
  const state = {playback: Buffer.alloc(0), expected: 0};
  let binding: MockPortBinding;
  MockBinding.open = async openOptions => {
    binding = await openPort(openOptions);
    const write = binding.write.bind(binding);
    const emit = (data: string | Buffer): void => {
      setImmediate(() => binding.isOpen && binding.emitData(data));
    };
    const line = (text: string): void => emit(`${text}\n`);
    binding.write = async (buffer: Buffer) => {
      await write(buffer);
      if (state.expected) {
        state.playback = Buffer.concat([state.playback, buffer]);
        if (state.playback.length < state.expected)
          return line(`VOICE_PLAY_ACK received=${state.playback.length} total=${state.expected}`);
        line(`VOICE_PLAY_ACK received=${state.playback.length} total=${state.expected}`);
        line(`VOICE_PLAY_QUEUED bytes=${state.playback.length} sample_rate=24000`);
        setTimeout(() => line('VOICE_PLAYBACK_END'), 5);
        state.expected = 0;
        return;
      }
      const text = buffer.toString('latin1');
      if (text === 'i')
        return line('INFO protocol=13 firmware=0123456789abcdef character=copilot speaker=1 microphone=1');
      if (text === 'o') return line('ORIENTATION_SETTINGS offset_tenths=0');
      if (text === 'v') {
        const header = `VOICE_PCM id=7 bytes=${capture.length} sample_rate=16000 channels=1 format=s16le\n`;
        emit(Buffer.from(header.slice(0, 19)));
        emit(Buffer.concat([
          Buffer.from(header.slice(19)),
          capture.subarray(0, 3),
        ]));
        emit(Buffer.concat([
          capture.subarray(3),
          Buffer.from(`\nVOICE_PCM_END id=${options.trailerId ?? 7}\n`),
        ]));
        return;
      }
      const playback = /^~24000:(\d+)\n$/.exec(text);
      if (playback) {
        state.expected = Number(playback[1]);
        state.playback = Buffer.alloc(0);
        return line(`VOICE_PLAY_READY bytes=${state.expected} sample_rate=24000 chunk=4096`);
      }
      if (text === 'x') return line('VOICE_CANCELLED');
    };
    return binding;
  };
  return {
    state,
    capture,
    ready(): void {
      lineOnBinding(binding, `VOICE_CAPTURE id=7 bytes=${capture.length} sample_rate=16000 channels=1 format=s16le`);
    },
  };
}

function lineOnBinding(binding: MockPortBinding, line: string): void {
  setImmediate(() => binding.isOpen && binding.emitData(`${line}\n`));
}

async function until(ready: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > end) throw new Error('Timed out waiting for the test condition.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('after a character upload, the transport reports the new character before the device answers again', async () => {
  fakeDevice({silentAfterRestart: true});
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.connected);
    assert.equal(usb.character, 'copilot');
    assert.equal(await usb.installCharacter(Buffer.alloc(8)), 'bunny');
    assert.equal(usb.character, 'bunny');
  } finally {
    await usb.stop();
  }
});

test('a USB port that stops answering is closed after three timeouts in a row', async () => {
  fakeDevice({silentAfterRestart: true});
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.connected);
    await usb.installCharacter(Buffer.alloc(8));
    usb.setState('working');
    usb.setState('idle');
    assert.equal(usb.connected, true);
    usb.setState('working');
    await until(() => !usb.connected);
  } finally {
    await usb.stop();
  }
});

test('a device that restarts normally keeps its USB link', async () => {
  fakeDevice({silentAfterRestart: false});
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.connected);
    await usb.installCharacter(Buffer.alloc(8));
    for (const state of ['working', 'idle', 'working', 'idle'] as const) usb.setState(state);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(usb.connected, true);
    assert.equal(usb.character, 'bunny');
  } finally {
    await usb.stop();
  }
});

test('an open USB port does not count as connected until the device answers', async () => {
  fakeDevice({silentAfterRestart: false, silent: true});
  let changes = 0;
  const usb = new UsbTransport(() => { changes++; }, undefined, {serial: SerialPortMock, requestTimeoutMs: 100});
  try {
    usb.start();
    const end = Date.now() + 400;
    while (Date.now() < end) {
      assert.equal(usb.connected, false);
      assert.equal(usb.character, null);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    // Only the unanswered-port notice changes; a silent port never reports a connect or disconnect.
    assert.ok(changes <= 1);
  } finally {
    await usb.stop();
  }
});

test('a request to a device that stops reading fails at its timeout and does not crash the service', {timeout: 10_000}, async () => {
  fakeDevice({silentAfterRestart: true, stuckDrain: true});
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 50});
  try {
    usb.start();
    await until(() => usb.connected);
    await usb.installCharacter(Buffer.alloc(8));
    for (const state of ['working', 'idle', 'working'] as const) usb.setState(state);
    await until(() => !usb.connected);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', record);
    await usb.stop();
  }
});

test('USB voice capture preserves arbitrary PCM bytes across fragmented serial data', async () => {
  const device = fakeVoiceDevice();
  let ready = 0;
  const usb = new UsbTransport(undefined, undefined, {
    serial: SerialPortMock,
    requestTimeoutMs: 100,
    voiceCaptureReady: () => { ready++; },
  });
  try {
    usb.start();
    await until(() => usb.connected);
    assert.deepEqual(usb.capabilities, {speaker: true, microphone: true});
    device.ready();
    await until(() => ready === 1);
    const capture = await usb.captureVoice();
    assert.equal(capture.sampleRate, 16000);
    assert.deepEqual(capture.pcm, device.capture);
  } finally {
    await usb.stop();
  }
});

test('USB voice capture rejects a mismatched binary trailer', async () => {
  fakeVoiceDevice({trailerId: 9});
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 100});
  try {
    usb.start();
    await until(() => usb.connected);
    await assert.rejects(usb.captureVoice(), /invalid voice capture trailer/);
  } finally {
    await usb.stop();
  }
});

test('USB voice playback applies chunk backpressure and waits for playback completion', async () => {
  const device = fakeVoiceDevice();
  const usb = new UsbTransport(undefined, undefined, {serial: SerialPortMock, requestTimeoutMs: 100});
  const pcm = Buffer.alloc(9000);
  pcm[20] = 0x0a;
  pcm[4097] = 0xff;
  try {
    usb.start();
    await until(() => usb.connected);
    await usb.playVoice(pcm);
    assert.deepEqual(device.state.playback, pcm);
  } finally {
    await usb.stop();
  }
});
