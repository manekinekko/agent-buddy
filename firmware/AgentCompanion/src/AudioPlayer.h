#pragma once
#include <cstddef>
#include <cstdint>

namespace copilot {
enum class AudioCue : uint8_t {
  Working,
  Attention,
  Complete,
  Surprise,
  Settings,
};

enum class VoiceAudioState : uint8_t {
  Idle,
  Starting,
  Recording,
  Ready,
  Processing,
  Playing,
  Error,
};

constexpr VoiceAudioState voiceStateAfterCaptureConsumed(bool hasSpeaker) {
  return hasSpeaker ? VoiceAudioState::Processing : VoiceAudioState::Idle;
}

constexpr bool canStartVoiceCapture(VoiceAudioState state) {
  return state == VoiceAudioState::Idle || state == VoiceAudioState::Playing;
}

constexpr bool canQueueVoicePlayback(VoiceAudioState state) {
  return state == VoiceAudioState::Idle || state == VoiceAudioState::Ready
      || state == VoiceAudioState::Processing
      || state == VoiceAudioState::Playing;
}

constexpr uint16_t kVoiceSpeechMeanAmplitude = 80;
constexpr uint32_t kVoiceSilenceStopMs = 1200;
constexpr uint32_t kVoiceNoSpeechStopMs = 4000;

constexpr uint32_t voiceMeanAbsoluteAmplitude(const int16_t* samples, size_t count) {
  if (!samples || !count) return 0;
  uint64_t sum = 0;
  for (size_t index = 0; index < count; ++index) {
    const int32_t sample = samples[index];
    sum += static_cast<uint32_t>(sample < 0 ? -sample : sample);
  }
  return static_cast<uint32_t>(sum / count);
}

constexpr bool voiceChunkHasSpeech(const int16_t* samples, size_t count) {
  return voiceMeanAbsoluteAmplitude(samples, count) >= kVoiceSpeechMeanAmplitude;
}

struct VoiceCaptureInfo {
  uint32_t id = 0;
  const uint8_t* data = nullptr;
  size_t bytes = 0;
  unsigned sampleRate = 0;
};

bool beginAudio();
bool audioReady();
void setSoundVolume(uint8_t volume);
uint8_t soundVolume();
bool queueAudioCue(AudioCue cue);
VoiceAudioState voiceAudioState();
const char* voiceAudioStateName();
bool startVoiceCapture();
bool stopVoiceCapture();
bool cancelVoiceCapture();
VoiceCaptureInfo voiceCaptureInfo();
bool consumeVoiceCapture(uint32_t id);
// Takes ownership of a PSRAM buffer on success.
bool queueVoicePlayback(uint8_t* monoPcm, size_t bytes, unsigned sampleRate);
bool cancelVoicePlayback();
}
