import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class CanaryTest(unittest.TestCase):
    def test_real_requests_are_counted_without_logging_headers(self):
        script = Path(__file__).resolve().parents[2] / "scripts/cursor-canary.py"
        with tempfile.TemporaryDirectory(prefix="crew-canary-test-") as directory:
            out = Path(directory) / "evidence"
            child = subprocess.Popen([sys.executable, str(script), "--out", str(out)],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                for _ in range(100):
                    if (out / "ready.json").exists():
                        break
                    self.assertIsNone(child.poll())
                    time.sleep(0.025)
                ready = json.loads((out / "ready.json").read_text())
                base = f"http://127.0.0.1:{ready['port']}"
                for phase in ("positive", "negative"):
                    request = Request(base + ready["routes"][phase], headers={"X-Sentinel": "do-not-record-header"})
                    with urlopen(request, timeout=2) as response:
                        self.assertEqual(json.load(response), {"phase": phase, "value": ready["expected"][phase]})
                with urlopen(Request(base + ready["routes"]["positive"] + "?synthetic-query=not-recorded", method="HEAD"), timeout=2) as response:
                    self.assertEqual(response.read(), b"")
                with self.assertRaises(HTTPError) as unsupported:
                    urlopen(Request(base + ready["routes"]["negative"], data=b"do-not-record-body", method="POST"), timeout=2)
                self.assertEqual(unsupported.exception.code, 501)
                unsupported.exception.close()
                with self.assertRaises(HTTPError) as refused:
                    urlopen(base + "/not-a-canary", timeout=2)
                self.assertEqual(refused.exception.code, 404)
                refused.exception.close()
                self.assertEqual(json.loads((out / "counts.json").read_text()), {"positive": 2, "negative": 2})
                hits = [json.loads(line) for line in (out / "hits.jsonl").read_text().splitlines()]
                self.assertEqual([hit["method"] for hit in hits], ["GET", "GET", "HEAD", "POST"])
                for path in out.iterdir():
                    for sentinel in ("do-not-record-header", "do-not-record-body", "synthetic-query"):
                        self.assertNotIn(sentinel, path.read_text())
                self.assertEqual(out.stat().st_mode & 0o777, 0o700)
            finally:
                child.terminate()
                child.communicate(timeout=3)
            self.assertEqual(child.returncode, 0)


if __name__ == "__main__":
    unittest.main()
