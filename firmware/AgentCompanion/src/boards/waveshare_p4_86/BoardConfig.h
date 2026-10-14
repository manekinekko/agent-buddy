#pragma once
// Waveshare ESP32-P4-WIFI6-Touch-LCD-4B in the 86-panel assembly.
// Hardware: ST7703 720x720 MIPI-DSI LCD, GT911 touch, ESP32-C6 Wi-Fi, ES8311 codec.
// Pin source: Waveshare's schematic and examples at the revision in firmware/boards.json.
#include <cstdint>

class Arduino_DSI_Display;

#define COPILOT_DISPLAY_QSPI_DMA 0
#define COPILOT_DISPLAY_FRAMEBUFFER 1
#define COPILOT_SERIAL_USB_CDC 0

namespace copilot {
namespace board {
using DisplayPanel = ::Arduino_DSI_Display;
constexpr char kId[] = "waveshare-p4-86";
constexpr char kName[] = "Waveshare ESP32-P4 86 Panel";
constexpr char kDisplayPanelName[] = "ST7703 MIPI-DSI";
constexpr char kTouchControllerName[] = "GT911";
constexpr char kImuName[] = "none";
}  // namespace board

// Keep the existing artwork and UI coordinates on a centered logical viewport.
constexpr int kDisplaySize = 466;
constexpr int kPanelWidth = 720;
constexpr int kPanelHeight = 720;
constexpr int kDisplayOffsetX = (kPanelWidth - kDisplaySize) / 2;
constexpr int kDisplayOffsetY = (kPanelHeight - kDisplaySize) / 2;
constexpr int kDisplayBusFrequency = 38000000;
constexpr int kDisplayResetPin = 27;
constexpr bool kDisplayResetActiveLow = true;
constexpr int kDisplayBacklightPin = 26;
constexpr int kDisplayBacklightEnablePin = 33;
constexpr int kDisplayBacklightFrequency = 5000;
constexpr int kDisplayBacklightResolution = 10;
constexpr int kBrightness = 155;

constexpr int kAudioMclkPin = 13;
constexpr int kAudioBclkPin = 12;
constexpr int kAudioWordSelectPin = 10;
constexpr int kAudioDataOutPin = 9;
constexpr int kAudioDataInPin = 11;
constexpr int kAudioAmplifierPin = 53;
constexpr uint8_t kAudioCodecI2cAddress = 0x18;
constexpr uint8_t kMicrophoneCodecI2cAddress = 0x40;
constexpr uint8_t kMicrophoneGain = 8;
constexpr uint8_t kMicrophoneSlots = 1;
constexpr uint8_t kMicrophoneSlot = 0;
constexpr int kAudioMinimumCodecVolume = 68;
constexpr int kAudioMaximumCodecVolume = 82;
constexpr bool kHasSpeaker = true;
constexpr bool kHasMicrophone = true;
constexpr unsigned kSerialBaud = 921600;

constexpr unsigned kI2cPort = 0;
constexpr uint32_t kI2cFrequency = 100000;
constexpr int kTouchSda = 7;
constexpr int kTouchScl = 8;
constexpr int kTouchInterrupt = -1;
constexpr int kTouchReset = -1;
constexpr uint8_t kTouchI2cAddress = 0x5d;
constexpr bool kTouchUsesInterrupt = false;
// Waveshare warns that shorter GT911 intervals can produce false reports.
constexpr unsigned kTouchPollMs = 20;
constexpr int kTouchPanelWidth = kPanelWidth;
constexpr int kTouchPanelHeight = kPanelHeight;
constexpr bool kTouchMirrorX = false;
constexpr bool kTouchMirrorY = false;

// ESP32-P4 download strap, exposed as BOOT on the display board.
constexpr int kBootButtonPin = 35;
}  // namespace copilot
