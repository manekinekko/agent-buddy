#include "OrientedDisplay.h"
#include <algorithm>
#include <cstring>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <esp_memory_utils.h>

namespace copilot {
OrientedDisplay::OrientedDisplay(board::DisplayPanel* panel, Arduino_DataBus* bus)
    : Arduino_Canvas(kDisplaySize, kDisplaySize, nullptr), panel_(panel), bus_(bus) {}

bool OrientedDisplay::begin(int32_t speed) {
  error_ = nullptr;
#if COPILOT_DISPLAY_FRAMEBUFFER
  pinMode(kDisplayBacklightEnablePin, OUTPUT);
  digitalWrite(kDisplayBacklightEnablePin, LOW);
  if (!ledcAttach(kDisplayBacklightPin, kDisplayBacklightFrequency,
                  kDisplayBacklightResolution)
      || !ledcOutputInvert(kDisplayBacklightPin, true)) {
    error_ = "Display power or backlight initialization failed.";
    return false;
  }
  ledcWrite(kDisplayBacklightPin, 0);
  digitalWrite(kDisplayBacklightEnablePin, HIGH);
  const uint8_t resetAsserted = kDisplayResetActiveLow ? LOW : HIGH;
  const uint8_t resetReleased = kDisplayResetActiveLow ? HIGH : LOW;
  pinMode(kDisplayResetPin, OUTPUT);
  digitalWrite(kDisplayResetPin, resetReleased);
  delay(10);
  digitalWrite(kDisplayResetPin, resetAsserted);
  delay(10);
  digitalWrite(kDisplayResetPin, resetReleased);
  delay(120);
#endif
  if (!panel_->begin(speed)) {
    error_ = "Display panel initialization failed.";
    return false;
  }
  if (!_framebuffer) {
    _framebuffer = static_cast<uint16_t*>(heap_caps_aligned_alloc(
        16, kDisplaySize * kDisplaySize * sizeof(uint16_t),
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  }
  if (!_framebuffer) error_ = "Orientation canvas allocation failed.";
#if COPILOT_DISPLAY_QSPI_DMA
  if (!error_ && !dma_.begin(speed)) error_ = dma_.error();
#elif COPILOT_DISPLAY_FRAMEBUFFER
  if (!error_) {
    panel_->fillScreen(0);
    panel_->flush(true);
  }
#endif
  return error_ == nullptr;
}

void OrientedDisplay::setBrightness(uint8_t brightness) {
#if COPILOT_DISPLAY_QSPI_DMA
  panel_->setBrightness(brightness);
#else
  const uint32_t maximum = (1u << kDisplayBacklightResolution) - 1;
  ledcWrite(kDisplayBacklightPin, (brightness * maximum + 127) / 255);
  digitalWrite(kDisplayBacklightEnablePin, brightness ? HIGH : LOW);
#endif
}

bool OrientedDisplay::setTransferBuffer(uint8_t* buffer, size_t bytes) {
  error_ = nullptr;
  if (!buffer || reinterpret_cast<uintptr_t>(buffer) % alignof(uint32_t)
      || bytes < 2 * kDisplaySize * sizeof(uint16_t)
      || bytes % (2 * alignof(uint32_t))) {
    error_ = "Invalid display transfer buffer.";
    return false;
  }
#if COPILOT_DISPLAY_QSPI_DMA
  if (!esp_ptr_dma_capable(buffer)) {
    error_ = "Display transfer buffer is not DMA-capable.";
    return false;
  }
#endif
  transferBuffer_ = buffer;
  transferBytes_ = bytes;
#if COPILOT_DISPLAY_QSPI_DMA
  dma_.setBuffer(buffer, bytes);
#endif
  return true;
}

bool OrientedDisplay::setAngle(float radians) {
  if (!orientation_.update(radians)) return false;
  frameMarginsDirty_ = true;
  return true;
}

bool OrientedDisplay::setTrim(float radians) {
  if (!std::isfinite(radians) || radians == trim_) return false;
  trim_ = radians;
  frameMarginsDirty_ = true;
  return true;
}

void OrientedDisplay::flush(bool forceFlush) {
  (void)forceFlush;
  frameMarginsDirty_ = true;
  flushSource({_framebuffer, 0, 0, kDisplaySize, kDisplaySize, Rgb565Order::Native});
}

bool OrientedDisplay::flushFrame(
    const uint16_t* pixels, int x, int y, int width, int height) {
  return flushSource({pixels, x, y, width, height, Rgb565Order::Display});
}

bool OrientedDisplay::flushSource(const ScreenPixels& source) {
  error_ = nullptr;
  composeUs_ = writeUs_ = 0;
  if (!transferBuffer_ || !source.pixels || source.x < 0 || source.y < 0
      || source.width <= 0 || source.height <= 0
      || source.x >= kDisplaySize || source.y >= kDisplaySize
      || source.width > kDisplaySize - source.x || source.height > kDisplaySize - source.y) {
    error_ = "Invalid display source or uninitialized transfer buffer.";
    return false;
  }

  // Upright character frames keep the original direct, DMA-staged transfer.
  if (angle() == 0.0f && source.order == Rgb565Order::Display) {
    if (frameMarginsDirty_) {
      panel_->fillRect(kDisplayOffsetX, kDisplayOffsetY, kDisplaySize, source.y, 0);
      panel_->fillRect(kDisplayOffsetX, kDisplayOffsetY + source.y + source.height, kDisplaySize,
                       kDisplaySize - source.y - source.height, 0);
      panel_->fillRect(kDisplayOffsetX, kDisplayOffsetY + source.y, source.x, source.height, 0);
      panel_->fillRect(kDisplayOffsetX + source.x + source.width, kDisplayOffsetY + source.y,
                       kDisplaySize - source.x - source.width, source.height, 0);
      frameMarginsDirty_ = false;
    }
#if COPILOT_DISPLAY_QSPI_DMA
    panel_->startWrite();
    panel_->writeAddrWindow(kDisplayOffsetX + source.x, kDisplayOffsetY + source.y,
                            source.width, source.height);
    const auto* bytes = reinterpret_cast<const uint8_t*>(source.pixels);
    const size_t count = static_cast<size_t>(source.width) * source.height * sizeof(uint16_t);
    const int64_t started = esp_timer_get_time();
    for (size_t offset = 0; offset < count; offset += transferBytes_) {
      const size_t batch = std::min(transferBytes_, count - offset);
      std::memcpy(transferBuffer_, bytes + offset, batch);
      bus_->writeBytes(transferBuffer_, batch);
    }
    panel_->endWrite();
    writeUs_ = esp_timer_get_time() - started;
#elif COPILOT_DISPLAY_FRAMEBUFFER
    const int64_t started = esp_timer_get_time();
    panel_->draw16bitBeRGBBitmap(
        kDisplayOffsetX + source.x, kDisplayOffsetY + source.y,
        const_cast<uint16_t*>(source.pixels), source.width, source.height);
    panel_->flush(true);
    writeUs_ = esp_timer_get_time() - started;
#endif
    return true;
  }

  const ScreenTransform transform(kDisplaySize, angle());
#if COPILOT_DISPLAY_QSPI_DMA
  const size_t capacity = dma_.bufferBytes() / sizeof(uint16_t);
#else
  const size_t capacity = transferBytes_ / sizeof(uint16_t);
#endif
  const int rowsPerBatch = static_cast<int>(std::min(
      capacity / kDisplaySize, static_cast<size_t>(kDisplaySize)));
#if COPILOT_DISPLAY_QSPI_DMA
  panel_->startWrite();
  panel_->writeAddrWindow(kDisplayOffsetX, kDisplayOffsetY, kDisplaySize, kDisplaySize);
  panel_->endWrite();
  if (!dma_.start()) {
    error_ = dma_.error();
    return false;
  }
#endif
  for (int y = 0; y < kDisplaySize; y += rowsPerBatch) {
    const int rows = std::min(rowsPerBatch, kDisplaySize - y);
#if COPILOT_DISPLAY_QSPI_DMA
    const int64_t waiting = esp_timer_get_time();
    auto* output = reinterpret_cast<uint16_t*>(dma_.acquire());
    writeUs_ += esp_timer_get_time() - waiting;
    if (!output) break;
#else
    auto* output = reinterpret_cast<uint16_t*>(transferBuffer_);
#endif
    const int64_t started = esp_timer_get_time();
    if (!transform.renderRows(source, y, rows, output, capacity)) {
      error_ = "Display scanout failed.";
      break;
    }
    const int64_t composed = esp_timer_get_time();
    composeUs_ += composed - started;
#if COPILOT_DISPLAY_QSPI_DMA
    if (!dma_.submit(rows * kDisplaySize * sizeof(uint16_t))) break;
#else
    panel_->draw16bitBeRGBBitmap(
        kDisplayOffsetX, kDisplayOffsetY + y, output, kDisplaySize, rows);
#endif
    writeUs_ += esp_timer_get_time() - composed;
  }
#if COPILOT_DISPLAY_QSPI_DMA
  const int64_t waiting = esp_timer_get_time();
  const bool completed = dma_.finish();
  writeUs_ += esp_timer_get_time() - waiting;
  if (!completed && !error_) error_ = dma_.error();
#else
  if (!error_) {
    const int64_t waiting = esp_timer_get_time();
    panel_->flush(true);
    writeUs_ += esp_timer_get_time() - waiting;
  }
#endif
  return error_ == nullptr;
}
}
