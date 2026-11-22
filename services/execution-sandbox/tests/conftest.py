"""A fake `modal` package, so service.py's endpoints can be tested offline.

Only the parts service.py touches are faked. A FakeSandbox answers `exec` calls from
`FakeSandbox.responses` (argv prefix -> (exit_code, stdout, stderr)) and records every call.
"""
import os
import sys
import types
from pathlib import Path

import pytest

TOKEN = "test-sandbox-token"


class FakeStream:
    def __init__(self, data):
        self._data = data
        self.written = []

    def read(self):
        return self._data

    def write(self, data):
        self.written.append(data)

    def write_eof(self):
        pass

    def drain(self):
        pass


class FakeProcess:
    def __init__(self, code, out, err):
        self.returncode = code
        self.stdout = FakeStream(out)
        self.stderr = FakeStream(err)
        self.stdin = FakeStream(None)

    def wait(self):
        return self.returncode


class FakeSandbox:
    created = []
    responses = {}

    def __init__(self, **kwargs):
        self.object_id = f"sb-{len(FakeSandbox.created) + 1}"
        self.create_kwargs = kwargs
        self.calls = []
        self.processes = []
        self.terminated = False

    @classmethod
    def create(cls, *args, **kwargs):
        sb = cls(**kwargs)
        cls.created.append(sb)
        return sb

    @classmethod
    def from_id(cls, sandbox_id):
        for sb in cls.created:
            if sb.object_id == sandbox_id:
                return sb
        raise LookupError(sandbox_id)

    def exec(self, *argv, workdir=None, timeout=None, text=True):
        self.calls.append({"argv": argv, "workdir": workdir, "timeout": timeout, "text": text})
        code, out, err = 0, "", ""
        for prefix, result in FakeSandbox.responses.items():
            if argv[: len(prefix)] == prefix:
                code, out, err = result
                break
        if not text:
            out = out if isinstance(out, bytes) else out.encode()
            err = err if isinstance(err, bytes) else err.encode()
        proc = FakeProcess(code, out, err)
        self.processes.append(proc)
        return proc

    def terminate(self):
        self.terminated = True


class FakeImage:
    @staticmethod
    def debian_slim(*args, **kwargs):
        return FakeImage()

    def apt_install(self, *args, **kwargs):
        return self

    def pip_install(self, *args, **kwargs):
        return self


class FakeApp:
    def __init__(self, name):
        self.name = name
        self.function_kwargs = None

    def function(self, **kwargs):
        self.function_kwargs = kwargs
        return lambda f: f


def _passthrough(**kwargs):
    def decorate(f):
        f.__dict__.setdefault("modal_options", {}).update(kwargs)
        return f

    return decorate


fake_modal = types.ModuleType("modal")
fake_modal.App = FakeApp
fake_modal.Image = FakeImage
fake_modal.Sandbox = FakeSandbox
fake_modal.Secret = types.SimpleNamespace(from_name=lambda name: ("secret", name))
fake_modal.asgi_app = _passthrough
fake_modal.concurrent = _passthrough
sys.modules["modal"] = fake_modal

# service.py reads the token when it is imported.
os.environ["AGENT_SANDBOX_TOKEN"] = TOKEN
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import service  # noqa: E402


@pytest.fixture(autouse=True)
def reset_sandboxes():
    FakeSandbox.created = []
    FakeSandbox.responses = {}
    yield


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    return TestClient(service.web_app)


@pytest.fixture
def auth():
    return {"Authorization": f"Bearer {TOKEN}"}
