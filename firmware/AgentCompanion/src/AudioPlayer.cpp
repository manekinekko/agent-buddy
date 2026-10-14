#include "AudioPlayer.h"

#include <Arduino.h>
#include <algorithm>
#include <atomic>
#include <cstring>
#include <esp_heap_caps.h>
#include "../generated/audio_assets.h"
#include "Config.h"
#include "boards/BoardDrivers.h"

namespace copilot {
namespace {
struct AudioAsset {
  const int16_t* samples;
  uint32_t count;
};

enum class AudioCommandKind : uint8_t {
  Cue,
  StartCapture,
  StopCapture,
  CancelCapture,
  PlayVoice,
  CancelPlayback,
};

struct AudioCommand {
  AudioCommandKind kind = AudioCommandKind::Cue;
  AudioCue cue = AudioCue::Working;
  uint8_t* data = nullptr;
  size_t bytes = 0;
  unsigned sampleRate = 0;
};

QueueHandle_t audioQueue = nullptr;
std::atomic<uint8_t> currentVolume{kDefaultSoundVolume};
std::atomic<bool> ready{false};
std::atomic<VoiceAudioState> voiceState{VoiceAudioState::Idle};
std::atomic<uint32_t> captureId{0};
std::atomic<size_t> captureBytes{0};
uint8_t* captureBuffer = nullptr;

AudioAsset assetForCue(AudioCue cue) {
  switch (cue) {
    case AudioCue::Working:
      return {kAudioWorking, kAudioWorkingSamples};
    case AudioCue::Attention:
      return {kAudioAttention, kAudioAttentionSamples};
    case AudioCue::Complete:
      return {kAudioComplete, kAudioCompleteSamples};
    case AudioCue::Surprise:
      return {kAudioSurprise, kAudioSurpriseSamples};
    case AudioCue::Settings:
      return {kAudioSettings, kAudioSettingsSamples};
  }
  return {nullptr, 0};
}

bool nextCommand(AudioCommand& command) {
  return xQueueReceive(audioQueue, &command, 0) == pdTRUE;
}

// Returns false with interrupted set when a higher-priority command stops playback.
bool playCue(AudioCue cue, AudioCommand& interrupted) {
  const uint8_t volume = soundVolume();
  if (volume == 0) return true;
  const AudioAsset asset = assetForCue(cue);
  if (!asset.samples || asset.count == 0) return true;

  auto& output = board::audioOutput();
  if (!output.enable(volume)) {
    Serial.println("AUDIO error=codec-output");
    return true;
  }

  constexpr size_t kChunkFrames = 512;
  static int16_t stereo[kChunkFrames * 2];
  for (uint32_t offset = 0; offset < asset.count; offset += kChunkFrames) {
    if (soundVolume() == 0) break;
    if (nextCommand(interrupted)) {
      output.disable();
      return false;
    }
    const size_t frames =
        min(static_cast<uint32_t>(kChunkFrames), asset.count - offset);
    for (size_t frame = 0; frame < frames; ++frame) {
      stereo[frame * 2] = asset.samples[offset + frame];
      stereo[frame * 2 + 1] = asset.samples[offset + frame];
    }
    if (!output.write(reinterpret_cast<const uint8_t*>(stereo), frames * 4)) {
      Serial.println("AUDIO error=i2s-write");
      break;
    }
  }

  memset(stereo, 0, sizeof(stereo));
  output.write(reinterpret_cast<const uint8_t*>(stereo), 96 * 4);
  output.disable();
  return true;
}

bool recordVoice(AudioCommand& interrupted) {
  voiceState.store(VoiceAudioState::Starting);
  captureBytes.store(0);
  if (const char* error = board::audioOutput().beginCapture(kVoiceCaptureSampleRate)) {
    voiceState.store(VoiceAudioState::Error);
    Serial.printf("VOICE_ERROR capture=%s\n", error);
    return true;
  }
  voiceState.store(VoiceAudioState::Recording);
  const uint32_t started = millis();
  uint32_t lastSpeechMs = started;
  bool heardSpeech = false;
  bool cancelled = false;
  size_t recorded = 0;
  uint32_t minimumChunkMean = UINT32_MAX;
  uint32_t maximumChunkMean = 0;
  const char* stopReason = "timeout";
  while (recorded < kVoiceMaximumCaptureBytes
         && millis() - started < kVoiceMaximumSeconds * 1000) {
    if (nextCommand(interrupted)) {
      if (interrupted.kind == AudioCommandKind::StopCapture) {
        if (heardSpeech) {
          stopReason = "touch-release";
          break;
        }
        stopReason = "release-before-speech";
      }
      if (interrupted.kind == AudioCommandKind::CancelCapture
          || interrupted.kind == AudioCommandKind::StartCapture) {
        stopReason = interrupted.kind == AudioCommandKind::CancelCapture
            ? "cancel" : "restart";
        cancelled = true;
        break;
      }
      // Cues and playback do not interrupt the microphone.
      if (interrupted.kind == AudioCommandKind::PlayVoice && interrupted.data)
        heap_caps_free(interrupted.data);
    }
    size_t count = 0;
    if (!board::audioOutput().readCapture(
            captureBuffer + recorded, kVoiceMaximumCaptureBytes - recorded, count)) {
      Serial.println("VOICE_ERROR capture=i2s-read");
      cancelled = true;
      voiceState.store(VoiceAudioState::Error);
      break;
    }
    recorded += count;
    const uint32_t now = millis();
    const uint32_t chunkMean = voiceMeanAbsoluteAmplitude(
        reinterpret_cast<const int16_t*>(captureBuffer + recorded - count),
        count / sizeof(int16_t));
    if (count) {
      minimumChunkMean = std::min(minimumChunkMean, chunkMean);
      maximumChunkMean = std::max(maximumChunkMean, chunkMean);
    }
    if (chunkMean >= kVoiceSpeechMeanAmplitude) {
      heardSpeech = true;
      lastSpeechMs = now;
    } else if (heardSpeech && now - lastSpeechMs >= kVoiceSilenceStopMs) {
      stopReason = "silence";
      break;
    } else if (!heardSpeech && now - started >= kVoiceNoSpeechStopMs) {
      stopReason = "no-speech";
      cancelled = true;
      break;
    }
  }
  if (recorded >= kVoiceMaximumCaptureBytes) stopReason = "capacity";
  const uint32_t durationMs = millis() - started;
  Serial.printf(
      "VOICE_CAPTURE_DONE reason=%s duration_ms=%u bytes=%u heard_speech=%u min_mean=%u max_mean=%u\n",
      stopReason, static_cast<unsigned>(durationMs), static_cast<unsigned>(recorded),
      static_cast<unsigned>(heardSpeech),
      static_cast<unsigned>(minimumChunkMean == UINT32_MAX ? 0 : minimumChunkMean),
      static_cast<unsigned>(maximumChunkMean));
  if (const char* error = board::audioOutput().endCapture()) {
    Serial.printf("VOICE_ERROR capture=%s\n", error);
    voiceState.store(VoiceAudioState::Error);
    cancelled = true;
  }
  if (cancelled || recorded < 3200) {
    captureBytes.store(0);
    if (voiceState.load() != VoiceAudioState::Error) voiceState.store(VoiceAudioState::Idle);
    Serial.printf("VOICE_CAPTURE_CANCELLED bytes=%u\n", static_cast<unsigned>(recorded));
    return true;
  }
  const uint32_t id = captureId.fetch_add(1) + 1;
  captureBytes.store(recorded);
  voiceState.store(VoiceAudioState::Ready);
  Serial.printf("VOICE_CAPTURE id=%u bytes=%u sample_rate=%u channels=1 format=s16le\n",
                static_cast<unsigned>(id), static_cast<unsigned>(recorded),
                kVoiceCaptureSampleRate);
  return true;
}

bool playVoice(AudioCommand& command, AudioCommand& interrupted) {
  if (!command.data || command.bytes == 0 || command.sampleRate != kAudioSampleRate) {
    if (command.data) heap_caps_free(command.data);
    return true;
  }
  voiceState.store(VoiceAudioState::Playing);
  auto& output = board::audioOutput();
  const uint8_t volume = std::max<uint8_t>(soundVolume(), 35);
  if (!output.enable(volume)) {
    Serial.println("VOICE_ERROR playback=codec-output");
    heap_caps_free(command.data);
    voiceState.store(VoiceAudioState::Error);
    return true;
  }

  constexpr size_t kFrames = 512;
  int16_t stereo[kFrames * 2] = {};
  constexpr size_t kWarmupFrames =
      static_cast<size_t>(kAudioSampleRate) * kVoicePlaybackWarmupMs / 1000;
  for (size_t offset = 0; offset < kWarmupFrames; offset += kFrames) {
    const size_t frames = std::min(kFrames, kWarmupFrames - offset);
    if (!output.write(reinterpret_cast<const uint8_t*>(stereo), frames * 4)) {
      Serial.println("VOICE_ERROR playback=i2s-write");
      voiceState.store(VoiceAudioState::Error);
      break;
    }
  }
  const int16_t* mono = reinterpret_cast<const int16_t*>(command.data);
  const size_t samples = command.bytes / sizeof(int16_t);
  bool hasInterrupted = false;
  for (size_t offset = 0;
       voiceState.load() != VoiceAudioState::Error && offset < samples;
       offset += kFrames) {
    if (nextCommand(interrupted)) {
      if (interrupted.kind == AudioCommandKind::StartCapture
          || interrupted.kind == AudioCommandKind::CancelPlayback) {
        hasInterrupted = interrupted.kind == AudioCommandKind::StartCapture;
        break;
      }
      if (interrupted.kind == AudioCommandKind::PlayVoice && interrupted.data) {
        heap_caps_free(command.data);
        command = interrupted;
        output.disable();
        return playVoice(command, interrupted);
      }
    }
    const size_t frames = std::min(kFrames, samples - offset);
    for (size_t frame = 0; frame < frames; ++frame)
      stereo[frame * 2] = stereo[frame * 2 + 1] = mono[offset + frame];
    if (!output.write(reinterpret_cast<const uint8_t*>(stereo), frames * 4)) {
      Serial.println("VOICE_ERROR playback=i2s-write");
      voiceState.store(VoiceAudioState::Error);
      break;
    }
  }
  std::memset(stereo, 0, sizeof(stereo));
  output.write(reinterpret_cast<const uint8_t*>(stereo), 96 * 4);
  output.disable();
  heap_caps_free(command.data);
  command.data = nullptr;
  if (voiceState.load() != VoiceAudioState::Error)
    voiceState.store(captureBytes.load() > 0 ? VoiceAudioState::Ready : VoiceAudioState::Idle);
  Serial.printf("VOICE_PLAYBACK_RESUME state=%s capture_bytes=%u\n",
                voiceAudioStateName(), static_cast<unsigned>(captureBytes.load()));
  Serial.println("VOICE_PLAYBACK_END");
  return !hasInterrupted;
}

void audioTask(void*) {
  if (const char* error = board::audioOutput().begin(kAudioSampleRate)) {
    Serial.printf("AUDIO error=%s\n", error);
    vTaskDelete(nullptr);
    return;
  }
  Serial.printf("AUDIO ready sample_rate=%u volume=%u speaker=%u microphone=%u\n",
                kAudioSampleRate, static_cast<unsigned>(currentVolume.load()),
                static_cast<unsigned>(kHasSpeaker), static_cast<unsigned>(kHasMicrophone));
  ready.store(true);

  AudioCommand command;
  bool haveCommand = false;
  while (true) {
    if (!haveCommand && xQueueReceive(audioQueue, &command, portMAX_DELAY) != pdTRUE) continue;
    haveCommand = false;
    AudioCommand interrupted;
    switch (command.kind) {
      case AudioCommandKind::Cue:
        if (!playCue(command.cue, interrupted)) {
          command = interrupted;
          haveCommand = true;
        }
        break;
      case AudioCommandKind::StartCapture:
        recordVoice(interrupted);
        break;
      case AudioCommandKind::PlayVoice:
        if (!playVoice(command, interrupted)) {
          command = interrupted;
          haveCommand = true;
        }
        break;
      case AudioCommandKind::StopCapture:
      case AudioCommandKind::CancelCapture:
      case AudioCommandKind::CancelPlayback:
        break;
    }
  }
}
}

bool beginAudio() {
  if (audioQueue) return true;
  audioQueue = xQueueCreate(8, sizeof(AudioCommand));
  if (!audioQueue) {
    Serial.println("AUDIO error=queue-create");
    return false;
  }
  if constexpr (kHasMicrophone) {
    captureBuffer = static_cast<uint8_t*>(heap_caps_malloc(
        kVoiceMaximumCaptureBytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!captureBuffer) {
      vQueueDelete(audioQueue);
      audioQueue = nullptr;
      Serial.println("AUDIO error=capture-buffer");
      return false;
    }
  }
  if (xTaskCreatePinnedToCore(audioTask, "audio", 6144, nullptr, 1, nullptr, 1) !=
      pdPASS) {
    if (captureBuffer) heap_caps_free(captureBuffer);
    captureBuffer = nullptr;
    vQueueDelete(audioQueue);
    audioQueue = nullptr;
    Serial.println("AUDIO error=task-create");
    return false;
  }
  return true;
}

bool audioReady() {
  return ready.load();
}

void setSoundVolume(uint8_t volume) {
  currentVolume.store(volume > 100 ? 100 : volume);
}

uint8_t soundVolume() {
  return currentVolume.load();
}

bool queueAudioCue(AudioCue cue) {
  if (!audioQueue || soundVolume() == 0 || voiceState.load() == VoiceAudioState::Recording)
    return false;
  const AudioCommand command{AudioCommandKind::Cue, cue};
  return xQueueSend(audioQueue, &command, 0) == pdPASS;
}

VoiceAudioState voiceAudioState() {
  return voiceState.load();
}

const char* voiceAudioStateName() {
  switch (voiceAudioState()) {
    case VoiceAudioState::Idle: return "idle";
    case VoiceAudioState::Starting: return "starting";
    case VoiceAudioState::Recording: return "recording";
    case VoiceAudioState::Ready: return "ready";
    case VoiceAudioState::Processing: return "processing";
    case VoiceAudioState::Playing: return "playing";
    case VoiceAudioState::Error: return "error";
  }
  return "error";
}

bool startVoiceCapture() {
  if constexpr (!kHasMicrophone) return false;
  if (!audioQueue || !ready.load() || !captureBuffer) return false;
  const VoiceAudioState state = voiceState.load();
  if (!canStartVoiceCapture(state)) return false;
  const AudioCommand command{AudioCommandKind::StartCapture};
  if (xQueueSend(audioQueue, &command, 0) != pdPASS) return false;
  voiceState.store(VoiceAudioState::Starting);
  return true;
}

bool stopVoiceCapture() {
  const VoiceAudioState state = voiceState.load();
  if (!audioQueue || (state != VoiceAudioState::Starting && state != VoiceAudioState::Recording))
    return false;
  const AudioCommand command{AudioCommandKind::StopCapture};
  return xQueueSend(audioQueue, &command, 0) == pdPASS;
}

bool cancelVoiceCapture() {
  const VoiceAudioState state = voiceState.load();
  if (!audioQueue) return false;
  if (state == VoiceAudioState::Ready || state == VoiceAudioState::Processing) {
    captureBytes.store(0);
    voiceState.store(VoiceAudioState::Idle);
    return true;
  }
  if (state == VoiceAudioState::Playing && captureBytes.load() > 0) {
    captureBytes.store(0);
    return true;
  }
  if (state != VoiceAudioState::Starting && state != VoiceAudioState::Recording) return false;
  const AudioCommand command{AudioCommandKind::CancelCapture};
  return xQueueSend(audioQueue, &command, 0) == pdPASS;
}

VoiceCaptureInfo voiceCaptureInfo() {
  const VoiceAudioState state = voiceState.load();
  const size_t bytes = captureBytes.load();
  if (!bytes || state == VoiceAudioState::Starting || state == VoiceAudioState::Recording
      || state == VoiceAudioState::Playing) return {};
  return {captureId.load(), captureBuffer, bytes, kVoiceCaptureSampleRate};
}

bool consumeVoiceCapture(uint32_t id) {
  if (!captureBytes.load() || captureId.load() != id) return false;
  captureBytes.store(0);
  voiceState.store(voiceStateAfterCaptureConsumed(kHasSpeaker));
  return true;
}

bool queueVoicePlayback(uint8_t* monoPcm, size_t bytes, unsigned sampleRate) {
  if constexpr (!kHasSpeaker) return false;
  if (!audioQueue || !ready.load() || !monoPcm || bytes == 0
      || bytes > kVoiceMaximumPlaybackBytes || bytes % sizeof(int16_t)
      || sampleRate != kAudioSampleRate) return false;
  VoiceAudioState state = voiceState.load();
  if (!canQueueVoicePlayback(state)) return false;
  if (state != VoiceAudioState::Playing
      && !voiceState.compare_exchange_strong(state, VoiceAudioState::Playing)) return false;
  const AudioCommand command{
      AudioCommandKind::PlayVoice, AudioCue::Working, monoPcm, bytes, sampleRate};
  if (xQueueSend(audioQueue, &command, 0) == pdPASS) return true;
  VoiceAudioState playing = VoiceAudioState::Playing;
  voiceState.compare_exchange_strong(playing, state);
  return false;
}

bool cancelVoicePlayback() {
  if (!audioQueue || voiceState.load() != VoiceAudioState::Playing) return false;
  const AudioCommand command{AudioCommandKind::CancelPlayback};
  return xQueueSend(audioQueue, &command, 0) == pdPASS;
}
}
