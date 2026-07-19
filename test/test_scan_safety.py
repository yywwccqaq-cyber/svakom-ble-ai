import ast
import importlib.util
import pathlib
import sys
import types
import unittest


class _Placeholder:
    pass


bleak_stub = types.ModuleType("bleak")
bleak_stub.BleakClient = _Placeholder
bleak_stub.BleakScanner = _Placeholder
sys.modules.setdefault("bleak", bleak_stub)

MODULE_PATH = pathlib.Path(__file__).resolve().parents[1] / "scan.py"
SPEC = importlib.util.spec_from_file_location("svakom_scan", MODULE_PATH)
scan = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scan)


class ScanSafetyTests(unittest.TestCase):
    def test_full_service_discovery_is_not_filtered(self):
        self.assertNotIn("services", scan.client_options())

    def test_report_identifier_does_not_expose_address(self):
        address = "AA:BB:CC:DD:EE:FF"
        identifier = scan.anonymized_device_id(address)
        self.assertEqual(len(identifier), 12)
        self.assertNotIn("AA", identifier.upper())

    def test_probe_contains_no_vendor_characteristic_write_call(self):
        tree = ast.parse(MODULE_PATH.read_text(encoding="utf-8"))
        called_attributes = {
            node.func.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        self.assertNotIn("write_gatt_char", called_attributes)
        self.assertNotIn("write_gatt_descriptor", called_attributes)
        self.assertIn("read_gatt_char", called_attributes)
        self.assertIn("start_notify", called_attributes)


if __name__ == "__main__":
    unittest.main()
