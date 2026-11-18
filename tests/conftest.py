import os
import sys

import pytest

_recording = None


def _record_open(event, arguments):
    # Read the global once: the fixture may clear it while another thread is opening a file.
    recording = _recording
    if recording is not None and event == "open" and arguments:
        try:
            recording.append(os.path.realpath(os.fsdecode(arguments[0])))
        except TypeError:
            pass


# An audit hook cannot be removed, so it is installed once and records only inside the fixture.
sys.addaudithook(_record_open)


@pytest.fixture
def opened_files():
    """Paths Python code opens while the fixture is active, from the "open" audit events.

    A test can state which files under its own temporary directory a code path read, and that
    it read no other there. Files that C libraries open themselves raise no event, and a path
    given relative to a directory descriptor is recorded against the working directory.
    """
    global _recording
    _recording = []
    try:
        yield _recording
    finally:
        _recording = None
