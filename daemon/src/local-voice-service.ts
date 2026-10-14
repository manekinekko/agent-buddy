import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {constants} from 'node:fs';
import {access, chmod, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {delimiter, dirname, isAbsolute, join} from 'node:path';
import {
  defaultWhisperModelPath,
  serviceInfo,
  voiceConfigPath as defaultVoiceConfigPath,
  voiceDirectory as defaultVoiceDirectory,
} from './paths.js';
import type {
  LocalVoiceConfig,
  LocalVoiceState,
  LocalVoiceStatus,
  VoiceDependencies,
  VoiceDependencyStatus,
} from './protocol.js';

export const minVoiceRecordingSeconds = 1;
export const maxVoiceRecordingSeconds = 15;
export const minTtsRate = 80;
export const maxTtsRate = 450;
export const captureSampleRate = 16_000;
export const playbackSampleRate = 24_000;

const defaultTtsRate = 190;
const defaultRecordingSeconds = 15;
const maxPathLength = 2048;
const maxVoiceNameLength = 128;
const maxTranscriptCharacters = 32_000;
const maxSpokenCharacters = 20_000;
const maxTtsTestCharacters = 500;
const maxInputPromptCharacters = 600;
const maxPcmPlaybackBytes = playbackSampleRate * 45 * 2;
const defaultProcessOutputBytes = 1024 * 1024;
const processKillGraceMs = 2000;
const acknowledgmentText = 'I am on it.';
const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface VoiceConfigUpdate {
  enabled?: boolean;
  whisperExecutable?: string;
  whisperModelPath?: string;
  ttsVoice?: string;
  ttsRate?: number;
  maxRecordingSeconds?: number;
  allowAllTools?: boolean;
}

export interface VoiceTurnResult {
  transcript: string;
  response: string;
  sessionId: string;
  playbackBytes: number;
}

export interface VoiceTurnOptions {
  acknowledgmentPlayed?: boolean;
}

export interface VoiceProcessResult {
  stdout: string;
  stderr: string;
}

export interface VoiceProcessOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  label: string;
}

export type VoiceProcessRunner =
  (command: string, args: readonly string[], options: VoiceProcessOptions) => Promise<VoiceProcessResult>;

export type VoiceDependencyDetector = (config: LocalVoiceConfig) => Promise<VoiceDependencies>;

export type PcmPlaybackCallback =
  (pcm: Buffer, sampleRate: number, signal: AbortSignal) => Promise<void>;

export interface LocalVoiceTimeouts {
  whisperMs: number;
  copilotMs: number;
  sayMs: number;
  ffmpegMs: number;
}

export interface LocalVoiceServiceOptions {
  playPcm: PcmPlaybackCallback;
  log?: (message: string) => void;
  configPath?: string;
  voiceDirectory?: string;
  workingDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runProcess?: VoiceProcessRunner;
  detectDependencies?: VoiceDependencyDetector;
  timeouts?: Partial<LocalVoiceTimeouts>;
}

export interface LocalVoiceController {
  snapshot(): LocalVoiceStatus;
  getStatus(): Promise<LocalVoiceStatus>;
  updateConfig(value: unknown): Promise<LocalVoiceStatus>;
  resetSession(): Promise<LocalVoiceStatus>;
  cancel(): boolean;
  testTts(text?: string): Promise<{playbackBytes: number; status: LocalVoiceStatus}>;
}

export class LocalVoiceError extends Error {
  constructor(message: string, readonly status = 409, readonly code = 'voice_error') {
    super(message);
    this.name = 'LocalVoiceError';
  }
}

export class VoiceConfigurationError extends LocalVoiceError {
  constructor(message: string) {
    super(message, 400, 'invalid_voice_configuration');
    this.name = 'VoiceConfigurationError';
  }
}

export class VoiceBusyError extends LocalVoiceError {
  constructor() {
    super('Another local voice operation is already active. Cancel it or wait for it to finish.', 409, 'voice_busy');
    this.name = 'VoiceBusyError';
  }
}

export class VoiceCancelledError extends LocalVoiceError {
  constructor() {
    super('The local voice operation was canceled.', 409, 'voice_canceled');
    this.name = 'VoiceCancelledError';
  }
}

export class VoiceDependencyError extends LocalVoiceError {
  constructor(message: string) {
    super(message, 409, 'voice_dependency_missing');
    this.name = 'VoiceDependencyError';
  }
}

export function defaultVoiceConfig(modelPath = defaultWhisperModelPath()): LocalVoiceConfig {
  return {
    enabled: true,
    whisperExecutable: '',
    whisperModelPath: modelPath,
    ttsVoice: '',
    ttsRate: defaultTtsRate,
    maxRecordingSeconds: defaultRecordingSeconds,
    allowAllTools: true,
    sessionId: randomUUID(),
  };
}

function isSafeString(value: unknown, maxLength: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\0')
    && !value.includes('\r') && !value.includes('\n') && (allowEmpty || value.trim().length > 0);
}

function isTtsRate(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= minTtsRate && Number(value) <= maxTtsRate;
}

function isRecordingSeconds(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= minVoiceRecordingSeconds
    && Number(value) <= maxVoiceRecordingSeconds;
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && sessionIdPattern.test(value);
}

export function validateVoiceConfigUpdate(value: unknown): VoiceConfigUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new VoiceConfigurationError('Voice settings must be a JSON object.');
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    'enabled', 'whisperExecutable', 'whisperModelPath', 'ttsVoice', 'ttsRate',
    'maxRecordingSeconds', 'allowAllTools',
  ]);
  const unknown = Object.keys(input).find(key => !allowed.has(key));
  if (unknown) throw new VoiceConfigurationError(`Unknown voice setting: ${unknown}.`);
  const result: VoiceConfigUpdate = {};
  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean')
      throw new VoiceConfigurationError('Voice enabled must be true or false.');
    result.enabled = input.enabled;
  }
  if ('whisperExecutable' in input) {
    if (!isSafeString(input.whisperExecutable, maxPathLength, true))
      throw new VoiceConfigurationError('Whisper executable must be a command name or path without line breaks.');
    result.whisperExecutable = input.whisperExecutable.trim();
  }
  if ('whisperModelPath' in input) {
    if (!isSafeString(input.whisperModelPath, maxPathLength, false) || !isAbsolute(input.whisperModelPath.trim()))
      throw new VoiceConfigurationError('Whisper model path must be an absolute file path.');
    result.whisperModelPath = input.whisperModelPath.trim();
  }
  if ('ttsVoice' in input) {
    if (!isSafeString(input.ttsVoice, maxVoiceNameLength, true))
      throw new VoiceConfigurationError('TTS voice must not contain line breaks.');
    result.ttsVoice = input.ttsVoice.trim();
  }
  if ('ttsRate' in input) {
    if (!isTtsRate(input.ttsRate))
      throw new VoiceConfigurationError(`TTS rate must be a whole number from ${minTtsRate} to ${maxTtsRate}.`);
    result.ttsRate = input.ttsRate;
  }
  if ('maxRecordingSeconds' in input) {
    if (!isRecordingSeconds(input.maxRecordingSeconds))
      throw new VoiceConfigurationError(
        `Maximum recording time must be a whole number from ${minVoiceRecordingSeconds} to ${maxVoiceRecordingSeconds} seconds.`);
    result.maxRecordingSeconds = input.maxRecordingSeconds;
  }
  if ('allowAllTools' in input) {
    if (typeof input.allowAllTools !== 'boolean')
      throw new VoiceConfigurationError('Allow all tools must be true or false.');
    result.allowAllTools = input.allowAllTools;
  }
  if (!Object.keys(result).length) throw new VoiceConfigurationError('No voice settings were provided.');
  return result;
}

export function mergeVoiceConfig(config: LocalVoiceConfig, value: unknown): LocalVoiceConfig {
  return {...config, ...validateVoiceConfigUpdate(value)};
}

export function whisperArguments(
    config: LocalVoiceConfig, inputWav: string, outputBase: string): string[] {
  return ['-m', config.whisperModelPath, '-f', inputWav, '-otxt', '-of', outputBase, '-nt', '-np'];
}

export function copilotArguments(
    prompt: string, config: LocalVoiceConfig, workingDirectory?: string): string[] {
  return [
    '-p', prompt,
    '--silent',
    ...(config.allowAllTools ? ['--allow-all-tools'] : []),
    '--session-id', config.sessionId,
    ...(workingDirectory ? ['-C', workingDirectory] : []),
  ];
}

export function sayArguments(
    config: LocalVoiceConfig, textFile: string, outputAiff: string): string[] {
  return [
    ...(config.ttsVoice ? ['-v', config.ttsVoice] : []),
    '-r', String(config.ttsRate),
    '-o', outputAiff,
    '-f', textFile,
  ];
}

export function ffmpegArguments(inputAiff: string, outputPcm: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', inputAiff,
    '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(playbackSampleRate), '-ac', '1', outputPcm,
  ];
}

export function pcm16MonoWav(pcm: Buffer, sampleRate = captureSampleRate): Buffer {
  if (!pcm.length || pcm.length % 2 !== 0)
    throw new VoiceConfigurationError('Captured audio must contain complete signed 16-bit PCM samples.');
  if (!Number.isInteger(sampleRate) || sampleRate <= 0)
    throw new VoiceConfigurationError('Captured audio sample rate must be a positive whole number.');
  if (pcm.length > 0xffffffff - 44)
    throw new VoiceConfigurationError('Captured audio is too large for a WAV file.');
  const wav = Buffer.allocUnsafe(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

function trimProcessDetail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 2000 ? trimmed.slice(-2000) : trimmed;
}

export function runVoiceProcess(
    command: string, args: readonly string[], options: VoiceProcessOptions): Promise<VoiceProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new VoiceCancelledError());
  const maxOutputBytes = options.maxOutputBytes ?? defaultProcessOutputBytes;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | null = null;
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;

    const kill = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The process already exited.
        }
      }
    };
    const terminate = () => {
      kill('SIGTERM');
      forceTimer ??= setTimeout(() => kill('SIGKILL'), processKillGraceMs);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error: Error | null, result?: VoiceProcessResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result!);
    };
    const onAbort = () => {
      failure ??= new VoiceCancelledError();
      terminate();
    };
    const append = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (failure) return;
      if (stream === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if ((stream === 'stdout' ? stdoutBytes : stderrBytes) > maxOutputBytes) {
        failure = new LocalVoiceError(
          `${options.label} produced more than ${maxOutputBytes} bytes on ${stream}.`, 409, 'voice_output_limit');
        terminate();
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk, 'stderr'));
    child.once('error', error => {
      const stopped = failure ?? new LocalVoiceError(
        `Could not start ${options.label}: ${error.message}`, 409, 'voice_process_start');
      finish(stopped);
    });
    child.once('close', code => {
      const output = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (failure) return finish(failure);
      if (code !== 0) {
        const detail = trimProcessDetail(output.stderr) || trimProcessDetail(output.stdout);
        return finish(new LocalVoiceError(
          `${options.label} stopped with exit code ${code ?? 'unknown'}${detail ? `: ${detail}` : '.'}`,
          409, 'voice_process_failed'));
      }
      finish(null, output);
    });
    options.signal?.addEventListener('abort', onAbort, {once: true});
    const timeout = setTimeout(() => {
      failure ??= new LocalVoiceError(
        `${options.label} timed out after ${Math.ceil(options.timeoutMs / 1000)} seconds.`,
        409, 'voice_process_timeout');
      terminate();
    }, options.timeoutMs);
  });
}

type AccessFunction = (path: string, mode?: number) => Promise<void>;

export async function findExecutable(
    candidates: readonly string[], environment: NodeJS.ProcessEnv = process.env,
    canAccess: AccessFunction = access): Promise<string | null> {
  const paths = (environment.PATH ?? '').split(delimiter).filter(Boolean);
  const checked = new Set<string>();
  for (const candidate of candidates) {
    const direct = isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\');
    const options = direct ? [candidate] : paths.map(path => join(path, candidate));
    for (const option of options) {
      if (checked.has(option)) continue;
      checked.add(option);
      try {
        await canAccess(option, constants.X_OK);
        return option;
      } catch {
        // Keep looking through the configured candidates and PATH.
      }
    }
  }
  return null;
}

function dependency(
    available: boolean, path: string | null, message: string, guidance: string): VoiceDependencyStatus {
  return {available, path, message, guidance};
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const file = await stat(path);
    if (!file.isFile()) return false;
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function detectVoiceDependencies(
    config: LocalVoiceConfig, options: {
      environment?: NodeJS.ProcessEnv;
      platform?: NodeJS.Platform;
      processExecutable?: string;
    } = {}): Promise<VoiceDependencies> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const whisperCandidates = config.whisperExecutable
    ? [config.whisperExecutable] : ['whisper-cli', 'whisper-cpp', 'main'];
  const whisper = await findExecutable(whisperCandidates, environment);
  const modelAvailable = await regularFile(config.whisperModelPath);
  const say = platform === 'darwin'
    ? await findExecutable(['/usr/bin/say', 'say'], environment) : null;
  const ffmpeg = await findExecutable(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'], environment);
  const executableDirectory = dirname(options.processExecutable ?? process.execPath);
  const copilot = await findExecutable([join(executableDirectory, 'copilot'), 'copilot'], environment);
  return {
    whisper: whisper
      ? dependency(true, whisper, `Using ${whisper}.`, 'Whisper.cpp is ready.')
      : dependency(false, null, 'Whisper.cpp executable was not found.',
        config.whisperExecutable
          ? `Check the configured executable: ${config.whisperExecutable}.`
          : 'Install it with brew install whisper-cpp, or enter the full path to whisper-cli, whisper-cpp, or main.'),
    model: modelAvailable
      ? dependency(true, config.whisperModelPath, `Using ${config.whisperModelPath}.`, 'The Whisper model is ready.')
      : dependency(false, config.whisperModelPath, 'The Whisper model file was not found.',
        `Download ggml-base.bin and place it at ${config.whisperModelPath}, or choose another model file.`),
    say: say
      ? dependency(true, say, `Using ${say}.`, 'macOS speech synthesis is ready.')
      : dependency(false, null, 'The macOS say command was not found.',
        platform === 'darwin'
          ? 'Restore /usr/bin/say from macOS before using local TTS.'
          : 'Local Agent Buddy TTS requires macOS and its built-in say command.'),
    ffmpeg: ffmpeg
      ? dependency(true, ffmpeg, `Using ${ffmpeg}.`, '24 kHz PCM conversion is ready.')
      : dependency(false, null, 'ffmpeg was not found.',
        'Install it with brew install ffmpeg, then restart the companion service.'),
    copilot: copilot
      ? dependency(true, copilot, `Using ${copilot}.`, 'GitHub Copilot CLI is ready.')
      : dependency(false, null, 'GitHub Copilot CLI was not found.',
        'Install or update GitHub Copilot CLI and make sure copilot is on the companion service PATH.'),
  };
}

interface LoadedVoiceConfig {
  config: LocalVoiceConfig;
  warning: string | null;
  save: boolean;
}

function normalizeSavedVoiceConfig(value: unknown, fallback: LocalVoiceConfig): LoadedVoiceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {config: fallback, warning: 'Stored voice settings were invalid and were reset to defaults.', save: true};
  const input = value as Record<string, unknown>;
  const issues: string[] = [];
  const pick = <T>(name: string, valid: (candidate: unknown) => candidate is T, defaultValue: T): T => {
    const candidate = input[name];
    if (valid(candidate)) return candidate;
    issues.push(name);
    return defaultValue;
  };
  const config: LocalVoiceConfig = {
    enabled: pick('enabled', (candidate): candidate is boolean => typeof candidate === 'boolean', fallback.enabled),
    whisperExecutable: pick(
      'whisperExecutable',
      (candidate): candidate is string => isSafeString(candidate, maxPathLength, true),
      fallback.whisperExecutable).trim(),
    whisperModelPath: pick(
      'whisperModelPath',
      (candidate): candidate is string => isSafeString(candidate, maxPathLength, false) && isAbsolute(candidate.trim()),
      fallback.whisperModelPath).trim(),
    ttsVoice: pick(
      'ttsVoice', (candidate): candidate is string => isSafeString(candidate, maxVoiceNameLength, true),
      fallback.ttsVoice).trim(),
    ttsRate: pick('ttsRate', isTtsRate, fallback.ttsRate),
    maxRecordingSeconds: pick('maxRecordingSeconds', isRecordingSeconds, fallback.maxRecordingSeconds),
    allowAllTools: pick(
      'allowAllTools', (candidate): candidate is boolean => typeof candidate === 'boolean', fallback.allowAllTools),
    sessionId: pick('sessionId', isSessionId, fallback.sessionId),
  };
  return {
    config,
    warning: issues.length
      ? `Stored voice settings had invalid fields and used defaults for: ${issues.join(', ')}.` : null,
    save: issues.length > 0,
  };
}

async function loadVoiceConfig(path: string, fallback: LocalVoiceConfig): Promise<LoadedVoiceConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return {config: fallback, warning: null, save: true};
    throw error;
  }
  try {
    return normalizeSavedVoiceConfig(JSON.parse(text) as unknown, fallback);
  } catch {
    return {config: fallback, warning: 'Stored voice settings were not valid JSON and were reset to defaults.', save: true};
  }
}

async function saveVoiceConfig(path: string, config: LocalVoiceConfig): Promise<void> {
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {mode: 0o600});
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function uncheckedDependencies(): VoiceDependencies {
  const status = dependency(false, null, 'Dependency status has not been checked.', 'Refresh voice status.');
  return {
    whisper: {...status},
    model: {...status},
    say: {...status},
    ffmpeg: {...status},
    copilot: {...status},
  };
}

function asLocalVoiceError(error: unknown): LocalVoiceError {
  if (error instanceof LocalVoiceError) return error;
  return new LocalVoiceError(error instanceof Error ? error.message : String(error));
}

const defaultTimeouts: LocalVoiceTimeouts = {
  whisperMs: 120_000,
  copilotMs: 5 * 60_000,
  sayMs: 30_000,
  ffmpegMs: 30_000,
};

export class LocalVoiceService extends EventEmitter implements LocalVoiceController {
  readonly #playPcm: PcmPlaybackCallback;
  readonly #configPath: string;
  readonly #directory: string;
  readonly #workingDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #runProcess: VoiceProcessRunner;
  readonly #detectDependencies: VoiceDependencyDetector;
  readonly #timeouts: LocalVoiceTimeouts;
  readonly #log: (message: string) => void;
  #config: LocalVoiceConfig;
  #dependencies = uncheckedDependencies();
  #configurationWarning: string | null;
  #state: LocalVoiceState = 'idle';
  #lastError: string | null = null;
  #active: {controller: AbortController} | null = null;
  #acknowledgmentPcm: Buffer | null = null;
  #inputPromptQueue: Promise<void> = Promise.resolve();

  private constructor(options: {
    playPcm: PcmPlaybackCallback;
    configPath: string;
    directory: string;
    workingDirectory: string;
    environment: NodeJS.ProcessEnv;
    runProcess: VoiceProcessRunner;
    detectDependencies: VoiceDependencyDetector;
    timeouts: LocalVoiceTimeouts;
    log: (message: string) => void;
    config: LocalVoiceConfig;
    configurationWarning: string | null;
  }) {
    super();
    this.#playPcm = options.playPcm;
    this.#configPath = options.configPath;
    this.#directory = options.directory;
    this.#workingDirectory = options.workingDirectory;
    this.#environment = options.environment;
    this.#runProcess = options.runProcess;
    this.#detectDependencies = options.detectDependencies;
    this.#timeouts = options.timeouts;
    this.#log = options.log;
    this.#config = options.config;
    this.#configurationWarning = options.configurationWarning;
  }

  static async create(options: LocalVoiceServiceOptions): Promise<LocalVoiceService> {
    const directory = options.voiceDirectory ?? defaultVoiceDirectory();
    const configPath = options.configPath ?? defaultVoiceConfigPath();
    const fallback = defaultVoiceConfig(
      options.voiceDirectory ? join(directory, 'models', 'ggml-base.bin') : defaultWhisperModelPath());
    const loaded = await loadVoiceConfig(configPath, fallback);
    await mkdir(join(directory, 'models'), {recursive: true, mode: 0o700});
    if (loaded.save) await saveVoiceConfig(configPath, loaded.config);
    const environment = options.environment ?? process.env;
    const platform = options.platform ?? process.platform;
    const service = new LocalVoiceService({
      playPcm: options.playPcm,
      configPath,
      directory,
      workingDirectory: options.workingDirectory ?? serviceInfo().root,
      environment,
      runProcess: options.runProcess ?? runVoiceProcess,
      detectDependencies: options.detectDependencies
        ?? (config => detectVoiceDependencies(config, {environment, platform})),
      timeouts: {...defaultTimeouts, ...options.timeouts},
      log: options.log ?? (() => undefined),
      config: loaded.config,
      configurationWarning: loaded.warning,
    });
    await service.#refreshDependencies();
    await service.#prepareAcknowledgment();
    return service;
  }

  snapshot(): LocalVoiceStatus {
    const sttReady = this.#dependencies.whisper.available && this.#dependencies.model.available;
    const ttsReady = this.#dependencies.say.available && this.#dependencies.ffmpeg.available;
    const copilotReady = this.#dependencies.copilot.available;
    return {
      config: {...this.#config},
      state: this.#state,
      active: this.#active !== null,
      ready: this.#config.enabled && this.#config.allowAllTools && sttReady && ttsReady && copilotReady,
      sttReady,
      ttsReady,
      copilotReady,
      dependencies: {
        whisper: {...this.#dependencies.whisper},
        model: {...this.#dependencies.model},
        say: {...this.#dependencies.say},
        ffmpeg: {...this.#dependencies.ffmpeg},
        copilot: {...this.#dependencies.copilot},
      },
      lastError: this.#lastError,
      configurationWarning: this.#configurationWarning,
    };
  }

  async getStatus(): Promise<LocalVoiceStatus> {
    await this.#refreshDependencies();
    return this.snapshot();
  }

  async updateConfig(value: unknown): Promise<LocalVoiceStatus> {
    this.#assertIdle();
    const config = mergeVoiceConfig(this.#config, value);
    const refreshAcknowledgment = config.ttsVoice !== this.#config.ttsVoice
      || config.ttsRate !== this.#config.ttsRate;
    await saveVoiceConfig(this.#configPath, config);
    this.#config = config;
    this.#configurationWarning = null;
    this.#lastError = null;
    await this.#refreshDependencies();
    if (refreshAcknowledgment) await this.#prepareAcknowledgment();
    this.#changed();
    return this.snapshot();
  }

  async resetSession(): Promise<LocalVoiceStatus> {
    this.#assertIdle();
    this.#config = {...this.#config, sessionId: randomUUID()};
    await saveVoiceConfig(this.#configPath, this.#config);
    this.#lastError = null;
    this.#changed();
    return this.snapshot();
  }

  cancel(): boolean {
    if (!this.#active) return false;
    this.#state = 'canceling';
    this.#changed();
    this.#active.controller.abort();
    return true;
  }

  async acknowledge(): Promise<boolean> {
    return this.#exclusive('speaking', signal => this.#playAcknowledgment(signal));
  }

  speakInputPrompt(text: string): Promise<boolean> {
    const message = text.trim();
    if (!message || message.length > maxInputPromptCharacters)
      throw new VoiceConfigurationError(
        `Input prompt text must contain 1 to ${maxInputPromptCharacters} characters.`);
    const task = this.#inputPromptQueue.then(() => this.#speakInputPrompt(message));
    this.#inputPromptQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async #speakInputPrompt(message: string): Promise<boolean> {
    if (!this.#config.enabled) {
      this.#log('input prompt skipped: local voice is disabled');
      return false;
    }
    if (this.#active) this.#log('input prompt queued until the current voice operation finishes');
    await this.#waitUntilIdle();
    if (!this.#config.enabled) return false;
    await this.#exclusive('speaking', async signal => {
      await this.#refreshDependencies();
      this.#requireTtsReady();
      const turnDirectory = await this.#turnDirectory();
      try {
        await this.#synthesizeAndPlay(message, turnDirectory, signal, 'input-prompt');
      } finally {
        await rm(turnDirectory, {recursive: true, force: true});
      }
    });
    return true;
  }

  #waitUntilIdle(): Promise<void> {
    if (!this.#active) return Promise.resolve();
    return new Promise(resolve => {
      const changed = () => {
        if (this.#active) return;
        this.off('change', changed);
        resolve();
      };
      this.on('change', changed);
    });
  }

  async processCapture(
      pcm: Buffer, sampleRate: number, options: VoiceTurnOptions = {}): Promise<VoiceTurnResult> {
    if (sampleRate !== captureSampleRate)
      throw new VoiceConfigurationError(`Voice capture must be ${captureSampleRate} Hz mono signed 16-bit PCM.`);
    if (!pcm.length || pcm.length % 2 !== 0)
      throw new VoiceConfigurationError('Voice capture must contain complete signed 16-bit PCM samples.');
    const seconds = pcm.length / (sampleRate * 2);
    if (seconds > this.#config.maxRecordingSeconds)
      throw new VoiceConfigurationError(
        `Voice capture is ${seconds.toFixed(1)} seconds. The configured maximum is ${this.#config.maxRecordingSeconds} seconds.`);
    return this.#exclusive('transcribing', async signal => {
      const turnStarted = performance.now();
      await this.#refreshDependencies();
      this.#requireConversationReady();
      const turnDirectory = await this.#turnDirectory();
      try {
        const inputWav = join(turnDirectory, 'capture.wav');
        const transcriptBase = join(turnDirectory, 'transcript');
        await writeFile(inputWav, pcm16MonoWav(pcm, sampleRate), {mode: 0o600});
        const transcription = this.#timed('transcription', () => this.#run(
          this.#dependencies.whisper.path!, whisperArguments(this.#config, inputWav, transcriptBase),
          this.#timeouts.whisperMs, 'Whisper.cpp transcription', signal));
        const acknowledgment = options.acknowledgmentPlayed
          ? Promise.resolve(false) : this.#playAcknowledgment(signal);
        const [transcriptionResult, acknowledgmentResult] = await Promise.allSettled([
          transcription,
          acknowledgment,
        ]);
        if (transcriptionResult.status === 'rejected') throw transcriptionResult.reason;
        if (acknowledgmentResult.status === 'rejected') throw acknowledgmentResult.reason;
        let transcript: string;
        try {
          transcript = (await readFile(`${transcriptBase}.txt`, 'utf8')).trim();
        } catch (error) {
          throw new LocalVoiceError(
            `Whisper.cpp finished without writing a transcript: ${
              error instanceof Error ? error.message : String(error)}`, 409, 'voice_transcript_missing');
        }
        if (!transcript) throw new LocalVoiceError('Whisper.cpp did not recognize any speech.', 409, 'voice_no_speech');
        if (transcript.length > maxTranscriptCharacters)
          throw new LocalVoiceError('The transcript is too long to send to Copilot.', 409, 'voice_transcript_limit');

        this.#setState('thinking');
        const copilot = await this.#timed('Copilot response', () => this.#run(
          this.#dependencies.copilot.path!,
          copilotArguments(transcript, this.#config, this.#workingDirectory),
          this.#timeouts.copilotMs, 'GitHub Copilot CLI', signal));
        const response = copilot.stdout.trim();
        if (!response)
          throw new LocalVoiceError('GitHub Copilot CLI returned an empty response.', 409, 'voice_empty_response');

        this.#setState('speaking');
        const playbackBytes = await this.#synthesizeAndPlay(response, turnDirectory, signal);
        this.#log(`turn total: ${this.#milliseconds(turnStarted)} ms`);
        return {transcript, response, sessionId: this.#config.sessionId, playbackBytes};
      } finally {
        await rm(turnDirectory, {recursive: true, force: true});
      }
    });
  }

  async testTts(text = 'Agent Buddy local voice is ready.'): Promise<{playbackBytes: number; status: LocalVoiceStatus}> {
    const message = text.trim();
    if (!message || message.length > maxTtsTestCharacters)
      throw new VoiceConfigurationError(`TTS test text must contain 1 to ${maxTtsTestCharacters} characters.`);
    const playbackBytes = await this.#exclusive('testing', async signal => {
      await this.#refreshDependencies();
      this.#requireTtsReady();
      const turnDirectory = await this.#turnDirectory();
      try {
        return await this.#synthesizeAndPlay(message, turnDirectory, signal);
      } finally {
        await rm(turnDirectory, {recursive: true, force: true});
      }
    });
    return {playbackBytes, status: this.snapshot()};
  }

  async #refreshDependencies(): Promise<void> {
    this.#dependencies = await this.#detectDependencies(this.#config);
    this.#changed();
  }

  #requireConversationReady(): void {
    if (!this.#config.enabled) throw new VoiceDependencyError('Local voice is disabled in settings.');
    if (!this.#config.allowAllTools)
      throw new VoiceDependencyError(
        'Voice Copilot turns are blocked because Allow all tools is off. Non-interactive Copilot requires this permission.');
    const missing = [
      this.#dependencies.whisper,
      this.#dependencies.model,
      this.#dependencies.copilot,
      this.#dependencies.say,
      this.#dependencies.ffmpeg,
    ].filter(item => !item.available);
    if (missing.length)
      throw new VoiceDependencyError(`Local voice dependencies are missing: ${missing.map(item => item.message).join(' ')}`);
  }

  #requireTtsReady(): void {
    const missing = [this.#dependencies.say, this.#dependencies.ffmpeg].filter(item => !item.available);
    if (missing.length)
      throw new VoiceDependencyError(`Local TTS dependencies are missing: ${missing.map(item => item.message).join(' ')}`);
  }

  async #synthesizeAndPlay(
      text: string, directory: string, signal: AbortSignal,
      label: 'response' | 'input-prompt' = 'response'): Promise<number> {
    const pcm = await this.#synthesize(text, directory, signal, label);
    await this.#timed(`${label.replace('-', ' ')} playback`, () => this.#playPcm(pcm, playbackSampleRate, signal));
    return pcm.length;
  }

  async #synthesize(
      text: string, directory: string, signal: AbortSignal,
      label: 'acknowledgment' | 'response' | 'input-prompt'): Promise<Buffer> {
    if (text.length > maxSpokenCharacters)
      throw new LocalVoiceError(
        `The Copilot response is ${text.length} characters, which is too long to synthesize safely.`,
        409, 'voice_tts_text_limit');
    const textFile = join(directory, `${label}.txt`);
    const aiffFile = join(directory, `${label}.aiff`);
    const pcmFile = join(directory, `${label}.pcm`);
    await writeFile(textFile, text, {encoding: 'utf8', mode: 0o600});
    await this.#timed(`${label} synthesis`, () => this.#run(
      this.#dependencies.say.path!, sayArguments(this.#config, textFile, aiffFile),
      this.#timeouts.sayMs, 'macOS say', signal));
    await this.#timed(`${label} conversion`, () => this.#run(
      this.#dependencies.ffmpeg.path!, ffmpegArguments(aiffFile, pcmFile),
      this.#timeouts.ffmpegMs, 'ffmpeg PCM conversion', signal));
    const file = await stat(pcmFile);
    if (!file.isFile() || file.size <= 0)
      throw new LocalVoiceError('ffmpeg did not produce playable PCM audio.', 409, 'voice_pcm_empty');
    if (file.size > maxPcmPlaybackBytes)
      throw new LocalVoiceError('The synthesized PCM audio is too large to play.', 409, 'voice_pcm_limit');
    return readFile(pcmFile);
  }

  async #prepareAcknowledgment(): Promise<void> {
    this.#acknowledgmentPcm = null;
    if (!this.#dependencies.say.available || !this.#dependencies.ffmpeg.available) return;
    const directory = await this.#turnDirectory();
    try {
      this.#acknowledgmentPcm = await this.#synthesize(
        acknowledgmentText, directory, new AbortController().signal, 'acknowledgment');
      this.#log(`acknowledgment cached: ${this.#acknowledgmentPcm.length} bytes`);
    } catch (error) {
      this.#log(`acknowledgment cache unavailable: ${
        error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  }

  async #playAcknowledgment(signal: AbortSignal): Promise<boolean> {
    if (!this.#acknowledgmentPcm) {
      this.#log('acknowledgment playback skipped: no cached audio');
      return false;
    }
    try {
      await this.#timed(
        'acknowledgment playback',
        () => this.#playPcm(this.#acknowledgmentPcm!, playbackSampleRate, signal));
      return true;
    } catch (error) {
      if (signal.aborted) throw error;
      this.#log(`acknowledgment playback failed: ${
        error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async #timed<T>(label: string, action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let succeeded = false;
    try {
      const result = await action();
      succeeded = true;
      return result;
    } finally {
      this.#log(`${label}: ${this.#milliseconds(started)} ms${succeeded ? '' : ' (failed)'}`);
    }
  }

  #milliseconds(started: number): number {
    return Math.round(performance.now() - started);
  }

  #run(
      command: string, args: readonly string[], timeoutMs: number, label: string,
      signal: AbortSignal): Promise<VoiceProcessResult> {
    return this.#runProcess(command, args, {
      cwd: this.#workingDirectory,
      environment: this.#environment,
      timeoutMs,
      maxOutputBytes: defaultProcessOutputBytes,
      signal,
      label,
    });
  }

  async #turnDirectory(): Promise<string> {
    const directory = join(this.#directory, 'runtime', randomUUID());
    await mkdir(directory, {recursive: true, mode: 0o700});
    return directory;
  }

  async #exclusive<T>(state: LocalVoiceState, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertIdle();
    const controller = new AbortController();
    this.#active = {controller};
    this.#state = state;
    this.#lastError = null;
    this.#changed();
    try {
      const result = await action(controller.signal);
      this.#state = 'idle';
      return result;
    } catch (error) {
      const normalized = controller.signal.aborted ? new VoiceCancelledError() : asLocalVoiceError(error);
      this.#lastError = normalized.message;
      this.#state = controller.signal.aborted ? 'idle' : 'error';
      throw normalized;
    } finally {
      this.#active = null;
      this.#changed();
    }
  }

  #assertIdle(): void {
    if (this.#active) throw new VoiceBusyError();
  }

  #setState(state: LocalVoiceState): void {
    this.#state = state;
    this.#changed();
  }

  #changed(): void {
    this.emit('change', this.snapshot());
  }
}
