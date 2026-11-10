import sys
import threading
from pathlib import Path

import pytest

dependency_dir = Path(__file__).resolve().parents[1] / '.test-deps'
if dependency_dir.exists():
    sys.path.insert(0, str(dependency_dir))


@pytest.fixture(autouse=True)
def no_request_handler_outlives_its_test():
    """A local HTTP server's request thread still running after its test can write a traceback while
    the interpreter shuts down, which aborts the whole run after every test has passed."""
    before = set(threading.enumerate())
    yield
    left = [
        thread.name
        for thread in threading.enumerate()
        if thread not in before and 'process_request_thread' in thread.name
    ]
    assert not left, f'Request handler threads still running after the test: {left}'
