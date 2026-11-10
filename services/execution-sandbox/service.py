import os
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
import modal

app = modal.App("agent-sandbox-service")

sandbox_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "pytest>=8.0.0",
    "ruff>=0.4.0",
    "duckdb>=1.0.0",
    "boto3>=1.34.0"
)

web_app = FastAPI()
AUTH_TOKEN = os.environ.get("AGENT_SANDBOX_TOKEN", "change-me-secret-key")

class ExecRequest(BaseModel):
    command: str
    timeout_seconds: int = 60
    sandbox_id: str | None = None

class FileWriteRequest(BaseModel):
    path: str
    content: str
    sandbox_id: str | None = None

def verify_auth(authorization: str | None):
    if not authorization or authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")

@web_app.post("/session/create")
async def create_session(authorization: str = Header(None)):
    verify_auth(authorization)
    sb = modal.Sandbox.create(image=sandbox_image, app=app, timeout=600)
    return {"sandbox_id": sb.object_id}

@web_app.post("/exec")
async def execute_command(req: ExecRequest, authorization: str = Header(None)):
    verify_auth(authorization)
    sb = modal.Sandbox.from_id(req.sandbox_id) if req.sandbox_id else modal.Sandbox.create(image=sandbox_image, app=app, timeout=req.timeout_seconds + 30)
    proc = sb.exec("bash", "-c", req.command)
    proc.wait()
    return {
        "sandbox_id": sb.object_id,
        "exit_code": proc.returncode,
        "stdout": proc.stdout.read(),
        "stderr": proc.stderr.read()
    }

@web_app.post("/file/write")
async def write_file(req: FileWriteRequest, authorization: str = Header(None)):
    verify_auth(authorization)
    if not req.sandbox_id:
        raise HTTPException(status_code=400, detail="sandbox_id required")
    sb = modal.Sandbox.from_id(req.sandbox_id)
    write_cmd = f"python3 -c \"import os; os.makedirs(os.path.dirname('{req.path}') or '.', exist_ok=True); open('{req.path}', 'w').write({repr(req.content)})\""
    proc = sb.exec("bash", "-c", write_cmd)
    proc.wait()
    return {"status": "ok", "path": req.path}

@web_app.post("/session/terminate")
async def terminate_session(sandbox_id: str, authorization: str = Header(None)):
    verify_auth(authorization)
    sb = modal.Sandbox.from_id(sandbox_id)
    sb.terminate()
    return {"status": "terminated"}

@app.function(
    image=modal.Image.debian_slim().pip_install("fastapi[standard]"),
    secrets=[modal.Secret.from_dict({"AGENT_SANDBOX_TOKEN": "change-me-secret-key"})]
)
@modal.asgi_app()
def api():
    return web_app
