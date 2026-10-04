"""Run with the bundled Python; never reads existing user data."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
TEMP = tempfile.TemporaryDirectory(prefix="peropix-smoke-")
os.environ["PEROPIX_DATA_DIR"] = TEMP.name
os.environ["PEROPIX_RESOURCE_DIR"] = str(ROOT)
sys.path.insert(0, str(ROOT / "backend"))

import files
import recordsdb
import server
from fastapi.testclient import TestClient
from PIL import Image


class MacSmoke(unittest.TestCase):
    def test_folder_picker_success_cancel_error(self):
        with patch.object(files.sys, "platform", "darwin"):
            with patch.object(files.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stdout=TEMP.name + "\n", stderr=""
            )) as run:
                self.assertEqual(files.pick_dir(TEMP.name), TEMP.name)
                self.assertEqual(run.call_args.args[0][0], "/usr/bin/osascript")
                self.assertEqual(run.call_args.args[0][-1], TEMP.name)
            with patch.object(files.subprocess, "run", return_value=SimpleNamespace(
                returncode=0, stdout="", stderr=""
            )):
                self.assertIsNone(files.pick_dir())
            with patch.object(files.subprocess, "run", return_value=SimpleNamespace(
                returncode=1, stdout="", stderr="dialog failed"
            )):
                with self.assertRaises(OSError):
                    files.pick_dir()

    def test_health_plugin_assets_and_conversion(self):
        src = Path(TEMP.name) / "source.png"
        Image.new("RGB", (16, 12), "red").save(src)
        with TestClient(server.app) as client:
            health = client.get("/api/health")
            self.assertEqual(health.status_code, 200)
            self.assertTrue(health.json()["ok"])
            self.assertEqual(server.APP_DIR, Path(TEMP.name).resolve())
            for path in ("/plug/_app/peropix.js", "/plug/_app/base.css", "/api/plugins"):
                self.assertEqual(client.get(path).status_code, 200, path)
            response = client.post("/api/tools/convert", json={
                "items": [{"path": str(src)}], "fmt": "webp", "mode": "sub"
            })
            self.assertEqual(response.status_code, 200, response.text)
            converted = list(Path(TEMP.name).rglob("*.webp"))
            self.assertTrue(converted, response.text)
            with Image.open(converted[0]) as image:
                self.assertEqual(image.size, (16, 12))
            self.assertTrue(src.exists())

    def test_records_database_roundtrip(self):
        directory = Path(TEMP.name) / "records"
        directory.mkdir(exist_ok=True)
        record = {"prompt": "test", "large": "x" * 10000}
        with recordsdb.connect(directory) as connection:
            recordsdb.put(connection, "sample.png", record)
        self.assertEqual(recordsdb.get(directory, "sample.png"), record)


if __name__ == "__main__":
    unittest.main()
