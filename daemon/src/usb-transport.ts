import {SerialPort, type SerialPortMock} from 'serialport';
import {
  orientationPacket, orientationProtocol, parseOrientationLine, type DeviceOrientation,
} from './orientation-settings.js';
import {
  deviceNetwork,
  parseWifiNetworkLine,
  uniqueWifiNetworks,
  type CharacterState,
  type DeviceNetwork,
  type InstallProgress,
  type WifiNetwork,
} from './protocol.js';
import {
  activePacket,
  iconPacket,
  shouldSendBadges,
  type AgentBadgeActive,
  type AgentBadgeIconDefinition,
} from './agent-badges.js';
import {shouldSendUsage, usagePacket} from './usage-tracker.js';
import {
  parseWifiProvisioningResponse,
  wifiProvisioningPacket,
  type WifiConfig,
} from './wifi-config.js';
import {
  parseUsbCapabilities,
  parseVoiceCaptureReady,
  parseVoicePcmHeader,
  parseVoicePlaybackReady,
  voicePlaybackSampleRate,
  voiceProtocol,
  type DeviceCapabilities,
  type VoiceCapture,
  type VoiceCaptureHeader,
} from './voice-audio.js';

const networkRefreshMs = 5000;
// The newest firmware protocol this daemon knows; see kDeviceProtocol in DeviceCommands.h.
const maxProtocol = 13;
// Requests in a row without an answer before the port counts as dead. A device that restarts
// can leave the old port open but silent; closing it lets discovery or Wi-Fi take over.
const deadLinkTimeouts = 3;

// serialport's SerialPortMock in tests.
export type SerialPortClass = typeof SerialPort | typeof SerialPortMock;

export interface UsbTransportOptions {
  serial?: SerialPortClass;
  requestTimeoutMs?: number;
  voiceCaptureReady?: () => void;
}

class AcknowledgementTimeout extends Error {
  constructor() {
    super('Timed out waiting for device acknowledgement.');
  }
}

interface LineWaiter {
  match: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface VoiceBinaryWaiter {
  header: VoiceCaptureHeader | null;
  chunks: Buffer[];
  remaining: number;
  resolve: (capture: VoiceCapture) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class UsbTransport {
  readonly #preferredPort = process.env.AGENT_COMPANION_PORT;
  #selectedPort: string | null = null;
  #selectedSerial: string | null = null;
  #port: SerialPort | SerialPortMock | undefined;
  #path: string | null = null;
  // True once the open port answered INFO. An open port that does not answer is not a connection.
  #answered = false;
  #desired: CharacterState = 'idle';
  #scanTimer: NodeJS.Timeout | undefined;
  #networkTimer: NodeJS.Timeout | undefined;
  #scanActive = false;
  #networkRefreshActive = false;
  #buffer = Buffer.alloc(0);
  #waiters: LineWaiter[] = [];
  #voiceBinary: VoiceBinaryWaiter | null = null;
  #commands = Promise.resolve();
  #protocol = 0;
  #iconSignature = '';
  #activeSignature = '';
  // What the device shows now; null until it is sent after a connect or restart.
  #usageSignature: string | null = null;
  #enabled = true;
  #character: string | null = null;
  #adaptivePatchRam = false;
  #firmware: string | null = null;
  #network: DeviceNetwork | null = null;
  #orientation: DeviceOrientation | null = null;
  #capabilities: DeviceCapabilities = {speaker: false, microphone: false};
  #lastVoiceCaptureId = 0;
  // The ESP32 port the last scan chose, and how many handshakes in a row it failed.
  #seen: UsbPort | null = null;
  #failures = 0;
  #timeouts = 0;
  readonly #serial: SerialPortClass;
  readonly #requestTimeoutMs: number;
  readonly #changed: () => void;
  readonly #button: (presses: number) => void;
  readonly #voiceCaptureReady: () => void;

  // `button` runs when the device's BOOT button is pressed, with the count since the device started.
  constructor(changed: () => void = () => undefined, button: (presses: number) => void = () => undefined,
              options: UsbTransportOptions = {}) {
    this.#changed = changed;
    this.#button = button;
    this.#serial = options.serial ?? SerialPort;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.#voiceCaptureReady = options.voiceCaptureReady ?? (() => undefined);
  }

  get character(): string | null {
    return this.connected ? this.#character : null;
  }

  // Firmware that reports patch_ram=adaptive keeps enough internal RAM free for Wi-Fi with any pack.
  // The first 16 hex digits of the firmware's ELF SHA-256; null before protocol 9.
  get firmware(): string | null {
    return this.connected ? this.#firmware : null;
  }

  get adaptivePatchRam(): boolean {
    return this.connected && this.#adaptivePatchRam;
  }

  get network(): DeviceNetwork | null {
    return this.connected ? this.#network : null;
  }

  get orientation(): DeviceOrientation | null {
    return this.connected ? this.#orientation : null;
  }

  get capabilities(): DeviceCapabilities {
    return this.connected ? this.#capabilities : {speaker: false, microphone: false};
  }

  get connected(): boolean {
    return this.#answered && this.#port?.isOpen === true;
  }

  get path(): string | null {
    return this.#path;
  }

  // An ESP32 port that is there but does not answer: a new board, or other firmware.
  get unanswered(): UsbPort | null {
    return !this.connected && this.#failures >= 2 ? this.#seen : null;
  }

  // The port to install firmware on: the connected device's, else the first ESP32 port found now.
  async ports(): Promise<UsbPort[]> {
    return candidatePorts(await this.#serial.list(), this.#preferredPort);
  }

  async selectPort(path: string | null, allowMissing = false): Promise<void> {
    const port = path && !allowMissing ? (await this.ports()).find(port => port.path === path) : null;
    if (path && !port && !allowMissing)
      throw new Error('The selected USB device is no longer connected. Detect the device again.');
    this.#selectedPort = path;
    this.#selectedSerial = port?.serialNumber ?? null;
    if (path && ((this.connected && this.#path !== path) || this.#scanActive)) {
      const enabled = this.#enabled;
      await this.setEnabled(false);
      if (enabled) await this.setEnabled(true);
    }
  }

  matches(port: UsbPort): boolean {
    return this.connected && (port.serialNumber
      ? port.serialNumber === this.#seen?.serialNumber : this.#path === port.path);
  }

  async findPort(selected?: string | null): Promise<UsbPort | null> {
    const ports = await this.ports();
    if (selected) {
      const port = ports.find(port => port.path === selected);
      if (!port) throw new Error('The selected USB device is no longer connected. Detect the device again.');
      return port;
    }
    if (this.connected && this.#path) return {path: this.#path, pid: this.#seen?.path === this.#path ? this.#seen.pid : null};
    if (ports.length > 1) throw new Error('Several USB devices were found. Select the device to install.');
    return ports[0] ?? null;
  }

  get state(): CharacterState {
    return this.#desired;
  }

  start(): void {
    if (!this.#enabled || this.#scanTimer) return;
    void this.#scan();
    this.#scanTimer = setInterval(() => void this.#scan(), 2000);
    this.#networkTimer = setInterval(() => this.#refreshNetwork(), networkRefreshMs);
  }

  async stop(): Promise<void> {
    if (this.#scanTimer) clearInterval(this.#scanTimer);
    if (this.#networkTimer) clearInterval(this.#networkTimer);
    this.#scanTimer = undefined;
    this.#networkTimer = undefined;
    this.#rejectWaiters(new Error('USB transport stopped.'));
    this.#rejectVoiceBinary(new Error('USB transport stopped.'));
    const port = this.#port;
    this.#port = undefined;
    this.#path = null;
    this.#answered = false;
    this.#orientation = null;
    this.#capabilities = {speaker: false, microphone: false};
    this.#buffer = Buffer.alloc(0);
    if (port?.isOpen) {
      await new Promise<void>(resolve => port.close(() => resolve()));
    }
    this.#changed();
  }

  setState(state: CharacterState): void {
    this.#desired = state;
    this.#commands = this.#commands
      .then(() => this.#sendState(state))
      .catch(error => console.error(`[usb] ${this.#message(error)}`));
  }

  setAgentBadges(icons: readonly AgentBadgeIconDefinition[], active: readonly AgentBadgeActive[]): void {
    const iconSignature = icons.map(icon => `${icon.id}:${icon.color}:${icon.mask.toString('base64')}`).join('|');
    const activeSignature = active.map(item => `${item.id}=${item.role}`).join(',');
    if (!shouldSendBadges(this.#protocol) || (iconSignature === this.#iconSignature
        && activeSignature === this.#activeSignature)) return;
    this.#commands = this.#commands
      .then(() => this.#sendAgentBadges(icons, active, iconSignature, activeSignature))
      .catch(error => console.error(`[usb] ${this.#message(error)}`));
  }

  setUsage(lines: readonly string[]): void {
    const signature = lines.join('|');
    if (!shouldSendUsage(this.#protocol) || signature === this.#usageSignature) return;
    this.#commands = this.#commands
      .then(() => this.#sendUsage(signature))
      .catch(error => console.error(`[usb] ${this.#message(error)}`));
  }

  // Disabling releases the serial port so a cable can provide power only.
  async setEnabled(enabled: boolean): Promise<void> {
    this.#enabled = enabled;
    if (enabled) {
      this.start();
      return;
    }
    await this.stop();
    // A scan that was opening the port when this stopped closes it again (see #open).
    for (let waited = 0; this.#scanActive && waited < 15_000; waited += 50)
      await new Promise(resolve => setTimeout(resolve, 50));
    this.#failures = 0;
  }

  async #scan(): Promise<void> {
    if (!this.#enabled || this.#scanActive || this.connected) return;
    this.#scanActive = true;
    const before = JSON.stringify(this.unanswered);
    try {
      const ports = await this.#serial.list();
      const candidates = candidatePorts(ports, this.#preferredPort);
      const candidate = this.#selectedPort
        ? selectedUsbCandidate(candidates, this.#selectedPort, this.#selectedSerial)
        : pickPort(ports, this.#preferredPort);
      if (candidate?.path !== this.#seen?.path) this.#failures = 0;
      this.#seen = candidate;
      if (!candidate) return;
      if (!this.#selectedSerial && this.#selectedPort === candidate.path)
        this.#selectedSerial = candidate.serialNumber ?? null;
      try {
        await this.#open(candidate.path);
        this.#failures = 0;
      } catch (error) {
        if (this.#enabled) this.#failures++;
        throw error;
      }
    } catch (error) {
      console.error(`[usb] discovery failed: ${this.#message(error)}`);
    } finally {
      this.#scanActive = false;
      if (JSON.stringify(this.unanswered) !== before) this.#changed();
    }
  }

  async #open(path: string): Promise<void> {
    const port = new this.#serial({
      path,
      baudRate: Number(process.env.AGENT_COMPANION_BAUD)
        || (/wchusbserial/i.test(path) ? 921600 : 115200),
      autoOpen: false,
      hupcl: false,
    });
    port.on('data', data => this.#onData(data as Buffer));
    port.on('error', error => console.error(`[usb] ${error.message}`));
    port.on('close', () => {
      console.log(`[usb] disconnected ${path}`);
      this.#rejectWaiters(new Error('USB device disconnected.'));
      this.#rejectVoiceBinary(new Error('USB device disconnected.'));
      if (this.#port === port) {
        const wasConnected = this.#answered;
        this.#port = undefined;
        this.#path = null;
        this.#answered = false;
        if (wasConnected) this.#changed();
      }
    });
    await new Promise<void>((resolve, reject) => {
      port.open(error => error ? reject(error) : resolve());
    });
    if (!this.#enabled) {
      await new Promise<void>(resolve => port.close(() => resolve()));
      return;
    }
    this.#port = port;
    this.#path = path;
    this.#timeouts = 0;
    try {
      const info = await this.#request('i', line => line.startsWith('INFO protocol='));
      this.#applyInfo(info);
      await this.#readOrientation();
      this.#iconSignature = '';
      this.#activeSignature = '';
      this.#usageSignature = null;
      this.#answered = true;
      console.log(`[usb] ${info}`);
      console.log(`[usb] connected ${path}`);
      this.#changed();
    } catch (error) {
      await new Promise<void>(resolve => port.close(() => resolve()));
      throw error;
    }
  }

  async #sendState(state: CharacterState): Promise<void> {
    if (!this.connected) return;
    await this.#request(`!${state}\n`, line => line === `COMMAND accepted=${state}`);
    console.log(`[state] ${state} via usb`);
  }

  async #sendAgentBadges(
      icons: readonly AgentBadgeIconDefinition[], active: readonly AgentBadgeActive[],
      iconSignature: string, activeSignature: string): Promise<void> {
    if (!this.connected || !shouldSendBadges(this.#protocol)) return;
    if (iconSignature !== this.#iconSignature) {
      for (const icon of icons)
        await this.#request(iconPacket(icon), line => line === `ICON accepted=${icon.id}`);
      this.#iconSignature = iconSignature;
      this.#activeSignature = '';
    }
    if (activeSignature !== this.#activeSignature) {
      await this.#request(activePacket(active), line => line === `AGENTS accepted=${active.length}`);
      this.#activeSignature = activeSignature;
      console.log(`[badges] ${active.length} agent badge(s) via usb`);
    }
  }

  async #sendUsage(signature: string): Promise<void> {
    if (!this.connected || !shouldSendUsage(this.#protocol) || signature === this.#usageSignature) return;
    const lines = signature ? signature.split('|') : [];
    await this.#request(usagePacket(lines), line => line === `USAGE accepted=${lines.length}`);
    this.#usageSignature = signature;
  }

  async configureWifi(ssid: string, password: string): Promise<WifiConfig> {
    const operation = this.#commands.then(async () => {
      if (!this.connected) throw new Error(this.#enabled
        ? 'Connect the Agent Companion over USB first.'
        : 'USB is turned off. Run "npm run connection auto" to use it again.');
      if (this.#protocol < 4)
        throw new Error('The connected device firmware does not support USB Wi-Fi setup.');
      const line = await this.#request(
        wifiProvisioningPacket(ssid, password),
        candidate => candidate.startsWith('WIFI configured ')
          || candidate.startsWith('WIFI_ERROR '));
      if (line.startsWith('WIFI_ERROR '))
        throw new Error(`Device rejected Wi-Fi setup: ${line.slice('WIFI_ERROR '.length)}`);
      const config = parseWifiProvisioningResponse(line);
      // The device joins the new network in the background; Wi-Fi discovery reports when it has.
      this.#network = {ssid, connected: false};
      this.#changed();
      return config;
    });
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async setOrientationOffset(offsetDegrees: number): Promise<DeviceOrientation> {
    const packet = orientationPacket(offsetDegrees);
    const operation = this.#commands.then(async () => {
      if (!this.connected) throw new Error('Connect the Agent Companion first.');
      if (this.#protocol < orientationProtocol)
        throw new Error('Update the device firmware to adjust orientation.');
      const expected = `ORIENTATION_SETTINGS offset_tenths=${Math.round(offsetDegrees * 10)}`;
      const line = await this.#request(packet,
          candidate => candidate === expected || candidate.startsWith('COMMAND_ERROR '));
      if (line.startsWith('COMMAND_ERROR ')) throw new Error(line.slice('COMMAND_ERROR '.length));
      const orientation = parseOrientationLine(line);
      this.#orientation = orientation;
      this.#changed();
      return orientation;
    });
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  captureVoice(): Promise<VoiceCapture> {
    const operation = this.#commands.then(() => this.#captureVoice());
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #captureVoice(): Promise<VoiceCapture> {
    if (!this.connected) throw new Error('Connect the Agent Companion first.');
    if (this.#protocol < voiceProtocol || !this.#capabilities.microphone)
      throw new Error('The connected device does not support microphone capture.');
    this.#rejectVoiceBinary(new Error('A newer voice capture request replaced the previous request.'));
    const binary = new Promise<VoiceCapture>((resolve, reject) => {
      const waiter: VoiceBinaryWaiter = {
        header: null,
        chunks: [],
        remaining: 0,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (this.#voiceBinary === waiter) this.#voiceBinary = null;
          reject(new Error('Timed out receiving microphone audio from the device.'));
        }, 60_000),
      };
      this.#voiceBinary = waiter;
    });
    try {
      const [line, capture] = await Promise.all([
        this.#request('v', candidate => candidate.startsWith('VOICE_PCM ')
          || candidate.startsWith('VOICE_ERROR '), 10_000),
        binary,
      ]);
      if (line.startsWith('VOICE_ERROR '))
        throw new Error(`Device microphone capture failed: ${line.slice('VOICE_ERROR '.length)}`);
      return capture;
    } catch (error) {
      this.#rejectVoiceBinary(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  playVoice(
      pcm: Buffer, sampleRate = voicePlaybackSampleRate, signal?: AbortSignal): Promise<void> {
    const operation = this.#commands.then(() => this.#playVoice(pcm, sampleRate, signal));
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #playVoice(pcm: Buffer, sampleRate: number, signal?: AbortSignal): Promise<void> {
    if (!this.connected) throw new Error('Connect the Agent Companion first.');
    if (this.#protocol < voiceProtocol || !this.#capabilities.speaker)
      throw new Error('The connected device does not support speaker playback.');
    if (sampleRate !== voicePlaybackSampleRate || pcm.length === 0 || pcm.length % 2)
      throw new Error(`Voice playback must be non-empty ${voicePlaybackSampleRate} Hz mono signed 16-bit PCM.`);
    const readyLine = await this.#request(
      `~${sampleRate}:${pcm.length}\n`,
      line => line.startsWith('VOICE_PLAY_READY ') || line.startsWith('VOICE_ERROR '), 10_000);
    if (readyLine.startsWith('VOICE_ERROR '))
      throw new Error(`Device speaker playback failed: ${readyLine.slice('VOICE_ERROR '.length)}`);
    const limits = parseVoicePlaybackReady(readyLine);
    if (!limits || limits.bytes !== pcm.length || limits.sampleRate !== sampleRate)
      throw new Error(`Device sent an invalid voice playback response: ${readyLine}`);
    let cancelled = signal?.aborted === true;
    let completion: Promise<string> | null = null;
    for (let sent = 0; sent < pcm.length; sent += limits.chunk) {
      const chunk = pcm.subarray(sent, sent + limits.chunk);
      const final = sent + chunk.length === pcm.length;
      if (final) {
        const durationMs = Math.ceil(pcm.length / 2 / sampleRate * 1000);
        completion = this.#waitFor(line => line === 'VOICE_PLAYBACK_END'
          || line.startsWith('VOICE_ERROR playback='), durationMs + 15_000);
      }
      const response = await this.#request(chunk, line => line.startsWith('VOICE_ERROR ')
        || (final ? line.startsWith('VOICE_PLAY_QUEUED ') : line.startsWith('VOICE_PLAY_ACK ')),
      15_000);
      if (response.startsWith('VOICE_ERROR '))
        throw new Error(`Device speaker playback failed: ${response.slice('VOICE_ERROR '.length)}`);
      const received = Number(/\breceived=(\d+)\b/.exec(response)?.[1]);
      if (!final && received !== sent + chunk.length)
        throw new Error(`Device acknowledged an unexpected voice byte count: ${response}`);
      if (signal?.aborted) cancelled = true;
    }
    if (!completion) throw new Error('Device did not queue voice playback.');
    const onAbort = () => {
      cancelled = true;
      void this.#write('x').catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, {once: true});
    if (cancelled) await this.#write('x');
    try {
      const ended = await completion;
      if (ended.startsWith('VOICE_ERROR playback='))
        throw new Error(`Device speaker playback failed: ${ended.slice('VOICE_ERROR '.length)}`);
      if (cancelled) throw new Error('Voice playback was canceled.');
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  cancelVoice(): Promise<void> {
    const operation = this.#commands.then(async () => {
      if (!this.connected || this.#protocol < voiceProtocol) return;
      const line = await this.#request(
        'x', candidate => candidate === 'VOICE_CANCELLED'
          || candidate.startsWith('VOICE_ERROR cancel='), 5000);
      if (line.startsWith('VOICE_ERROR cancel=') && !line.endsWith('nothing-active'))
        throw new Error(`Device could not cancel voice audio: ${line}`);
    });
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #readOrientation(): Promise<void> {
    if (this.#protocol < orientationProtocol) {
      this.#orientation = null;
      return;
    }
    const line = await this.#request('o', candidate => candidate.startsWith('ORIENTATION_SETTINGS ')
        || candidate.startsWith('COMMAND_ERROR '));
    if (line.startsWith('COMMAND_ERROR ')) throw new Error(line.slice('COMMAND_ERROR '.length));
    this.#orientation = parseOrientationLine(line);
  }

  // The device scans with its own radio, so the list holds only networks it can actually join.
  scanWifi(): Promise<WifiNetwork[]> {
    const operation = this.#commands.then(async () => {
      if (!this.connected) throw new Error('Connect the Agent Companion over USB to scan for networks.');
      if (this.#protocol < 7)
        throw new Error('Update the device firmware to scan for Wi-Fi networks.');
      const networks: WifiNetwork[] = [];
      const end = await this.#request('w', line => {
        const network = parseWifiNetworkLine(line);
        if (network) networks.push(network);
        return line.startsWith('WIFI_SCAN_END ') || line.startsWith('WIFI_SCAN_ERROR ');
      }, 20000);
      if (end.startsWith('WIFI_SCAN_ERROR '))
        throw new Error(`Device could not scan for networks: ${end.slice('WIFI_SCAN_ERROR '.length)}`);
      return uniqueWifiNetworks(networks);
    });
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #applyInfo(info: string): void {
    const protocol = Number(/^INFO protocol=(\d+)(?: |$)/.exec(info)?.[1]);
    if (!Number.isInteger(protocol) || protocol < 1 || protocol > maxProtocol) {
      throw new Error(`Unsupported device protocol: ${info}`);
    }
    this.#protocol = protocol;
    if (protocol < orientationProtocol) this.#orientation = null;
    this.#adaptivePatchRam = /\bpatch_ram=adaptive\b/.test(info);
    this.#capabilities = protocol >= voiceProtocol
      ? parseUsbCapabilities(info) : {speaker: false, microphone: false};
    this.#firmware = /\bfirmware=([0-9a-f]{16})\b/.exec(info)?.[1] ?? null;
    this.#network = deviceNetwork(/\bssid_b64=([A-Za-z0-9+/=]*)/.exec(info)?.[1],
                                  /\bwifi_connected=1\b/.test(info));
    this.#character = /\bcharacter=([a-z0-9-]+)\b/.exec(info)?.[1] ?? null;
  }

  // A restart can bring new firmware (a Wi-Fi update), so ask again what the device runs.
  #refreshInfo(): void {
    const operation = this.#commands.then(async () => {
      if (!this.connected) return;
      const info = await this.#request('i', line => line.startsWith('INFO protocol='));
      this.#applyInfo(info);
      await this.#readOrientation();
      console.log(`[usb] ${info}`);
      this.#changed();
    }).catch(error => console.error(`[usb] ${this.#message(error)}`));
    this.#commands = operation;
  }

  // A newly saved network joins in the background, so keep asking until the device reports it joined.
  #refreshNetwork(): void {
    if (!this.connected || this.#networkRefreshActive || this.#protocol < 4
        || (this.#protocol < orientationProtocol && (!this.#network || this.#network.connected))) return;
    this.#networkRefreshActive = true;
    const operation = this.#commands.then(async () => {
      if (!this.connected) return;
      const info = await this.#request('i', line => line.startsWith('INFO protocol='));
      const previousOrientation = this.#orientation?.offsetDegrees;
      const previousNetwork = this.#network;
      this.#applyInfo(info);
      await this.#readOrientation();
      const network = deviceNetwork(/\bssid_b64=([A-Za-z0-9+/=]*)/.exec(info)?.[1],
                                    /\bwifi_connected=1\b/.test(info));
      if (network?.ssid !== previousNetwork?.ssid || network?.connected !== previousNetwork?.connected
          || previousOrientation !== this.#orientation?.offsetDegrees) {
        this.#network = network;
        this.#changed();
      }
    }).catch(error => console.error(`[usb] ${this.#message(error)}`))
      .finally(() => { this.#networkRefreshActive = false; });
    this.#commands = operation;
  }

  installCharacter(pack: Buffer, progress: InstallProgress = () => undefined): Promise<string> {
    const operation = this.#commands.then(() => this.#installCharacter(pack, progress));
    this.#commands = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #installCharacter(pack: Buffer, progress: InstallProgress): Promise<string> {
    if (!this.connected) throw new Error('Connect the Agent Companion over USB first.');
    if (this.#protocol < 5)
      throw new Error('The connected device firmware does not support character installation.');
    const ready = await this.#request(
      'u', line => line.startsWith('UPLOAD_READY ') || line.startsWith('UPLOAD_ERROR '), 10000);
    const limits = parseUploadReady(ready);
    if (pack.length > limits.maxBytes)
      throw new Error(`Character pack exceeds the device's ${limits.maxBytes}-byte partition.`);
    let sent = 0;
    let retries = 0;
    while (sent < pack.length) {
      const chunk = pack.subarray(sent, sent + limits.chunk);
      const last = sent + chunk.length === pack.length;
      // The final chunk is followed by flash verification rather than an acknowledgement.
      const response = await this.#request(chunk, line => line.startsWith('UPLOAD_ERROR ')
          || line.startsWith('UPLOAD_RETRY ')
          || (last ? line.startsWith('UPLOAD_OK ') : line.startsWith('UPLOAD_ACK ')), last ? 30000 : 15000);
      if (response.startsWith('UPLOAD_ERROR '))
        throw new Error(`Device rejected the character: ${response.slice('UPLOAD_ERROR '.length)}`);
      if (response.startsWith('UPLOAD_RETRY ')) {
        // The device is discarding a stalled chunk; resend only once it reports a quiet line.
        if (Number(/\breceived=(\d+)\b/.exec(response)?.[1]) !== sent || ++retries > 8)
          throw new Error(`Character upload could not recover: ${response}`);
        await this.#waitFor(line => line === `UPLOAD_RESEND received=${sent}`, 10000);
        console.error(`[usb] resending character chunk at ${sent}`);
        continue;
      }
      sent += chunk.length;
      if (!last && Number(/\breceived=(\d+)\b/.exec(response)?.[1]) !== sent)
        throw new Error(`Device acknowledged an unexpected byte count: ${response}`);
      progress(sent, pack.length);
      if (last) {
        console.log(`[usb] ${response}`);
        const character = /\bcharacter=([a-z0-9-]+)\b/.exec(response)?.[1] ?? 'unknown';
        // The device restarts into the new character. Its boot banner confirms it, but until
        // then the INFO from before the upload would still name the old character.
        this.#character = character;
        this.#changed();
        return character;
      }
    }
    throw new Error('Character pack is empty.');
  }

  async #request(text: string | Buffer, match: (line: string) => boolean,
                 timeoutMs = this.#requestTimeoutMs): Promise<string> {
    const response = this.#waitFor(match, timeoutMs);
    try {
      // Wait for both together: the answer can time out while the write is still pending.
      const [, line] = await Promise.all([this.#write(text), response]);
      this.#timeouts = 0;
      return line;
    } catch (error) {
      this.#rejectWaiters(error instanceof Error ? error : new Error(String(error)));
      if (error instanceof AcknowledgementTimeout && ++this.#timeouts >= deadLinkTimeouts) this.#closeDeadPort();
      throw error;
    }
  }

  #closeDeadPort(): void {
    const port = this.#port;
    if (!port?.isOpen) return;
    console.error(`[usb] ${this.#path} stopped answering; closing it`);
    port.close();
  }

  async #write(text: string | Buffer): Promise<void> {
    const port = this.#port;
    if (!port?.isOpen) throw new Error('USB device is not connected.');
    await new Promise<void>((resolve, reject) => {
      // No drain: on macOS, tcdrain blocks a libuv thread for good when the device stops reading,
      // and then the process cannot exit. Every request waits for an answer, which is enough.
      port.write(text, error => error ? reject(error) : resolve());
    });
  }

  #onData(data: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, data]);
    if (!this.#voiceBinary && this.#buffer.length > 65536) {
      console.error('[usb] discarded oversized unterminated serial response');
      this.#buffer = Buffer.alloc(0);
      this.#rejectWaiters(new Error('USB device returned an oversized response.'));
      return;
    }
    while (this.#buffer.length) {
      const binary = this.#voiceBinary;
      if (binary?.header && binary.remaining > 0) {
        const length = Math.min(binary.remaining, this.#buffer.length);
        binary.chunks.push(this.#buffer.subarray(0, length));
        binary.remaining -= length;
        this.#buffer = this.#buffer.subarray(length);
        if (binary.remaining > 0) return;
        continue;
      }
      const newline = this.#buffer.indexOf(0x0A);
      if (newline < 0) return;
      const lineBytes = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      const end = lineBytes.length && lineBytes[lineBytes.length - 1] === 0x0D
        ? lineBytes.length - 1 : lineBytes.length;
      const line = lineBytes.subarray(0, end).toString('utf8').trim();
      if (line) this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    if (line.startsWith('VOICE_PLAYBACK_RESUME ')
        || line.startsWith('VOICE_CAPTURE_DONE ')
        || line.startsWith('VOICE_TOUCH '))
      console.log(`[usb] ${line}`);
    if (line.startsWith('VOICE_PCM ')) {
      const header = parseVoicePcmHeader(line);
      if (!header || !this.#voiceBinary) {
        this.#rejectVoiceBinary(new Error(`Device sent an unexpected voice capture header: ${line}`));
      } else {
        this.#voiceBinary.header = header;
        this.#voiceBinary.remaining = header.bytes;
      }
    } else if (line.startsWith('VOICE_PCM_END ')) {
      const id = Number(/^VOICE_PCM_END id=(\d+)$/.exec(line)?.[1]);
      const capture = this.#voiceBinary;
      if (!capture?.header || capture.remaining !== 0 || id !== capture.header.id) {
        this.#rejectVoiceBinary(new Error(`Device sent an invalid voice capture trailer: ${line}`));
      } else {
        this.#voiceBinary = null;
        clearTimeout(capture.timer);
        capture.resolve({
          pcm: Buffer.concat(capture.chunks, capture.header.bytes),
          sampleRate: capture.header.sampleRate,
        });
      }
    } else if (line.startsWith('VOICE_ERROR ')) {
      this.#rejectVoiceBinary(
        new Error(`Device microphone capture failed: ${line.slice('VOICE_ERROR '.length)}`));
    }

    if (line.startsWith('READY:')) this.#rebooted(line);
    const presses = parseButtonLine(line);
    if (presses !== null) this.#button(presses);
    const ready = parseVoiceCaptureReady(line);
    if (ready && ready.id !== this.#lastVoiceCaptureId) {
      this.#lastVoiceCaptureId = ready.id;
      this.#voiceCaptureReady();
    }
    const waiter = this.#waiters.find(candidate => candidate.match(line));
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
    waiter.resolve(line);
  }

  #rebooted(line: string): void {
    this.#character = /\bcharacter=([a-z0-9-]+)\b/.exec(line)?.[1] ?? null;
    this.#iconSignature = '';
    this.#activeSignature = '';
    this.#usageSignature = null;
    console.log(`[usb] device restarted character=${this.#character ?? 'unknown'}`);
    this.#changed();
    this.#refreshInfo();
  }

  #waitFor(match: (line: string) => boolean, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const waiter: LineWaiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          reject(new AcknowledgementTimeout());
        }, timeoutMs),
      };
      this.#waiters.push(waiter);
    });
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #rejectVoiceBinary(error: Error): void {
    const capture = this.#voiceBinary;
    if (!capture) return;
    this.#voiceBinary = null;
    clearTimeout(capture.timer);
    capture.reject(error);
  }

  #message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

// The device sends `BUTTON settings presses=N` without a request when its BOOT button is pressed.
export function parseButtonLine(line: string): number | null {
  const match = /^BUTTON settings presses=(\d{1,10})$/.exec(line);
  if (!match) return null;
  const presses = Number(match[1]);
  return presses > 0 && presses <= 0xFFFFFFFF ? presses : null;
}

export function parseUploadReady(line: string): {maxBytes: number; chunk: number} {
  const maxBytes = Number(/\bmax_bytes=(\d+)\b/.exec(line)?.[1]);
  const chunk = Number(/\bchunk=(\d+)\b/.exec(line)?.[1]);
  if (line.startsWith('UPLOAD_ERROR ')) throw new Error(`Device cannot install a character: ${line}`);
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || !Number.isInteger(chunk)
      || chunk < 256 || chunk > 65536)
    throw new Error(`Device sent an invalid upload response: ${line}`);
  return {maxBytes, chunk};
}

type PortInfo = Awaited<ReturnType<SerialPortClass['list']>>[number];

export interface UsbPort {
  path: string;
  // The USB product ID; 0x1001 is the ESP32-S3's own USB port.
  pid: number | null;
  serialNumber?: string;
}

export function selectedUsbCandidate(ports: readonly UsbPort[], path: string, serial: string | null): UsbPort | null {
  if (!serial) return ports.find(port => port.path === path) ?? null;
  const matches = ports.filter(port => port.serialNumber === serial);
  return matches.find(port => port.path === path) ?? (matches.length === 1 ? matches[0]! : null);
}

export function candidatePorts(ports: readonly PortInfo[], preferred?: string,
                               platform: NodeJS.Platform = process.platform): UsbPort[] {
  const candidates = ports.filter(port => port.path === preferred
    || (isLikelyEsp32Port(port.path, platform) && (platform !== 'win32' || Boolean(port.vendorId))));
  const normalized = candidates.map(port => pickPort([port], port.path, platform)!);
  return [...new Map(normalized.map(port => [port.path, port])).values()];
}

// The preferred port, else an Espressif one, else any port that looks like an ESP32 board.
export function pickPort(ports: readonly PortInfo[], preferred?: string,
                         platform: NodeJS.Platform = process.platform): UsbPort | null {
  const candidate = ports.find(port => port.path === preferred)
    ?? ports.find(port => port.vendorId?.toLowerCase() === '303a' && isLikelyEsp32Port(port.path, platform))
    // Windows lists Bluetooth links as COM ports too; only a USB port has a vendor ID.
    ?? ports.find(port => isLikelyEsp32Port(port.path, platform) && (platform !== 'win32' || Boolean(port.vendorId)));
  if (!candidate) return null;
  const pid = Number.parseInt(candidate.productId ?? '', 16);
  return {
    path: platform === 'darwin' ? candidate.path.replace(/^\/dev\/tty\./, '/dev/cu.') : candidate.path,
    pid: Number.isFinite(pid) ? pid : null,
    ...(candidate.serialNumber ? {serialNumber: candidate.serialNumber} : {}),
  };
}

export function isLikelyEsp32Port(
    path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin')
    return /^\/dev\/(?:cu|tty)\.(?:usbmodem|usbserial|wchusbserial)/i.test(path);
  if (platform === 'win32') return /^COM\d+$/i.test(path);
  return /^\/dev\/tty(?:ACM|USB)\d+$/i.test(path);
}
