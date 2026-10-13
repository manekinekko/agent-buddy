#pragma once
// Device-only drivers for the Waveshare ESP32-P4 86-panel assembly (see BoardConfig.h).
#include "BoardConfig.h"
#include "../drivers/Es8311AudioOutput.h"
#include "../drivers/FixedOrientationAccelerometer.h"
#include "../drivers/Gt911TouchController.h"
#include <Arduino_GFX_Library.h>
#include <displays_config.h>
#include <Wire.h>

namespace copilot {
namespace board {
using TouchController = Gt911TouchController;
constexpr uint8_t kTouchPointCapacity = 5;
static_assert(kAudioCodecI2cAddress == ES8311_ADDRESS_0, "Codec address differs from the driver.");

inline Arduino_ESP32DSIPanel& displayBus() {
  static Arduino_ESP32DSIPanel bus(
      display_cfg.hsync_pulse_width, display_cfg.hsync_back_porch,
      display_cfg.hsync_front_porch, display_cfg.vsync_pulse_width,
      display_cfg.vsync_back_porch, display_cfg.vsync_front_porch,
      display_cfg.prefer_speed, display_cfg.lane_bit_rate);
  return bus;
}

inline DisplayPanel& displayPanel() {
  // OrientedDisplay resets this active-low ST7703; the vendor class sequence targets an
  // active-high HX8394 panel in the same shared library.
  static DisplayPanel panel(
      kPanelWidth, kPanelHeight, &displayBus(), display_cfg.rotation, false,
      GFX_NOT_DEFINED, display_cfg.init_cmds, display_cfg.init_cmds_size);
  return panel;
}

inline Arduino_DataBus* displayWriteBus() {
  return nullptr;
}

inline FixedOrientationAccelerometer& accelerometer() {
  static FixedOrientationAccelerometer sensor;
  return sensor;
}

inline Es8311AudioOutput& audioOutput() {
  static Es8311AudioOutput output({kAudioMclkPin, kAudioBclkPin, kAudioWordSelectPin,
                                   kAudioDataOutPin, kAudioAmplifierPin, kI2cPort,
                                   kAudioCodecI2cAddress, kAudioMinimumCodecVolume,
                                   kAudioMaximumCodecVolume});
  return output;
}
}  // namespace board
}  // namespace copilot
