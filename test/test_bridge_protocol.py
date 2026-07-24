import asyncio
import importlib.util
import pathlib
import sys
import types
import unittest


class _Placeholder:
    pass


requests_stub = types.ModuleType("requests")
requests_stub.get = lambda *_args, **_kwargs: None
bleak_stub = types.ModuleType("bleak")
bleak_stub.BleakClient = _Placeholder
bleak_stub.BleakScanner = _Placeholder
sys.modules.setdefault("requests", requests_stub)
sys.modules.setdefault("bleak", bleak_stub)

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "bridge.py"
SPEC = importlib.util.spec_from_file_location("svakom_bridge", MODULE_PATH)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


class ProtocolTests(unittest.TestCase):
    def test_profile_detection(self):
        self.assertEqual(bridge.detect_profile("SL278K"), bridge.PROFILE_SL278K)
        self.assertEqual(bridge.detect_profile("SL278H"), bridge.PROFILE_SL278H)

    def test_sl278k_speed_maps_to_scale_strength(self):
        low = bridge.action_frames({"speed": 0.1}, bridge.PROFILE_SL278K)
        high = bridge.action_frames({"speed": 1.0}, bridge.PROFILE_SL278K)
        self.assertEqual(low, (bytes.fromhex("55 04 00 00 01 19 aa"),))
        self.assertEqual(high, (bytes.fromhex("55 04 00 00 01 ff aa"),))

    def test_sl278h_speed_mapping_is_preserved(self):
        frames = bridge.action_frames({"speed": 0.5}, bridge.PROFILE_SL278H)
        self.assertEqual(frames, (bytes.fromhex("55 04 00 00 01 7f aa"),))

    def test_sl278k_pattern_uses_ten_step_strength(self):
        frames = bridge.action_frames(
            {"pattern": 8, "level": 0.6}, bridge.PROFILE_SL278K
        )
        self.assertEqual(frames, (bytes.fromhex("55 03 00 00 08 06 00"),))

    def test_sl278k_stretch_uses_opcode_08_and_seven_modes(self):
        frames = bridge.action_frames(
            {"action": "stretch", "mode": 7, "level": 0.2},
            bridge.PROFILE_SL278K,
        )
        self.assertEqual(frames, (bytes.fromhex("55 08 00 00 07 02 00"),))

    def test_sl278k_suction_uses_opcode_09_and_five_modes(self):
        frames = bridge.action_frames(
            {"action": "suction", "mode": 5, "level": 0.3},
            bridge.PROFILE_SL278K,
        )
        self.assertEqual(frames, (bytes.fromhex("55 09 00 00 05 03 00"),))

    def test_non_k_profile_rejects_stretch_and_suction(self):
        self.assertEqual(
            bridge.action_frames(
                {"action": "stretch", "mode": 1, "level": 0.1},
                bridge.PROFILE_SL278H,
            ),
            (),
        )
        self.assertEqual(
            bridge.action_frames(
                {"action": "suction", "mode": 1, "level": 0.1},
                bridge.PROFILE_SL278H,
            ),
            (),
        )

    def test_profile_capabilities_are_bounded(self):
        self.assertEqual(
            bridge.profile_capabilities(bridge.PROFILE_SL278K),
            ("vibration", "stretch", "suction"),
        )
        self.assertEqual(
            bridge.profile_capabilities(bridge.PROFILE_SL278H),
            ("vibration",),
        )

    def test_sl278k_stop_covers_all_known_actuators(self):
        self.assertEqual(
            bridge.stop_frames(bridge.PROFILE_SL278K),
            (
                bytes.fromhex("55 04 00 00 00 00 aa"),
                bytes.fromhex("55 03 00 00 00 00 00"),
                bytes.fromhex("55 08 00 00 00 00 00"),
                bytes.fromhex("55 09 00 00 00 00 00"),
            ),
        )

    def test_init_sequence_matches_sl278k_app_sequence(self):
        self.assertEqual(
            bridge.SL278K_INIT_FRAMES,
            (
                bytes.fromhex("55 04 00 00 01 ff aa"),
                bytes.fromhex("55 04 00 00 00 00 aa"),
                bytes.fromhex("55 04 00 00 00 00 aa"),
                bytes.fromhex("55 03 00 00 00 00 00"),
            ),
        )


if __name__ == "__main__":
    unittest.main()
