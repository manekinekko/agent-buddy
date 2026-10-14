import type {DeviceCapabilities} from './protocol.js';

export type {DeviceCapabilities} from './protocol.js';

export const voiceProtocol = 13;
export const voiceCaptureSampleRate = 16000;
export const voicePlaybackSampleRate = 24000;
export const voiceMaximumCaptureBytes = voiceCaptureSampleRate * 15 * 2;
export const voiceMaximumPlaybackBytes = voicePlaybackSampleRate * 45 * 2;

export interface VoiceCapture {
  pcm: Buffer;
  sampleRate: number;
}

export interface VoiceCaptureHeader {
  id: number;
  bytes: number;
  sampleRate: number;
}

export function parseUsbCapabilities(info: string): DeviceCapabilities {
  return {
    speaker: /\bspeaker=1\b/.test(info),
    microphone: /\bmicrophone=1\b/.test(info),
  };
}

export function parseWifiCapabilities(value: unknown): DeviceCapabilities {
  if (!value || typeof value !== 'object') return {speaker: false, microphone: false};
  const capabilities = value as {speaker?: unknown; microphone?: unknown};
  return {
    speaker: capabilities.speaker === true,
    microphone: capabilities.microphone === true,
  };
}

export function parseVoiceCaptureReady(line: string): VoiceCaptureHeader | null {
  const match = /^VOICE_CAPTURE id=(\d+) bytes=(\d+) sample_rate=(\d+) channels=1 format=s16le$/.exec(line);
  if (!match) return null;
  return validCaptureHeader(match);
}

export function parseVoicePcmHeader(line: string): VoiceCaptureHeader | null {
  const match = /^VOICE_PCM id=(\d+) bytes=(\d+) sample_rate=(\d+) channels=1 format=s16le$/.exec(line);
  if (!match) return null;
  return validCaptureHeader(match);
}

function validCaptureHeader(match: RegExpExecArray): VoiceCaptureHeader | null {
  const id = Number(match[1]);
  const bytes = Number(match[2]);
  const sampleRate = Number(match[3]);
  if (!Number.isInteger(id) || id <= 0 || id > 0xFFFFFFFF
      || !Number.isInteger(bytes) || bytes <= 0 || bytes > voiceMaximumCaptureBytes
      || bytes % 2 || sampleRate !== voiceCaptureSampleRate) return null;
  return {id, bytes, sampleRate};
}

export function parseVoicePlaybackReady(line: string): {bytes: number; sampleRate: number; chunk: number} | null {
  const match = /^VOICE_PLAY_READY bytes=(\d+) sample_rate=(\d+) chunk=(\d+)$/.exec(line);
  if (!match) return null;
  const bytes = Number(match[1]);
  const sampleRate = Number(match[2]);
  const chunk = Number(match[3]);
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > voiceMaximumPlaybackBytes
      || bytes % 2 || sampleRate !== voicePlaybackSampleRate
      || !Number.isInteger(chunk) || chunk < 256 || chunk > 65536) return null;
  return {bytes, sampleRate, chunk};
}
