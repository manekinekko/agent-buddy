#include "../firmware/AgentCompanion/src/VoiceUi.h"
#include "../firmware/AgentCompanion/src/AudioPlayer.h"
#include <cassert>
#include <iostream>

int main() {
  using copilot::VoicePushToTalkAction;
  static_assert(copilot::kVoiceButtonBounds.width == 80);
  static_assert(copilot::kVoiceButtonBounds.height == 80);
  static_assert(copilot::kVoiceButtonBounds.x * 2 + copilot::kVoiceButtonBounds.width
      == copilot::kVoiceCanvasSize);
  static_assert(copilot::kVoiceButtonBounds.y + copilot::kVoiceButtonBounds.height
      + copilot::kVoiceButtonMargin == copilot::kVoiceCanvasSize);
  copilot::VoicePushToTalkTracker tracker;
  uint32_t now = 1000;
  constexpr int buttonX =
      copilot::kVoiceButtonBounds.x + copilot::kVoiceButtonBounds.width / 2;
  constexpr int buttonY =
      copilot::kVoiceButtonBounds.y + copilot::kVoiceButtonBounds.height / 2;

  assert(tracker.sample(true, buttonX, buttonY, true, now) == VoicePushToTalkAction::Start);
  assert(tracker.consumedLastSample());
  assert(tracker.active());
  assert(tracker.sample(true, buttonX + 10, buttonY + 10, true, now += 30)
      == VoicePushToTalkAction::None);
  assert(tracker.sample(false, 0, 0, true, now += 30) == VoicePushToTalkAction::None);
  assert(tracker.active());
  assert(tracker.sample(true, buttonX + 10, buttonY + 10, true, now += 30)
      == VoicePushToTalkAction::None);
  assert(tracker.sample(false, 0, 0, true, now += 30) == VoicePushToTalkAction::None);
  assert(tracker.sample(false, 0, 0, true, now += 100) == VoicePushToTalkAction::Stop);
  assert(!tracker.active());

  assert(tracker.sample(true, buttonX, buttonY, true, now += 30) == VoicePushToTalkAction::Start);
  assert(tracker.sample(true, 200, 200, true, now += 30) == VoicePushToTalkAction::Cancel);
  assert(tracker.consumedLastSample());
  assert(tracker.sample(true, buttonX, buttonY, true, now += 30)
      == VoicePushToTalkAction::None);
  assert(tracker.sample(false, 0, 0, true, now += 30) == VoicePushToTalkAction::None);
  assert(tracker.consumedLastSample());

  assert(tracker.sample(true, 100, 100, true, now += 30) == VoicePushToTalkAction::None);
  assert(!tracker.consumedLastSample());
  assert(tracker.sample(true, buttonX, buttonY, true, now += 30)
      == VoicePushToTalkAction::None);
  assert(tracker.sample(false, 0, 0, true, now += 30) == VoicePushToTalkAction::None);

  assert(tracker.sample(true, buttonX, buttonY, true, now += 30)
      == VoicePushToTalkAction::Start);
  assert(tracker.sample(true, buttonX, buttonY, false, now += 30)
      == VoicePushToTalkAction::Cancel);
  assert(tracker.sample(false, 0, 0, false, now += 30) == VoicePushToTalkAction::None);

  const auto processing = copilot::voiceStateAfterCaptureConsumed(true);
  assert(processing == copilot::VoiceAudioState::Processing);
  assert(!copilot::canStartVoiceCapture(processing));
  assert(copilot::canQueueVoicePlayback(copilot::VoiceAudioState::Ready));
  assert(copilot::canQueueVoicePlayback(processing));
  assert(copilot::voiceStateAfterCaptureConsumed(false) == copilot::VoiceAudioState::Idle);
  constexpr int16_t quiet[] = {0, 8, -12, 20, -20};
  constexpr int16_t speech[] = {100, -100, 140, -140};
  static_assert(copilot::voiceMeanAbsoluteAmplitude(quiet, 5) == 12);
  static_assert(!copilot::voiceChunkHasSpeech(quiet, 5));
  static_assert(copilot::voiceChunkHasSpeech(speech, 4));

  std::cout << "PASS: voice push-to-talk debounce, cancellation, capability gate, and turn lock\n";
}
