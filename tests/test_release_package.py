import importlib.util
import tempfile
import unittest
from pathlib import Path


script = Path(__file__).resolve().parents[1] / "tools" / "verify-release.py"
spec = importlib.util.spec_from_file_location("verify_release", script)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleasePackageTests(unittest.TestCase):
    def setUp(self):
        self.files = {
            "Witchcraft/Witchcraft.toc": b"embeds.xml\n",
            "Witchcraft/Bindings.xml": b"<Bindings/>",
            "Witchcraft/embeds.xml": b'<Ui><Include file="Libs\\loader.xml"/></Ui>',
            "Witchcraft/Libs/loader.xml": b'<Ui><Script file="Lib.lua"/></Ui>',
            "Witchcraft/Libs/Lib.lua": b"-- test\n",
        }

    def test_nested_xml_requires_exact_case_and_implicit_bindings(self):
        release.validate_load_paths(self.files)
        missing_bindings = dict(self.files)
        del missing_bindings["Witchcraft/Bindings.xml"]
        with self.assertRaisesRegex(KeyError, "Bindings.xml"):
            release.validate_load_paths(missing_bindings)
        self.files["Witchcraft/Libs/loader.xml"] = b'<Ui><Script file="lib.lua"/></Ui>'
        with self.assertRaisesRegex(ValueError, "Witchcraft/Libs/lib.lua"):
            release.validate_load_paths(self.files)

    def test_zip_identity_ignores_input_order_and_rejects_altered_payloads(self):
        with tempfile.TemporaryDirectory() as folder:
            first = Path(folder) / "candidate.zip"
            second = Path(folder) / "asset.zip"
            release.write_candidate(first, self.files)
            release.write_candidate(second, dict(reversed(list(self.files.items()))))
            self.assertEqual(release.verify_zip(first, self.files), release.verify_zip(second, self.files))
            altered = self.files.copy()
            altered["Witchcraft/Libs/Lib.lua"] = b"-- test\r\n"
            release.write_candidate(second, altered)
            with self.assertRaisesRegex(ValueError, "differs from Git at Witchcraft/Libs/Lib.lua"):
                release.verify_zip(second, self.files)
            altered["ForeignAddon/Other.lua"] = b""
            release.write_candidate(second, altered)
            with self.assertRaisesRegex(ValueError, "file list differs"):
                release.verify_zip(second, self.files)


if __name__ == "__main__":
    unittest.main()
