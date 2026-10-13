#!/usr/bin/env python3
"""Validate and install an extracted, board-matched Agent Buddy firmware release."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import subprocess
import sys

ESPTOOL_VERSION = "5.3.0"
MIN_PYTHON = (3, 10)
# The marker lets pip skip esptool on older Pythons so require_python() can explain the fix.
REQUIREMENTS = f'esptool=={ESPTOOL_VERSION}; python_version >= "{MIN_PYTHON[0]}.{MIN_PYTHON[1]}"\n'
FLASH_BYTES = 0x2000000
IMAGE_NAMES = (
    "bin/bootloader.bin", "bin/partitions.bin", "bin/boot_app0.bin",
    "bin/application.bin", "bin/character-copilot.acpk",
)
PAYLOAD_NAMES = (*IMAGE_NAMES, "flash.py", "requirements.txt", "manifest.json", "INSTALL.txt")
WARNING = (
    "WARNING: This replaces the current firmware, partition table, and installed character.\n"
    "NVS bytes at 0x9000..0xe000 are preserved, but settings from an existing layout may be "
    "incompatible. No erase-flash is performed."
)
BOARD_PROFILES = {
    "waveshare-amoled-175": {
        "chip": "esp32s3",
        "flash_size": "16MB",
        "flash_bytes": 0x1000000,
        "regions": ((0, 0x8000), (0x8000, 0x1000), (0xe000, 0x2000),
                    (0x10000, 0x200000), (0x410000, 0xBE0000)),
    },
    "waveshare-p4-86": {
        "chip": "esp32p4",
        "flash_size": "32MB",
        "flash_bytes": 0x2000000,
        "regions": ((0x2000, 0x6000), (0x8000, 0x1000), (0xe000, 0x2000),
                    (0x10000, 0x300000), (0x610000, 0x9E0000)),
    },
}


def validate_identity(name, version):
    if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name, flags=re.ASCII):
        raise ValueError("Name must be a lowercase ASCII slug (letters, digits, single hyphens).")
    if not isinstance(version, str) or not re.fullmatch(
        r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version, flags=re.ASCII
    ):
        raise ValueError("Version must be stable SemVer MAJOR.MINOR.PATCH (no v prefix).")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def _integer(value, label):
    if type(value) is not int or value < 0:
        raise ValueError(f"Invalid {label}: expected a nonnegative integer.")
    return value


def validate_manifest(manifest, files):
    if not isinstance(manifest, dict):
        raise ValueError("Manifest must be an object.")
    validate_identity(manifest.get("name"), manifest.get("version"))
    if type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 1:
        raise ValueError("Unsupported manifest schema.")
    # Releases before the board layer have no board field; they are for waveshare-amoled-175.
    board = manifest.get("board", "waveshare-amoled-175")
    if not isinstance(board, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", board, flags=re.ASCII):
        raise ValueError("Invalid board ID in the manifest.")
    profile = BOARD_PROFILES.get(board)
    if not profile:
        raise ValueError(f"Unsupported board: {board}.")
    if (manifest.get("chip"), manifest.get("flash_size")) != (
            profile["chip"], profile["flash_size"]):
        raise ValueError("Manifest chip or flash size does not match its board.")
    images = manifest.get("images")
    if not isinstance(images, list) or len(images) != len(IMAGE_NAMES):
        raise ValueError("Manifest must contain exactly the five supported images.")
    end = 0
    for index, (image, filename) in enumerate(zip(images, IMAGE_NAMES)):
        if not isinstance(image, dict) or image.get("file") != filename:
            raise ValueError("Invalid image filename or order (unsafe paths are not allowed).")
        offset = _integer(image.get("offset"), "image offset")
        capacity = _integer(image.get("max_size"), "image budget")
        size = _integer(image.get("size"), "image size")
        if index < 4 and (offset, capacity) != profile["regions"][index]:
            raise ValueError(f"Unsafe offset or budget for {filename} on board {board}.")
        if index == 4 and (
                offset < profile["regions"][index][0] or offset % 0x10000 or offset < end):
            raise ValueError(f"Unsafe offset or budget for {filename} on board {board}.")
        if capacity == 0 or size == 0 or size > capacity or offset + capacity > profile["flash_bytes"]:
            raise ValueError(f"Image exceeds its flash budget: {filename}.")
        if offset < end:
            raise ValueError("Image partitions overlap.")
        end = offset + capacity
        if len(files[filename]) != size or image.get("sha256") != sha256(files[filename]):
            raise ValueError(f"Image size or SHA256 mismatch: {filename}.")
    if manifest.get("asset_sha256") != images[-1]["sha256"]:
        raise ValueError("Asset SHA256 mismatch.")
    return manifest


def _read_file(root, filename):
    path = root / filename
    candidate = path
    while candidate != root:
        if candidate.is_symlink():
            raise ValueError(f"Symlink paths are not allowed: {filename}.")
        candidate = candidate.parent
    if not path.is_file() or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Missing or unsafe bundle file: {filename}.")
    # Bound reads even if a downloaded bundle was damaged or maliciously modified.
    limit = FLASH_BYTES if filename in IMAGE_NAMES else 1024 * 1024
    if path.stat().st_size > limit:
        raise ValueError(f"Bundle file exceeds size limit: {filename}.")
    return path.read_bytes()


def verify_bundle(root):
    root = Path(root).resolve()
    files = {name: _read_file(root, name) for name in PAYLOAD_NAMES}
    sums = _read_file(root, "SHA256SUMS").decode("ascii")
    checksums = {}
    for line in sums.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        if not match or match[2] not in PAYLOAD_NAMES or match[2] in checksums:
            raise ValueError("Invalid SHA256SUMS entry (unsafe or duplicate filename).")
        checksums[match[2]] = match[1]
    if set(checksums) != set(PAYLOAD_NAMES):
        raise ValueError("SHA256SUMS must cover every bundle payload file.")
    for name, data in files.items():
        if sha256(data) != checksums[name]:
            raise ValueError(f"SHA256 mismatch: {name}.")
    if files["requirements.txt"] != REQUIREMENTS.encode():
        raise ValueError("Unsupported installer requirements.")
    return validate_manifest(json.loads(files["manifest.json"]), files)


def require_python(version_info=None):
    current = tuple((version_info or sys.version_info)[:2])
    if current >= MIN_PYTHON:
        return
    minimum = f"{MIN_PYTHON[0]}.{MIN_PYTHON[1]}"
    raise ValueError(
        f"Python {minimum} or newer is required to flash, but this is Python "
        f"{current[0]}.{current[1]} ({sys.executable}).\n"
        f"Install a newer Python from https://www.python.org/downloads/, then recreate the "
        f"environment in this folder with it and reinstall the requirements, for example:\n"
        f"  python3.13 -m venv --clear .venv          (Windows: py -3.13 -m venv --clear .venv)\n"
        f"  .venv/bin/python -m pip install -r requirements.txt"
    )


def require_dependencies():
    require_python()
    command = f'"{sys.executable}" -m pip install esptool=={ESPTOOL_VERSION}'
    try:
        version = importlib.metadata.version("esptool")
    except importlib.metadata.PackageNotFoundError:
        raise ValueError(f"esptool is missing. Install with: {command}") from None
    if version != ESPTOOL_VERSION:
        raise ValueError(f"esptool {ESPTOOL_VERSION} is required (found {version}). Run: {command}")


def flash_command(root, manifest, port):
    command = [
        sys.executable, "-m", "esptool", "--chip", manifest["chip"], "--port", port,
        "--baud", "460800", "write-flash", "--flash-mode", "keep",
        "--flash-freq", "keep", "--flash-size", manifest["flash_size"],
    ]
    for image in manifest["images"]:
        command.extend((hex(image["offset"]), str(Path(root) / image["file"])))
    return command


def main(argv=None, root=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", help="Serial port, for example COM3 or /dev/ttyACM0")
    parser.add_argument("--yes", action="store_true", help="Explicitly confirm replacement without prompting")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--verify-only", action="store_true", help="Validate offline; no dependencies or hardware needed")
    actions.add_argument("--list-ports", action="store_true", help="List serial ports without flashing")
    args = parser.parse_args(argv)
    root = Path(root) if root is not None else Path(__file__).resolve().parent
    try:
        if args.list_ports:
            require_dependencies()
            try:
                from serial.tools import list_ports
            except ImportError:
                raise ValueError(
                    f'pyserial is missing. Run: "{sys.executable}" -m pip install '
                    f'--force-reinstall esptool=={ESPTOOL_VERSION}'
                ) from None
            ports = list(list_ports.comports())
            for port in ports:
                print(f"{port.device}: {port.description}")
            if not ports:
                print("No serial ports found. Connect the device with a USB data cable.")
            return 0
        manifest = verify_bundle(root)
        print(f"Verified {manifest['name']} v{manifest['version']} and all five images.")
        print(f"Board: {manifest.get('board', 'waveshare-amoled-175')}. Flash it only to that board.")
        if args.verify_only:
            return 0
        if not args.port:
            raise ValueError("--port is required to flash. Use --list-ports to find your device.")
        require_dependencies()
        print(WARNING)
        if not args.yes and input("Type FLASH to replace the device firmware: ").strip() != "FLASH":
            raise ValueError("Flash cancelled; confirmation was not FLASH.")
        subprocess.run(flash_command(root, manifest, args.port), check=True)
        return 0
    except (OSError, ValueError, KeyError, TypeError, EOFError, KeyboardInterrupt, subprocess.CalledProcessError) as error:
        print(f"Installer error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
