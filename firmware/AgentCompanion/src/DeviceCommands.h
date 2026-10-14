#pragma once
#include <cstdint>
#include <cstring>

namespace copilot {
enum class DeviceCommand {
  None, Invalid, Capture, Heap, Info, UploadCharacter, ConfigureWifi, ScanWifi,
  DefineAgentIcon, SetAgentBadges, SetUsage, GetOrientation, ConfigureOrientation,
  ReadVoiceCapture, UploadVoice, CancelVoice,
  Idle, Surprise, Working, Complete, Attention
};
constexpr unsigned kDeviceProtocol = 13;

struct VoicePlaybackPacket {
  unsigned sampleRate = 0;
  uint32_t bytes = 0;
};

inline bool parseVoicePlaybackPacket(const char* text, VoicePlaybackPacket& packet) {
  if (!text || !*text) return false;
  uint64_t values[2] = {};
  unsigned part = 0;
  unsigned digits = 0;
  for (const char* cursor = text;; ++cursor) {
    const char byte = *cursor;
    if (byte >= '0' && byte <= '9') {
      values[part] = values[part] * 10 + static_cast<unsigned>(byte - '0');
      if (values[part] > UINT32_MAX) return false;
      ++digits;
      continue;
    }
    if (byte == ':' && part == 0 && digits) {
      part = 1;
      digits = 0;
      continue;
    }
    if (byte == '\0' && part == 1 && digits) break;
    return false;
  }
  if (values[0] == 0 || values[1] == 0) return false;
  packet = {static_cast<unsigned>(values[0]), static_cast<uint32_t>(values[1])};
  return true;
}

inline const char* commandName(DeviceCommand command) {
  switch (command) {
    case DeviceCommand::Idle: return "idle";
    case DeviceCommand::Surprise: return "surprise";
    case DeviceCommand::Working: return "working";
    case DeviceCommand::Complete: return "complete";
    case DeviceCommand::Attention: return "attention";
    default: return "invalid";
  }
}

constexpr DeviceCommand kModeCommands[] = {
  DeviceCommand::Idle, DeviceCommand::Surprise, DeviceCommand::Working,
  DeviceCommand::Complete, DeviceCommand::Attention,
};

// The mode command with this name, or DeviceCommand::Invalid.
inline DeviceCommand modeCommand(const char* name) {
  for (DeviceCommand command : kModeCommands)
    if (std::strcmp(name, commandName(command)) == 0) return command;
  return DeviceCommand::Invalid;
}

// The serial prefix of a badge packet ('%' icon, '&' agents, '$' usage), or '\0'.
inline char badgePrefix(DeviceCommand command) {
  switch (command) {
    case DeviceCommand::DefineAgentIcon: return '%';
    case DeviceCommand::SetAgentBadges: return '&';
    case DeviceCommand::SetUsage: return '$';
    default: return '\0';
  }
}

class DeviceCommands {
 public:
  DeviceCommand feed(char byte, uint64_t milliseconds) {
    if (!receiving_) {
      for (const PacketStart& start : kPacketStarts) {
        if (byte != start.prefix) continue;
        receiving_ = true;
        packet_ = start.packet;
        length_ = 0;
        invalid_ = false;
        previous_ = milliseconds;
        return DeviceCommand::None;
      }
      for (const ByteCommand& entry : kByteCommands)
        if (byte == entry.byte) return entry.command;
      return byte == '\r' || byte == '\n' ? DeviceCommand::None : DeviceCommand::Invalid;
    }
    previous_ = milliseconds;
    if (byte == '\n') {
      receiving_ = false;
      if (invalid_) return DeviceCommand::Invalid;
      text_[length_] = '\0';
      for (const PacketStart& start : kPacketStarts)
        if (start.packet == packet_ && start.packet != Packet::Mode) return start.command;
      return modeCommand(text_);
    }
    if (byte == '\r') return DeviceCommand::None;
    const bool alphaNum = (byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z')
        || (byte >= '0' && byte <= '9');
    bool allowed = byte >= 'a' && byte <= 'z';
    if (packet_ == Packet::Wifi || packet_ == Packet::Icon)
      allowed = alphaNum || byte == '+' || byte == '/' || byte == '=' || byte == ':' || byte == '-';
    else if (packet_ == Packet::Agents)
      allowed = (byte >= 'a' && byte <= 'z') || (byte >= '0' && byte <= '9')
          || byte == '-' || byte == '=' || byte == ',';
    else if (packet_ == Packet::Usage)
      allowed = alphaNum || byte == ' ' || byte == ',' || byte == '.' || byte == ':' || byte == '|';
    else if (packet_ == Packet::Orientation)
      allowed = (byte >= '0' && byte <= '9') || byte == '-';
    else if (packet_ == Packet::Voice)
      allowed = (byte >= '0' && byte <= '9') || byte == ':';
    if (invalid_ || length_ == sizeof(text_) - 1 || !allowed) invalid_ = true;
    else text_[length_++] = byte;
    return DeviceCommand::None;
  }

  DeviceCommand expire(uint64_t milliseconds) {
    if (!receiving_ || milliseconds - previous_ < 1000) return DeviceCommand::None;
    receiving_ = false;
    return DeviceCommand::Invalid;
  }

  const char* payload() const { return text_; }

 private:
  enum class Packet : uint8_t { Mode, Wifi, Icon, Agents, Usage, Orientation, Voice };
  // A packet starts with its prefix and ends at '\n'; a mode packet ends with a mode name.
  struct PacketStart {
    char prefix;
    Packet packet;
    DeviceCommand command;
  };
  static constexpr PacketStart kPacketStarts[] = {
    {'!', Packet::Mode, DeviceCommand::Invalid},
    {'@', Packet::Wifi, DeviceCommand::ConfigureWifi},
    {'%', Packet::Icon, DeviceCommand::DefineAgentIcon},
    {'&', Packet::Agents, DeviceCommand::SetAgentBadges},
    {'$', Packet::Usage, DeviceCommand::SetUsage},
    {'^', Packet::Orientation, DeviceCommand::ConfigureOrientation},
    {'~', Packet::Voice, DeviceCommand::UploadVoice},
  };
  struct ByteCommand {
    char byte;
    DeviceCommand command;
  };
  static constexpr ByteCommand kByteCommands[] = {
    {'o', DeviceCommand::GetOrientation}, {'s', DeviceCommand::Capture},
    {'h', DeviceCommand::Heap}, {'i', DeviceCommand::Info},
    {'u', DeviceCommand::UploadCharacter}, {'w', DeviceCommand::ScanWifi},
    {'v', DeviceCommand::ReadVoiceCapture}, {'x', DeviceCommand::CancelVoice},
  };
  char text_[192] = {};
  unsigned length_ = 0;
  uint64_t previous_ = 0;
  bool receiving_ = false, invalid_ = false;
  Packet packet_ = Packet::Mode;
};
}
