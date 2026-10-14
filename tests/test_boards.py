import copy
import re
from pathlib import Path
import unittest

from tools import boards

ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "firmware/AgentCompanion"


class BoardTargetTests(unittest.TestCase):
    def setUp(self):
        self.data = boards.load()

    def test_every_board_has_sources_and_a_selector_branch(self):
        # validate() checks the board folders and both selector headers.
        boards.validate(self.data)
        self.assertIn(self.data["default"], self.data["boards"])

    def test_default_board_is_the_selector_fallback(self):
        directory = self.data["boards"][self.data["default"]]["directory"]
        for header in boards.SELECTORS:
            selector = (boards.BOARD_SOURCES / header).read_text()
            fallback = selector.split("#else", 1)[1]
            self.assertIn(f'"{directory}/{header}"', fallback, header)

    def test_board_config_defines_the_shared_contract(self):
        names = ("kId", "kName", "kDisplaySize", "kPanelWidth", "kPanelHeight",
                 "kDisplayOffsetX", "kDisplayOffsetY", "kBrightness", "kDisplayBusFrequency",
                 "kAudioMclkPin",
                 "kAudioAmplifierPin", "kAudioCodecI2cAddress", "kAudioMinimumCodecVolume",
                 "kAudioMaximumCodecVolume", "kTouchSda", "kTouchScl", "kTouchI2cAddress", "kTouchMirrorX",
                 "kTouchUsesInterrupt", "kTouchPanelWidth", "kTouchPanelHeight",
                 "kI2cFrequency", "kImuName", "kBootButtonPin")
        drivers = ("TouchController", "kTouchPointCapacity", "displayBus", "displayPanel",
                   "displayWriteBus", "accelerometer", "audioOutput")
        for board_id, entry in self.data["boards"].items():
            config = (boards.BOARD_SOURCES / entry["directory"] / "BoardConfig.h").read_text()
            for name in names:
                self.assertRegex(config, rf"\b{name}\b", f"{board_id}: {name}")
            self.assertIn(f'kId[] = "{board_id}"', config)
            includes = re.findall(r"#include\s*([<\"][^>\"]+)", config)
            self.assertLessEqual(set(includes), {"<cstdint", "<cstddef"}, "BoardConfig.h must stay free of vendor headers")
            source = (boards.BOARD_SOURCES / entry["directory"] / "BoardDrivers.h").read_text()
            for name in drivers:
                self.assertRegex(source, rf"\b{name}\b", f"{board_id}: {name}")
            if entry["chip"] == "esp32s3":
                for name in ("COPILOT_DISPLAY_QSPI_DMA", "kDisplayCsPin",
                             "kDisplayQspiWriteCommand", "kDisplayQspiPixelAddress",
                             "kImuI2cAddress"):
                    self.assertRegex(config, rf"\b{name}\b", f"{board_id}: {name}")
            if entry["chip"] == "esp32p4":
                for name in ("COPILOT_DISPLAY_FRAMEBUFFER", "kDisplayBacklightPin",
                             "kDisplayBacklightEnablePin"):
                    self.assertRegex(config, rf"\b{name}\b", f"{board_id}: {name}")

    def test_shared_firmware_has_no_board_pins_or_vendor_drivers(self):
        shared = [path for path in FIRMWARE.rglob("*") if path.suffix in (".ino", ".h", ".cpp")
                  and boards.BOARD_SOURCES not in path.parents and "generated" not in path.parts]
        for path in shared:
            text = path.read_text(errors="ignore")
            for pattern in (r"\bArduino_CO5300\b", r"\bArduino_ESP32QSPI\b", r"\bTouchDrvCST92xx\b",
                            r"TouchDrvCSTXXX\.hpp", r"\bCST92XX_SLAVE_ADDRESS\b", r"\bQMI8658_L_SLAVE_ADDRESS\b",
                            r"\bSensorQMI8658\b", r"\bes8311_\w+", r"ESP_I2S\.h", r"\bI2SClass\b"):
                self.assertNotRegex(text, pattern, path.relative_to(ROOT).as_posix())

    def test_build_keeps_the_core_defines(self):
        # The ESP32 core sets -DBOARD_HAS_PSRAM in build.defines, so the board define must not replace it.
        script = (ROOT / "tools/arduino.sh").read_text()
        self.assertNotIn("build.defines", script)
        self.assertIn('compiler.cpp.extra_flags=-D$BOARD_DEFINE', script)
        self.assertIn('compiler.c.extra_flags=-D$BOARD_DEFINE', script)

    def test_validate_rejects_inconsistent_targets(self):
        board_id = self.data["default"]
        changes = [
            lambda d: d.update(default="missing"),
            lambda d: d.update(boards={}),
            lambda d: d["boards"][board_id].update(define="WRONG"),
            lambda d: d["boards"][board_id].update(define="AGENT_BOARD_NOT_IN_SELECTOR"),
            lambda d: d["boards"][board_id].update(directory="missing_folder"),
            lambda d: d["boards"][board_id].pop("fqbn"),
            lambda d: d["boards"][board_id].pop("partitions"),
            lambda d: d["boards"][board_id].pop("flash"),
            lambda d: d["boards"][board_id].update(partitions=7),
            lambda d: d["boards"][board_id].update(flash_size=32),
            lambda d: d["boards"][board_id].update(serial_baud=0),
            lambda d: d["boards"][board_id].update(directory=["not", "a", "folder"]),
            lambda d: d["boards"][board_id]["vendor"].pop("revision"),
            lambda d: d["boards"].update({"Bad_ID": d["boards"][board_id]}),
            lambda d: d.update(arduino_core="latest"),
        ]
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                data = copy.deepcopy(self.data)
                change(data)
                with self.assertRaises(ValueError):
                    boards.validate(data)

    def test_cli_reports_fields_and_unknown_boards(self):
        self.assertEqual(boards.main(["field", "id"]), 0)
        self.assertEqual(boards.main(["field", "serial_baud"]), 0)
        self.assertEqual(boards.main(["field", "fqbn", "--board", "no-such-board"]), 1)

    def test_vendor_revision_is_pinned(self):
        for entry in self.data["boards"].values():
            self.assertRegex(entry["vendor"]["revision"], r"^[0-9a-f]{40}$")

    def test_each_board_has_a_partition_table_and_safe_flash_offsets(self):
        for board_id, entry in self.data["boards"].items():
            self.assertTrue((ROOT / entry["partitions"]).is_file(), board_id)
            offsets = [int(entry["flash"][key], 0) for key in
                       ("bootloader_offset", "partitions_offset", "boot_app0_offset")]
            self.assertEqual(offsets, sorted(offsets), board_id)
            self.assertLess(offsets[-1], 0x10000, board_id)


if __name__ == "__main__":
    unittest.main()
