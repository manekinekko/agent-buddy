#pragma once
/*
 * ESPRESSIF MIT License
 *
 * Copyright (c) 2021 <ESPRESSIF SYSTEMS (SHANGHAI) CO., LTD>
 *
 * Permission is hereby granted for use on all ESPRESSIF SYSTEMS products, in which case,
 * it is free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the Software is furnished
 * to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Register sequence adapted from Espressif's ES7210 driver as shipped in the
 * Waveshare ESP32-P4-WIFI6-Touch-LCD-4B microphone example.
 */
#include <Arduino.h>
#include <Wire.h>
#include <cstdint>

namespace copilot {
namespace board {
class Es7210Microphone {
 public:
  bool begin(TwoWire& wire, uint8_t address, uint8_t gain) {
    wire_ = &wire;
    address_ = address;
    const uint8_t boundedGain = gain > 14 ? 14 : gain;
    bool ok = true;
    ok &= write(0x00, 0xff);
    ok &= write(0x00, 0x41);
    ok &= write(0x01, 0x1f);
    ok &= write(0x09, 0x30);
    ok &= write(0x0a, 0x30);
    ok &= write(0x40, 0xc3);
    ok &= write(0x41, 0x70);
    ok &= write(0x42, 0x70);
    // 4.096 MHz MCLK, 16 kHz LRCK, 16-bit standard I2S.
    ok &= write(0x02, 0xc1);
    ok &= write(0x07, 0x20);
    ok &= write(0x04, 0x01);
    ok &= write(0x05, 0x00);
    ok &= write(0x11, 0x60);
    ok &= write(0x12, 0x00);
    ok &= selectFrontMicrophones(boundedGain);
    if (!ok) return false;

    uint8_t clock = 0;
    ok &= read(0x01, clock);
    ok &= write(0x01, clock);
    ok &= write(0x06, 0x00);
    ok &= write(0x47, 0x00);
    ok &= write(0x48, 0x00);
    ok &= write(0x49, 0x00);
    ok &= write(0x4a, 0x00);
    ok &= selectFrontMicrophones(boundedGain);
    active_ = ok;
    return ok;
  }

  void stop() {
    if (!wire_) return;
    write(0x47, 0xff);
    write(0x48, 0xff);
    write(0x49, 0xff);
    write(0x4a, 0xff);
    write(0x4b, 0xff);
    write(0x4c, 0xff);
    write(0x01, 0x7f);
    write(0x06, 0x07);
    active_ = false;
  }

  bool active() const { return active_; }

 private:
  bool selectFrontMicrophones(uint8_t gain) {
    bool ok = true;
    for (uint8_t reg = 0x43; reg <= 0x46; ++reg) ok &= update(reg, 0x10, 0x00);
    ok &= write(0x4b, 0xff);
    ok &= write(0x4c, 0xff);
    // MIC1 and MIC2 are the two front microphones on both supported boards.
    ok &= update(0x01, 0x0b, 0x00);
    ok &= write(0x4b, 0x00);
    ok &= update(0x43, 0x1f, static_cast<uint8_t>(0x10 | gain));
    ok &= update(0x44, 0x1f, static_cast<uint8_t>(0x10 | gain));
    return ok;
  }

  bool write(uint8_t reg, uint8_t value) {
    if (!wire_) return false;
    wire_->beginTransmission(address_);
    wire_->write(reg);
    wire_->write(value);
    return wire_->endTransmission() == 0;
  }

  bool read(uint8_t reg, uint8_t& value) {
    if (!wire_) return false;
    wire_->beginTransmission(address_);
    wire_->write(reg);
    if (wire_->endTransmission(false) != 0
        || wire_->requestFrom(address_, static_cast<uint8_t>(1)) != 1) return false;
    value = wire_->read();
    return true;
  }

  bool update(uint8_t reg, uint8_t mask, uint8_t value) {
    uint8_t current = 0;
    return read(reg, current) && write(reg, (current & ~mask) | (value & mask));
  }

  TwoWire* wire_ = nullptr;
  uint8_t address_ = 0;
  bool active_ = false;
};
}  // namespace board
}  // namespace copilot
