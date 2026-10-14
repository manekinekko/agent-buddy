#pragma once
#include <cstdint>

namespace copilot {
struct VoiceButtonBounds {
  int16_t x;
  int16_t y;
  int16_t width;
  int16_t height;

  bool contains(int16_t pointX, int16_t pointY) const {
    return pointX >= x && pointX < x + width && pointY >= y && pointY < y + height;
  }
};

constexpr int16_t kVoiceCanvasSize = 466;
constexpr int16_t kVoiceButtonSize = 80;
constexpr int16_t kVoiceButtonMargin = 16;
constexpr VoiceButtonBounds kVoiceButtonBounds{
    (kVoiceCanvasSize - kVoiceButtonSize) / 2,
    kVoiceCanvasSize - kVoiceButtonSize - kVoiceButtonMargin,
    kVoiceButtonSize,
    kVoiceButtonSize};

enum class VoicePushToTalkAction : uint8_t {
  None,
  Start,
  Stop,
  Cancel,
};

class VoicePushToTalkTracker {
 public:
  VoicePushToTalkAction sample(
      bool pressed, int16_t x, int16_t y, bool enabled, uint32_t nowMs) {
    consumedLastSample_ = false;
    if (!enabled) {
      const bool cancel = active_;
      active_ = false;
      releasePending_ = false;
      if (pressed) {
        blockedUntilRelease_ = true;
        consumedLastSample_ = consumingGesture_;
      } else {
        consumingGesture_ = false;
      }
      return cancel ? VoicePushToTalkAction::Cancel : VoicePushToTalkAction::None;
    }
    if (!pressed) {
      consumedLastSample_ = consumingGesture_;
      if (active_) {
        if (!releasePending_) {
          releasePending_ = true;
          releaseStartedMs_ = nowMs;
          return VoicePushToTalkAction::None;
        }
        if (nowMs - releaseStartedMs_ < kReleaseDebounceMs)
          return VoicePushToTalkAction::None;
      }
      releasePending_ = false;
      blockedUntilRelease_ = false;
      consumingGesture_ = false;
      if (!active_) return VoicePushToTalkAction::None;
      active_ = false;
      return VoicePushToTalkAction::Stop;
    }
    releasePending_ = false;
    if (blockedUntilRelease_) return VoicePushToTalkAction::None;
    if (!active_) {
      if (!kVoiceButtonBounds.contains(x, y)) {
        blockedUntilRelease_ = true;
        return VoicePushToTalkAction::None;
      }
      active_ = true;
      consumingGesture_ = true;
      consumedLastSample_ = true;
      return VoicePushToTalkAction::Start;
    }
    consumedLastSample_ = true;
    if (kVoiceButtonBounds.contains(x, y)) return VoicePushToTalkAction::None;
    active_ = false;
    blockedUntilRelease_ = true;
    return VoicePushToTalkAction::Cancel;
  }

  bool active() const { return active_; }
  bool consumedLastSample() const { return consumedLastSample_; }

 private:
  static constexpr uint32_t kReleaseDebounceMs = 100;
  bool active_ = false;
  bool blockedUntilRelease_ = false;
  bool consumingGesture_ = false;
  bool consumedLastSample_ = false;
  bool releasePending_ = false;
  uint32_t releaseStartedMs_ = 0;
};
}
