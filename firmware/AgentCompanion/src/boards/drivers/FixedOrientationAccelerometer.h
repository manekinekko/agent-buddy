#pragma once

namespace copilot {
namespace board {
class FixedOrientationAccelerometer {
 public:
  const char* begin() {
    return "This board has no orientation sensor.";
  }

  bool read(float&, float&, float&) {
    return false;
  }
};
}  // namespace board
}  // namespace copilot
