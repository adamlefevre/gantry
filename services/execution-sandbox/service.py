import os
import re

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
import modal

app = modal.App("agent-sandbox-service")

sandbox_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "pytest>=8.0.0",
        "ruff>=0.4.0",
    )
)

# The target repo is checked out here, and every command runs from here.
WORKDIR = "/workspace"

# Only public HTTPS URLs for now. Private repos get a read-only GitHub App token later (ADR 0001).
REPO_URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+/[A-Za-z0-9._/-]+$")
# A branch, tag, or commit SHA. Must not start with "-", so git can't read it as an option.
REF_RE = re.compile(r"^[A-Za-z0-9._/][A-Za-z0-9._/-]*$")

web_app = FastAPI()
# Injected at runtime from the Modal secret "agent-sandbox-secret". No default:
# if it is missing, every request is rejected.
AUTH_TOKEN = os.environ.get("AGENT_SANDBOX_TOKEN")


class CreateSessionRequest(BaseModel):
    repo_url: str | None = None
    ref: str = "HEAD"


# Whole-sandbox lifetime. Setup (.gantry.yml) plus the agent loop and test runs must fit in it.
SANDBOX_TIMEOUT_SECONDS = 1800
# /file/read returns at most this much, so a huge file (or a symlink to /dev/zero) can't exhaust memory.
MAX_READ_BYTES = 1024 * 1024


class ExecRequest(BaseModel):
    command: str
    # Setup and test commands from .gantry.yml ask for longer timeouts than agent commands.
    timeout_seconds: int = Field(default=60, ge=1, le=900)
    sandbox_id: str | None = None


class SandboxRef(BaseModel):
    sandbox_id: str | None = None


class FileReadRequest(BaseModel):
    path: str
    sandbox_id: str | None = None


class FileWriteRequest(BaseModel):
    path: str
    content: str
    sandbox_id: str | None = None


def verify_auth(authorization: str | None):
    if not AUTH_TOKEN or not authorization or authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def get_sandbox(sandbox_id: str | None) -> modal.Sandbox:
    if not sandbox_id:
        raise HTTPException(status_code=400, detail="sandbox_id required")
    return modal.Sandbox.from_id(sandbox_id)


def run(sb: modal.Sandbox, *args: str, workdir: str | None = WORKDIR, timeout: int | None = None):
    """Run argv directly (no shell). Returns (exit_code, stdout, stderr)."""
    proc = sb.exec(*args, workdir=workdir, timeout=timeout)
    proc.wait()
    return proc.returncode, proc.stdout.read(), proc.stderr.read()


def checkout(sb: modal.Sandbox, repo_url: str, ref: str) -> str:
    """Shallow-fetch a single ref (branch, tag, or SHA) into WORKDIR. Returns the commit SHA."""
    steps = [
        ("git", "init", "-q", WORKDIR),
        ("git", "-C", WORKDIR, "remote", "add", "origin", repo_url),
        ("git", "-C", WORKDIR, "fetch", "-q", "--depth", "1", "origin", ref),
        ("git", "-C", WORKDIR, "checkout", "-q", "FETCH_HEAD"),
    ]
    for argv in steps:
        code, _, err = run(sb, *argv, workdir=None, timeout=300)
        if code != 0:
            raise RuntimeError(f"{' '.join(argv[:4])} failed: {err.strip()}")
    _, sha, _ = run(sb, "git", "rev-parse", "HEAD")
    return sha.strip()


# Endpoints are plain `def`: Modal's client calls block, so FastAPI runs them in its threadpool.

@web_app.post("/session/create")
def create_session(req: CreateSessionRequest | None = None, authorization: str = Header(None)):
    verify_auth(authorization)
    req = req or CreateSessionRequest()
    if req.repo_url is not None and not REPO_URL_RE.match(req.repo_url):
        raise HTTPException(status_code=422, detail="repo_url must be a public https:// git URL")
    if not REF_RE.match(req.ref):
        raise HTTPException(status_code=422, detail="invalid ref")

    sb = modal.Sandbox.create(image=sandbox_image, app=app, timeout=SANDBOX_TIMEOUT_SECONDS)
    try:
        run(sb, "mkdir", "-p", WORKDIR, workdir=None)
        commit = checkout(sb, req.repo_url, req.ref) if req.repo_url else None
    except Exception as e:
        sb.terminate()
        raise HTTPException(status_code=422, detail=f"Checkout failed: {e}")

    return {"sandbox_id": sb.object_id, "repo_url": req.repo_url, "ref": req.ref, "commit": commit}


@web_app.post("/exec")
def execute_command(req: ExecRequest, authorization: str = Header(None)):
    verify_auth(authorization)
    sb = get_sandbox(req.sandbox_id)
    code, out, err = run(sb, "bash", "-c", req.command, timeout=req.timeout_seconds)
    return {"sandbox_id": sb.object_id, "exit_code": code, "stdout": out, "stderr": err}


# The path goes in as argv and the content over stdin, so neither one is ever parsed by a shell.
WRITE_SCRIPT = (
    "import os, sys; p = sys.argv[1]; d = os.path.dirname(p); "
    "d and os.makedirs(d, exist_ok=True); "
    # UTF-8 regardless of locale, and newline='' so CRLF files keep their endings.
    # Opening an existing file with 'w' truncates it in place, so its mode is kept.
    "sys.stdin.reconfigure(encoding='utf-8', newline=''); "
    "open(p, 'w', encoding='utf-8', newline='').write(sys.stdin.read())"
)


@web_app.post("/file/write")
def write_file(req: FileWriteRequest, authorization: str = Header(None)):
    verify_auth(authorization)
    sb = get_sandbox(req.sandbox_id)
    proc = sb.exec("python3", "-c", WRITE_SCRIPT, req.path, workdir=WORKDIR)
    proc.stdin.write(req.content)
    proc.stdin.write_eof()
    proc.stdin.drain()
    proc.wait()
    if proc.returncode != 0:
        raise HTTPException(status_code=500, detail=proc.stderr.read() or f"Cannot write {req.path}")
    return {"status": "ok", "path": req.path}


@web_app.post("/file/read")
def read_file(req: FileReadRequest, authorization: str = Header(None)):
    verify_auth(authorization)
    sb = get_sandbox(req.sandbox_id)
    # 404 means "missing or unreadable"; the control plane treats a missing .gantry.yml as "no config".
    # Read bytes, not text: the cap is in bytes, and a cut can split a multi-byte character.
    proc = sb.exec("head", "-c", str(MAX_READ_BYTES + 1), "--", req.path, workdir=WORKDIR, timeout=30, text=False)
    proc.wait()
    out = proc.stdout.read()
    if proc.returncode != 0:
        err = proc.stderr.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=404, detail=err or f"Cannot read {req.path}")
    truncated = len(out) > MAX_READ_BYTES
    # Bytes that aren't UTF-8 become U+FFFD, which the control plane's editFile refuses to rewrite.
    content = out[:MAX_READ_BYTES].decode("utf-8", errors="replace")
    return {"status": "ok", "path": req.path, "content": content, "truncated": truncated}


@web_app.post("/session/terminate")
def terminate_session(req: SandboxRef, authorization: str = Header(None)):
    verify_auth(authorization)
    get_sandbox(req.sandbox_id).terminate()
    return {"status": "terminated"}


@app.function(
    image=modal.Image.debian_slim().pip_install("fastapi[standard]"),
    secrets=[modal.Secret.from_name("agent-sandbox-secret")]
)
@modal.asgi_app()
def api():
    return web_app
