#pragma once

#include <Arduino.h>
#include <Wire.h>
#include <algorithm>
#include <cstdint>

namespace copilot {
namespace board {
class Gt911TouchController {
 public:
  void setPins(int, int) {}

  bool begin(TwoWire& wire, uint8_t address, int sda, int scl) {
    wire_ = &wire;
    if (!wire_->begin(sda, scl, kI2cFrequency)) return false;
    wire_->setTimeOut(8);
    delay(200);
    if (probe(address)) address_ = address;
    else if (address != kBackupAddress && probe(kBackupAddress)) address_ = kBackupAddress;
    else if (address != kDefaultAddress && probe(kDefaultAddress)) address_ = kDefaultAddress;
    return address_ != 0;
  }

  uint8_t getSupportTouchPoint() const {
    return kPointCapacity;
  }

  void setMaxCoordinates(int16_t x, int16_t y) {
    maxX_ = x;
    maxY_ = y;
  }

  void setMirrorXY(bool mirrorX, bool mirrorY) {
    mirrorX_ = mirrorX;
    mirrorY_ = mirrorY;
  }

  uint8_t getPoint(int16_t* x, int16_t* y, uint8_t capacity) {
    if (!wire_ || !address_ || !x || !y || !capacity) return 0;
    uint8_t status = 0;
    if (!read(kStatusRegister, &status, 1) || !(status & 0x80)) return 0;
    const uint8_t count = status & 0x0f;
    if (!count || count > kPointCapacity) {
      clearStatus();
      return 0;
    }
    uint8_t points[kPointCapacity * kPointBytes] = {};
    const uint8_t requested = std::min(count, capacity);
    const bool ready = read(kPointRegister, points, count * kPointBytes);
    clearStatus();
    if (!ready) return 0;
    for (uint8_t index = 0; index < requested; ++index) {
      const uint8_t* point = points + index * kPointBytes;
      const uint16_t rawX = point[1] | point[2] << 8;
      const uint16_t rawY = point[3] | point[4] << 8;
      if (rawX > static_cast<uint16_t>(maxX_) || rawY > static_cast<uint16_t>(maxY_)) return 0;
      const int16_t pointX = static_cast<int16_t>(rawX);
      const int16_t pointY = static_cast<int16_t>(rawY);
      x[index] = mirrorX_ ? maxX_ - pointX : pointX;
      y[index] = mirrorY_ ? maxY_ - pointY : pointY;
    }
    return requested;
  }

 private:
  static constexpr uint8_t kDefaultAddress = 0x5d;
  static constexpr uint8_t kBackupAddress = 0x14;
  static constexpr uint8_t kPointCapacity = 5;
  static constexpr uint8_t kPointBytes = 8;
  static constexpr uint16_t kStatusRegister = 0x814e;
  static constexpr uint16_t kPointRegister = 0x814f;

  bool probe(uint8_t address) {
    if (!address) return false;
    wire_->beginTransmission(address);
    return wire_->endTransmission() == 0;
  }

  bool select(uint16_t reg) {
    wire_->beginTransmission(address_);
    wire_->write(static_cast<uint8_t>(reg >> 8));
    wire_->write(static_cast<uint8_t>(reg));
    return wire_->endTransmission(false) == 0;
  }

  bool read(uint16_t reg, uint8_t* output, uint8_t bytes) {
    if (!select(reg)
        || wire_->requestFrom(static_cast<int>(address_), static_cast<int>(bytes),
                              static_cast<int>(true)) != bytes)
      return false;
    for (uint8_t index = 0; index < bytes; ++index) output[index] = wire_->read();
    return true;
  }

  void clearStatus() {
    wire_->beginTransmission(address_);
    wire_->write(static_cast<uint8_t>(kStatusRegister >> 8));
    wire_->write(static_cast<uint8_t>(kStatusRegister));
    wire_->write(static_cast<uint8_t>(0));
    wire_->endTransmission();
  }

  TwoWire* wire_ = nullptr;
  uint8_t address_ = 0;
  int16_t maxX_ = 0;
  int16_t maxY_ = 0;
  bool mirrorX_ = false;
  bool mirrorY_ = false;
};
}  // namespace board
}  // namespace copilot
