"""Credential and failed-allocation contracts; no Docker or provider inference."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/qualify-cursor-service.py"
IMAGE = "sha256:" + "a" * 64
TOOLS = "sha256:" + "b" * 64


class LauncherTest(unittest.TestCase):
    def test_help_needs_no_credential_or_docker(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True, env={"PATH": "/nonexistent"})
        self.assertEqual(result.returncode, 0)
        self.assertIn("--key-stdin", result.stdout)

    def failed_setup(self, interrupt=False, readiness=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docker = root / "docker"
            docker.write_text(f"""#!{sys.executable}
import json,os,sys,time
from pathlib import Path
root=Path({str(root)!r})
with (root/'calls').open('a') as log:log.write(json.dumps({{'args':sys.argv[1:],'env':dict(os.environ)}})+'\\n')
if sys.argv[1:3]==['image','inspect']:
 print(json.dumps([{{'Id':sys.argv[3],'Architecture':'arm64','Os':'linux'}}]))
 (root/'proof.mts').write_text('changed after snapshot')
elif sys.argv[1:3]==['start','-a']:
 if '-source-' in sys.argv[-1]:print(json.dumps({{'fixture-source':'matched'}}))
 elif sys.argv[-1].endswith('-namespace'):
  print('unshare: unshare failed: Operation not permitted',file=sys.stderr)
  sys.exit(1)
elif sys.argv[1:3]==['network','create']:
 if not {readiness!r}:
  (root/'allocating').touch()
  if {interrupt!r}:time.sleep(30)
  sys.exit(1)
elif 'pg_isready' in sys.argv:
 (root/'allocating').touch()
 time.sleep(30)
""")
            docker.chmod(0o755)
            proof = root / "proof.mts"
            proof.write_text("throw new Error('must not execute');\n")
            original = proof.read_bytes()
            env = {**os.environ, "PATH": str(root), "PARENT_API_KEY": "parent-secret", "HTTP_PROXY": "https://proxy-secret.invalid"}
            command = [sys.executable, str(SCRIPT), "--image", IMAGE, "--tools-image", TOOLS, "--proof", str(proof),
                       "--out", str(root / "evidence"), "--negative-url", "https://canary.invalid/negative", "--key-stdin"]
            if interrupt:
                child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
                child.stdin.write(b'{"apiKey":"synthetic-sdk-secret"}')
                child.stdin.close()
                try:
                    deadline = time.monotonic() + 5
                    while not (root / "allocating").exists() and time.monotonic() < deadline:
                        time.sleep(0.01)
                    self.assertTrue((root / "allocating").exists())
                    child.terminate()
                    child.wait(timeout=5)
                    stdout, stderr = child.stdout.read(), child.stderr.read()
                finally:
                    if child.poll() is None:
                        child.kill()
                    child.wait(timeout=5)
                    child.stdout.close()
                    child.stderr.close()
                code = child.returncode
            else:
                result = subprocess.run(command, input=b'{"apiKey":"synthetic-sdk-secret"}', capture_output=True, env=env, timeout=10)
                code, stdout, stderr = result.returncode, result.stdout, result.stderr
            self.assertEqual(code, 1)
            self.assertEqual(stdout + stderr, b"")
            report = json.loads((root / "evidence/evidence.json").read_text())
            self.assertFalse(report["passed"])
            self.assertFalse(report["supported"])
            self.assertTrue(all(row["removed"] for row in report["cleanup"]))
            self.assertEqual((root / "evidence").stat().st_mode & 0o777, 0o700)
            calls = [json.loads(line) for line in (root / "calls").read_text().splitlines()]
            for call in calls:
                self.assertNotIn("PARENT_API_KEY", call["env"])
                self.assertNotIn("HTTP_PROXY", call["env"])
                self.assertNotIn("BIRBCREW_CURSOR_API_KEY", call["env"])
                if call["args"][0] in ("create", "run"):
                    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "FTP_PROXY",
                                 "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ftp_proxy"):
                        self.assertIn(name + "=", call["args"])
                if call["args"][0] == "cp":
                    self.assertEqual(Path(call["args"][1]).read_bytes(), original)
            self.assertEqual((root / "evidence/proof.mts").read_bytes(), original)
            self.assertEqual(report["proofSha256"], hashlib.sha256(original).hexdigest())
            if readiness:
                self.assertTrue(any(c["args"][0] == "cp" for c in calls))
                self.assertFalse(any("--name" in c["args"] and c["args"][c["args"].index("--name") + 1].endswith("-worker") for c in calls))
            retained = "".join(p.read_text() for p in (root / "evidence").iterdir())
            self.assertNotIn("synthetic-sdk-secret", retained)
            self.assertEqual(report["error"], "qualification_interrupted" if interrupt else "docker_operation_failed:network")

    def test_failed_allocation_cleans_up_without_credentials(self):
        self.failed_setup()

    def test_termination_cleans_up_without_credentials(self):
        self.failed_setup(interrupt=True)

    def test_readiness_interruption_cannot_continue_to_inference(self):
        self.failed_setup(interrupt=True, readiness=True)


if __name__ == "__main__":
    unittest.main()
