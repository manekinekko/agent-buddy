#pragma once
// One owner for the ES8311 speaker and ES7210 microphones, which share their
// MCLK, BCLK, LRCK, I2C bus, and I2S controller.
#include <Arduino.h>
#include <Wire.h>
#include <algorithm>
#include <cstdint>
#include <driver/i2s.h>
#include "Es7210Microphone.h"
#include "es8311/es8311.h"

namespace copilot {
namespace board {
struct Es8311Es7210Config {
  int mclkPin;
  int bclkPin;
  int wordSelectPin;
  int dataOutPin;
  int dataInPin;
  int amplifierPin;
  unsigned i2cPort;
  uint8_t outputAddress;
  uint8_t inputAddress;
  int minimumVolume;
  int maximumVolume;
  uint8_t microphoneGain;
  uint8_t microphoneSlots;
  uint8_t microphoneSlot;
};

class Es8311Es7210Audio {
 public:
  explicit Es8311Es7210Audio(const Es8311Es7210Config& config) : config_(config) {}

  const char* begin(unsigned sampleRate) {
    playbackSampleRate_ = sampleRate;
    pinMode(config_.amplifierPin, OUTPUT);
    digitalWrite(config_.amplifierPin, LOW);
    if (!installPlayback()) return "i2s-init";

    codec_ = es8311_create(config_.i2cPort, config_.outputAddress);
    const es8311_clock_config_t clock = {
        .mclk_inverted = false,
        .sclk_inverted = false,
        .mclk_from_mclk_pin = true,
        .mclk_frequency = static_cast<int>(sampleRate * 256),
        .sample_frequency = static_cast<int>(sampleRate),
    };
    if (!codec_ || es8311_init(codec_, &clock, ES8311_RESOLUTION_16, ES8311_RESOLUTION_16) != ESP_OK
        || es8311_sample_frequency_config(codec_, clock.mclk_frequency, clock.sample_frequency) != ESP_OK
        || es8311_voice_fade(codec_, ES8311_FADE_64LRCK) != ESP_OK
        || es8311_voice_mute(codec_, true) != ESP_OK) {
      if (codec_) {
        es8311_delete(codec_);
        codec_ = nullptr;
      }
      uninstallI2s();
      return "codec-init";
    }
    return nullptr;
  }

  bool enable(uint8_t volume) {
    if (!playbackInstalled_ && !installPlayback()) return false;
    if (es8311_voice_volume_set(codec_, codecVolume(volume), nullptr) != ESP_OK) return false;
    digitalWrite(config_.amplifierPin, HIGH);
    delay(4);
    if (es8311_voice_mute(codec_, false) != ESP_OK) {
      digitalWrite(config_.amplifierPin, LOW);
      return false;
    }
    return true;
  }

  bool write(const uint8_t* data, size_t size) {
    if (!playbackInstalled_) return false;
    while (size > 0) {
      size_t written = 0;
      if (i2s_write(kPort, data, size, &written, portMAX_DELAY) != ESP_OK || written == 0)
        return false;
      data += written;
      size -= written;
    }
    return true;
  }

  void disable() {
    if (codec_) es8311_voice_mute(codec_, true);
    delay(2);
    digitalWrite(config_.amplifierPin, LOW);
  }

  const char* beginCapture(unsigned sampleRate) {
    if (sampleRate != 16000) return "capture-rate";
    disable();
    uninstallI2s();
    if (!installCapture(sampleRate)) return "capture-i2s";
    if (!microphone_.begin(Wire, config_.inputAddress, config_.microphoneGain)) {
      uninstallI2s();
      installPlayback();
      return "capture-codec";
    }
    return nullptr;
  }

  bool readCapture(uint8_t* output, size_t capacity, size_t& bytesRead) {
    bytesRead = 0;
    if (!captureInstalled_) return false;
    constexpr size_t kSingleChannelReadBytes = 2048;
    if (config_.microphoneSlots > 1) {
      constexpr size_t kFrames = 256;
      int16_t slots[kFrames * 4];
      const size_t frameBytes = config_.microphoneSlots * sizeof(int16_t);
      const size_t requested = std::min(
          sizeof(slots), (capacity / sizeof(int16_t)) * frameBytes);
      size_t rawBytes = 0;
      const esp_err_t result = i2s_read(
          kPort, slots, requested, &rawBytes, pdMS_TO_TICKS(100));
      if (result != ESP_OK && result != ESP_ERR_TIMEOUT) return false;
      const size_t frames = rawBytes / frameBytes;
      auto* mono = reinterpret_cast<int16_t*>(output);
      for (size_t frame = 0; frame < frames; ++frame)
        mono[frame] = slots[frame * config_.microphoneSlots + config_.microphoneSlot];
      bytesRead = frames * sizeof(int16_t);
      return true;
    }
    const esp_err_t result = i2s_read(
        kPort, output, std::min(capacity, kSingleChannelReadBytes),
        &bytesRead, pdMS_TO_TICKS(100));
    return result == ESP_OK || result == ESP_ERR_TIMEOUT;
  }

  const char* endCapture() {
    microphone_.stop();
    uninstallI2s();
    return installPlayback() ? nullptr : "playback-restore";
  }

 private:
  static constexpr i2s_port_t kPort = I2S_NUM_0;

  bool installPlayback() {
    if (playbackInstalled_) return true;
    const i2s_config_t i2sConfig = {
        .mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_TX),
        .sample_rate = playbackSampleRate_,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = 128,
        .use_apll = false,
        .tx_desc_auto_clear = true,
        .fixed_mclk = 0,
        .mclk_multiple = I2S_MCLK_MULTIPLE_256,
        .bits_per_chan = I2S_BITS_PER_CHAN_16BIT,
    };
    const i2s_pin_config_t pins = {
        .mck_io_num = config_.mclkPin,
        .bck_io_num = config_.bclkPin,
        .ws_io_num = config_.wordSelectPin,
        .data_out_num = config_.dataOutPin,
        .data_in_num = I2S_PIN_NO_CHANGE,
    };
    if (i2s_driver_install(kPort, &i2sConfig, 0, nullptr) != ESP_OK) return false;
    driverInstalled_ = true;
    if (i2s_set_pin(kPort, &pins) != ESP_OK) {
      uninstallI2s();
      return false;
    }
    i2s_zero_dma_buffer(kPort);
    playbackInstalled_ = true;
    return true;
  }

  bool installCapture(unsigned sampleRate) {
    const i2s_config_t i2sConfig = {
        .mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX),
        .sample_rate = sampleRate,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = config_.microphoneSlots > 2
            ? I2S_CHANNEL_FMT_MULTIPLE : I2S_CHANNEL_FMT_ALL_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
        .dma_buf_count = 8,
        .dma_buf_len = 128,
        .use_apll = false,
        .tx_desc_auto_clear = true,
        .fixed_mclk = 0,
        .mclk_multiple = I2S_MCLK_MULTIPLE_256,
        .bits_per_chan = I2S_BITS_PER_CHAN_16BIT,
    };
    const i2s_pin_config_t pins = {
        .mck_io_num = config_.mclkPin,
        .bck_io_num = config_.bclkPin,
        .ws_io_num = config_.wordSelectPin,
        .data_out_num = I2S_PIN_NO_CHANGE,
        .data_in_num = config_.dataInPin,
    };
    if (i2s_driver_install(kPort, &i2sConfig, 0, nullptr) != ESP_OK) return false;
    driverInstalled_ = true;
    if (i2s_set_pin(kPort, &pins) != ESP_OK) {
      uninstallI2s();
      return false;
    }
    i2s_zero_dma_buffer(kPort);
    captureInstalled_ = true;
    return true;
  }

  void uninstallI2s() {
    if (driverInstalled_) i2s_driver_uninstall(kPort);
    driverInstalled_ = false;
    playbackInstalled_ = false;
    captureInstalled_ = false;
  }

  int codecVolume(uint8_t volume) const {
    return config_.minimumVolume
        + (volume * (config_.maximumVolume - config_.minimumVolume) + 50) / 100;
  }

  Es8311Es7210Config config_;
  Es7210Microphone microphone_;
  es8311_handle_t codec_ = nullptr;
  unsigned playbackSampleRate_ = 0;
  bool driverInstalled_ = false;
  bool playbackInstalled_ = false;
  bool captureInstalled_ = false;
};
}  // namespace board
}  // namespace copilot
