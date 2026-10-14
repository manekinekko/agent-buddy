import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {
  LocalVoiceService,
  VoiceBusyError,
  VoiceCancelledError,
  captureSampleRate,
  copilotArguments,
  defaultVoiceConfig,
  ffmpegArguments,
  mergeVoiceConfig,
  pcm16MonoWav,
  playbackSampleRate,
  runVoiceProcess,
  sayArguments,
  validateVoiceConfigUpdate,
  whisperArguments,
  type VoiceProcessRunner,
} from '../src/local-voice-service.js';
import type {VoiceDependencies, VoiceDependencyStatus} from '../src/protocol.js';
import {defaultWhisperModelPath, voiceConfigPath, voiceDirectory} from '../src/paths.js';

function testDirectory(name: string): string {
  return join(process.cwd(), '.test-output', `local-voice-${name}-${randomUUID()}`);
}

async function withDirectory(name: string, run: (directory: string) => Promise<void>): Promise<void> {
  const directory = testDirectory(name);
  await mkdir(directory, {recursive: true});
  try {
    await run(directory);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

function dependency(available: boolean, path: string | null, message = 'status'): VoiceDependencyStatus {
  return {available, path, message, guidance: available ? 'ready' : 'install it'};
}

function dependencies(available: boolean): VoiceDependencies {
  return {
    whisper: dependency(available, available ? '/tools/whisper-cli' : null, 'Whisper.cpp is missing.'),
    model: dependency(available, available ? '/models/ggml-base.bin' : null, 'The model is missing.'),
    say: dependency(available, available ? '/usr/bin/say' : null, 'say is missing.'),
    ffmpeg: dependency(available, available ? '/tools/ffmpeg' : null, 'ffmpeg is missing.'),
    copilot: dependency(available, available ? '/tools/copilot' : null, 'Copilot CLI is missing.'),
  };
}

test('voice paths honor app-data overrides and keep the default model under the voice directory', () => {
  const previousConfig = process.env.AGENT_COMPANION_VOICE_CONFIG;
  const previousDirectory = process.env.AGENT_COMPANION_VOICE_DIRECTORY;
  process.env.AGENT_COMPANION_VOICE_CONFIG = join('custom', 'voice.json');
  process.env.AGENT_COMPANION_VOICE_DIRECTORY = join('custom', 'voice');
  try {
    assert.equal(voiceConfigPath(), join('custom', 'voice.json'));
    assert.equal(voiceDirectory(), join('custom', 'voice'));
    assert.equal(defaultWhisperModelPath(), join('custom', 'voice', 'models', 'ggml-base.bin'));
  } finally {
    if (previousConfig === undefined) delete process.env.AGENT_COMPANION_VOICE_CONFIG;
    else process.env.AGENT_COMPANION_VOICE_CONFIG = previousConfig;
    if (previousDirectory === undefined) delete process.env.AGENT_COMPANION_VOICE_DIRECTORY;
    else process.env.AGENT_COMPANION_VOICE_DIRECTORY = previousDirectory;
  }
});

test('voice configuration defaults, validation and process arguments are explicit', () => {
  const config = defaultVoiceConfig('/app/voice/models/ggml-base.bin');
  assert.equal(config.enabled, true);
  assert.equal(config.allowAllTools, true);
  assert.equal(config.whisperExecutable, '');
  assert.equal(config.ttsVoice, '');
  assert.match(config.sessionId, /^[0-9a-f-]{36}$/);

  const updated = mergeVoiceConfig(config, {
    enabled: false,
    whisperExecutable: '/opt/homebrew/bin/whisper-cli',
    whisperModelPath: '/models/ggml-small.bin',
    ttsVoice: 'Alex',
    ttsRate: 210,
    maxRecordingSeconds: 12,
    allowAllTools: false,
  });
  assert.deepEqual(updated, {
    ...config,
    enabled: false,
    whisperExecutable: '/opt/homebrew/bin/whisper-cli',
    whisperModelPath: '/models/ggml-small.bin',
    ttsVoice: 'Alex',
    ttsRate: 210,
    maxRecordingSeconds: 12,
    allowAllTools: false,
  });
  assert.throws(() => validateVoiceConfigUpdate({ttsRate: 451}), /80 to 450/);
  assert.throws(() => validateVoiceConfigUpdate({maxRecordingSeconds: 0}), /1 to 15/);
  assert.throws(() => validateVoiceConfigUpdate({whisperModelPath: 'relative.bin'}), /absolute/);
  assert.throws(() => validateVoiceConfigUpdate({sessionId: randomUUID()}), /Unknown voice setting/);
  assert.throws(() => validateVoiceConfigUpdate({}), /No voice settings/);

  assert.deepEqual(whisperArguments(config, '/work/input.wav', '/work/transcript'), [
    '-m', '/app/voice/models/ggml-base.bin',
    '-f', '/work/input.wav',
    '-otxt', '-of', '/work/transcript', '-nt', '-np',
  ]);
  assert.deepEqual(copilotArguments('What changed?', config, '/repo'), [
    '-p', 'What changed?',
    '--silent',
    '--allow-all-tools',
    '--session-id', config.sessionId,
    '-C', '/repo',
  ]);
  assert.deepEqual(sayArguments(config, '/work/speech.txt', '/work/speech.aiff'), [
    '-r', '190', '-o', '/work/speech.aiff', '-f', '/work/speech.txt',
  ]);
  assert.deepEqual(ffmpegArguments('/work/speech.aiff', '/work/speech.pcm'), [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', '/work/speech.aiff',
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', '/work/speech.pcm',
  ]);

  const wav = pcm16MonoWav(Buffer.from([1, 0, 2, 0]));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), captureSampleRate);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
});

test('voice service reports actionable dependency failures before starting a process', async () => {
  await withDirectory('missing', async directory => {
    let processes = 0;
    const service = await LocalVoiceService.create({
      configPath: join(directory, 'voice.json'),
      voiceDirectory: join(directory, 'voice'),
      workingDirectory: directory,
      playPcm: async () => {},
      detectDependencies: async () => dependencies(false),
      runProcess: async () => {
        processes += 1;
        return {stdout: '', stderr: ''};
      },
    });
    const status = await service.getStatus();
    assert.equal(status.ready, false);
    assert.equal(status.sttReady, false);
    await assert.rejects(
      service.processCapture(Buffer.alloc(captureSampleRate * 2), captureSampleRate),
      /Local voice dependencies are missing: Whisper\.cpp is missing.*model is missing.*Copilot CLI is missing.*say is missing.*ffmpeg is missing/s);
    assert.equal(processes, 0);
  });
});

test('voice service runs STT, one persisted Copilot session, TTS conversion and PCM playback', async () => {
  await withDirectory('pipeline', async directory => {
    const calls: Array<{command: string; args: readonly string[]}> = [];
    const played: Buffer[] = [];
    const runner: VoiceProcessRunner = async (command, args) => {
      calls.push({command, args});
      if (command.endsWith('whisper-cli')) {
        const output = args[args.indexOf('-of') + 1]!;
        await writeFile(`${output}.txt`, 'show the current status\n');
      } else if (command.endsWith('/say')) {
        const output = args[args.indexOf('-o') + 1]!;
        await writeFile(output, 'aiff');
      } else if (command.endsWith('ffmpeg')) {
        await writeFile(args.at(-1)!, Buffer.from([1, 0, 2, 0, 3, 0]));
      } else if (command.endsWith('copilot')) {
        return {stdout: 'The current status is ready.\n', stderr: ''};
      }
      return {stdout: '', stderr: ''};
    };
    const service = await LocalVoiceService.create({
      configPath: join(directory, 'voice.json'),
      voiceDirectory: join(directory, 'voice'),
      workingDirectory: directory,
      playPcm: async (pcm, sampleRate) => {
        assert.equal(sampleRate, playbackSampleRate);
        played.push(Buffer.from(pcm));
      },
      detectDependencies: async () => dependencies(true),
      runProcess: runner,
    });

    const first = await service.processCapture(Buffer.alloc(captureSampleRate), captureSampleRate);
    const second = await service.processCapture(Buffer.alloc(captureSampleRate), captureSampleRate);
    assert.equal(first.transcript, 'show the current status');
    assert.equal(first.response, 'The current status is ready.');
    assert.equal(first.playbackBytes, 6);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(played.length, 4);
    assert.deepEqual(calls.map(call => call.command), [
      '/usr/bin/say', '/tools/ffmpeg',
      '/tools/whisper-cli', '/tools/copilot', '/usr/bin/say', '/tools/ffmpeg',
      '/tools/whisper-cli', '/tools/copilot', '/usr/bin/say', '/tools/ffmpeg',
    ]);
    const copilot = calls.find(call => call.command.endsWith('copilot'))!;
    assert.deepEqual(copilot.args.slice(0, 4), ['-p', 'show the current status', '--silent', '--allow-all-tools']);
    assert.equal(copilot.args[copilot.args.indexOf('--session-id') + 1], first.sessionId);
    assert.equal(copilot.args[copilot.args.indexOf('-C') + 1], directory);
    assert.deepEqual(await readdir(join(directory, 'voice', 'runtime')), []);

    const reset = await service.resetSession();
    assert.notEqual(reset.config.sessionId, first.sessionId);
    const saved = JSON.parse(await readFile(join(directory, 'voice.json'), 'utf8')) as {sessionId: string};
    assert.equal(saved.sessionId, reset.config.sessionId);
    await service.updateConfig({allowAllTools: false});
    await assert.rejects(
      service.processCapture(Buffer.alloc(captureSampleRate), captureSampleRate),
      /Allow all tools is off/);
  });
});

test('voice service plays its cached acknowledgment while transcription is still running', async () => {
  await withDirectory('acknowledgment', async directory => {
    let finishWhisper: (() => void) | undefined;
    const whisperBlocked = new Promise<void>(resolve => {
      finishWhisper = resolve;
    });
    let acknowledgmentStarted: (() => void) | undefined;
    const acknowledgment = new Promise<void>(resolve => {
      acknowledgmentStarted = resolve;
    });
    let playbackCount = 0;
    const runner: VoiceProcessRunner = async (command, args) => {
      if (command.endsWith('/say')) {
        await writeFile(args[args.indexOf('-o') + 1]!, 'aiff');
      } else if (command.endsWith('ffmpeg')) {
        await writeFile(args.at(-1)!, Buffer.from([1, 0, 2, 0]));
      } else if (command.endsWith('whisper-cli')) {
        await whisperBlocked;
        await writeFile(`${args[args.indexOf('-of') + 1]!}.txt`, 'what time is it');
      } else if (command.endsWith('copilot')) {
        return {stdout: 'It is test time.', stderr: ''};
      }
      return {stdout: '', stderr: ''};
    };
    const service = await LocalVoiceService.create({
      configPath: join(directory, 'voice.json'),
      voiceDirectory: join(directory, 'voice'),
      workingDirectory: directory,
      playPcm: async () => {
        playbackCount += 1;
        if (playbackCount === 1) acknowledgmentStarted!();
      },
      detectDependencies: async () => dependencies(true),
      runProcess: runner,
    });

    const turn = service.processCapture(Buffer.alloc(captureSampleRate), captureSampleRate);
    await Promise.race([
      acknowledgment,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('Acknowledgment did not start during transcription.')), 1000)),
    ]);
    finishWhisper!();
    await turn;
    assert.equal(playbackCount, 2);
  });
});

test('voice service synthesizes and plays harness input prompts', async () => {
  await withDirectory('input-prompt', async directory => {
    const calls: Array<{command: string; args: readonly string[]}> = [];
    const played: Buffer[] = [];
    const spokenTexts: string[] = [];
    const runner: VoiceProcessRunner = async (command, args) => {
      calls.push({command, args});
      if (command.endsWith('/say')) {
        spokenTexts.push(await readFile(args[args.indexOf('-f') + 1]!, 'utf8'));
        await writeFile(args[args.indexOf('-o') + 1]!, 'aiff');
      } else if (command.endsWith('ffmpeg')) {
        await writeFile(args.at(-1)!, Buffer.from([1, 0, 2, 0]));
      }
      return {stdout: '', stderr: ''};
    };
    const service = await LocalVoiceService.create({
      configPath: join(directory, 'voice.json'),
      voiceDirectory: join(directory, 'voice'),
      workingDirectory: directory,
      playPcm: async pcm => { played.push(Buffer.from(pcm)); },
      detectDependencies: async () => dependencies(true),
      runProcess: runner,
    });

    assert.equal(await service.speakInputPrompt('Would you like to continue?'), true);
    assert.equal(played.length, 1);
    assert.deepEqual(spokenTexts, ['I am on it.', 'Would you like to continue?']);
    assert.deepEqual(calls.map(call => call.command), [
      '/usr/bin/say', '/tools/ffmpeg', '/usr/bin/say', '/tools/ffmpeg',
    ]);

    await service.updateConfig({enabled: false});
    assert.equal(await service.speakInputPrompt('This should stay silent.'), false);
    assert.equal(played.length, 1);
  });
});

test('voice service enforces one active turn and cancellation', async () => {
  await withDirectory('cancel', async directory => {
    let copilotStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      copilotStarted = resolve;
    });
    const runner: VoiceProcessRunner = async (command, args, options) => {
      if (command.endsWith('whisper-cli')) {
        await writeFile(`${args[args.indexOf('-of') + 1]!}.txt`, 'wait for me');
        return {stdout: '', stderr: ''};
      }
      if (command.endsWith('copilot')) {
        copilotStarted!();
        return new Promise((resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new VoiceCancelledError()), {once: true});
        });
      }
      return {stdout: '', stderr: ''};
    };
    const service = await LocalVoiceService.create({
      configPath: join(directory, 'voice.json'),
      voiceDirectory: join(directory, 'voice'),
      workingDirectory: directory,
      playPcm: async () => {},
      detectDependencies: async () => dependencies(true),
      runProcess: runner,
    });
    const turn = service.processCapture(Buffer.alloc(captureSampleRate), captureSampleRate);
    await started;
    await assert.rejects(
      service.processCapture(Buffer.alloc(captureSampleRate), captureSampleRate),
      VoiceBusyError);
    assert.equal(service.cancel(), true);
    await assert.rejects(turn, VoiceCancelledError);
    assert.equal(service.snapshot().active, false);
    assert.equal(service.cancel(), false);
  });
});

test('voice process runner bounds output and enforces timeouts', async () => {
  await assert.rejects(
    runVoiceProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], {
      timeoutMs: 5000,
      maxOutputBytes: 128,
      label: 'test output',
    }),
    /more than 128 bytes on stdout/);
  await assert.rejects(
    runVoiceProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 50,
      maxOutputBytes: 128,
      label: 'test timeout',
    }),
    /timed out/);
});
