"""Offline tests for the execution sandbox API (service.py), against a fake modal package."""
import service
from conftest import FakeSandbox


def create(client, auth, **body):
    return client.post("/session/create", json=body, headers=auth)


# ── Deploy settings ──────────────────────────────────────────────


def test_endpoint_outlives_the_longest_exec():
    # Modal's default function timeout is 300 s, which would cut off 600 s setup and test runs.
    assert service.app.function_kwargs["timeout"] > 900  # ExecRequest.timeout_seconds allows up to 900


def test_endpoint_url_label_matches_the_worker_config():
    assert service.api.modal_options["label"] == "sandbox-service"


def test_endpoint_takes_concurrent_requests():
    assert service.api.modal_options["max_inputs"] > 1


# ── Auth ─────────────────────────────────────────────────────────


def test_rejects_missing_token(client):
    assert client.post("/session/create", json={}).status_code == 401


def test_rejects_wrong_token(client):
    res = client.post("/exec", json={"command": "true", "sandbox_id": "sb-1"}, headers={"Authorization": "Bearer nope"})
    assert res.status_code == 401
    assert FakeSandbox.created == []


# ── /session/create ──────────────────────────────────────────────


def test_creates_an_empty_workspace_without_a_repo(client, auth):
    res = create(client, auth)
    assert res.status_code == 200
    assert res.json() == {"sandbox_id": "sb-1", "repo_url": None, "ref": "HEAD", "commit": None}
    sb = FakeSandbox.created[0]
    assert sb.create_kwargs["timeout"] == service.SANDBOX_TIMEOUT_SECONDS
    assert "app" not in sb.create_kwargs


def test_clones_the_repo_and_returns_the_commit(client, auth):
    FakeSandbox.responses = {("git", "rev-parse", "HEAD"): (0, "abc123\n", "")}
    res = create(client, auth, repo_url="https://github.com/adamlefevre/gantry-lakehouse", ref="main")
    assert res.status_code == 200
    assert res.json()["commit"] == "abc123"
    argvs = [c["argv"] for c in FakeSandbox.created[0].calls]
    assert ("git", "-C", "/workspace", "fetch", "-q", "--depth", "1", "origin", "main") in argvs


def test_rejects_non_https_repo_urls(client, auth):
    for url in ["git@github.com:a/b.git", "file:///etc", "https://github.com/a/b; rm -rf /"]:
        assert create(client, auth, repo_url=url).status_code == 422
    assert FakeSandbox.created == []


def test_rejects_a_ref_that_looks_like_a_git_option(client, auth):
    res = create(client, auth, repo_url="https://github.com/a/b", ref="--upload-pack=evil")
    assert res.status_code == 422


def test_terminates_the_sandbox_when_checkout_fails(client, auth):
    FakeSandbox.responses = {("git", "-C", "/workspace", "fetch"): (128, "", "fatal: couldn't find remote ref")}
    res = create(client, auth, repo_url="https://github.com/a/b", ref="nope")
    assert res.status_code == 422
    assert "Checkout failed" in res.json()["detail"]
    assert FakeSandbox.created[0].terminated


# ── /exec, /file/*, /session/terminate ───────────────────────────


def test_exec_needs_a_sandbox_id(client, auth):
    assert client.post("/exec", json={"command": "ls"}, headers=auth).status_code == 400


def test_exec_runs_the_command_in_bash_with_its_timeout(client, auth):
    create(client, auth)
    FakeSandbox.responses = {("bash", "-c"): (3, "out", "err")}
    res = client.post("/exec", json={"command": "npm test", "timeout_seconds": 600, "sandbox_id": "sb-1"}, headers=auth)
    assert res.json() == {"sandbox_id": "sb-1", "exit_code": 3, "stdout": "out", "stderr": "err"}
    call = FakeSandbox.created[0].calls[-1]
    assert call["argv"] == ("bash", "-c", "npm test")
    assert call["timeout"] == 600


def test_exec_rejects_timeouts_over_the_limit(client, auth):
    create(client, auth)
    res = client.post("/exec", json={"command": "x", "timeout_seconds": 901, "sandbox_id": "sb-1"}, headers=auth)
    assert res.status_code == 422


def test_file_write_passes_the_path_as_argv_and_content_over_stdin(client, auth):
    create(client, auth)
    path = "src/$(whoami).py"
    res = client.post("/file/write", json={"path": path, "content": "x = 1\n", "sandbox_id": "sb-1"}, headers=auth)
    assert res.status_code == 200
    sb = FakeSandbox.created[0]
    assert sb.calls[-1]["argv"][-1] == path
    assert sb.processes[-1].stdin.written == ["x = 1\n"]


def test_file_read_returns_404_for_a_missing_file(client, auth):
    create(client, auth)
    FakeSandbox.responses = {("head",): (1, b"", b"head: cannot open '.gantry.yml'")}
    res = client.post("/file/read", json={"path": ".gantry.yml", "sandbox_id": "sb-1"}, headers=auth)
    assert res.status_code == 404


def test_file_read_caps_the_size_and_says_so(client, auth):
    create(client, auth)
    FakeSandbox.responses = {("head",): (0, b"a" * (service.MAX_READ_BYTES + 1), b"")}
    res = client.post("/file/read", json={"path": "big.txt", "sandbox_id": "sb-1"}, headers=auth)
    body = res.json()
    assert body["truncated"] is True
    assert len(body["content"]) == service.MAX_READ_BYTES


def test_file_read_replaces_invalid_utf8(client, auth):
    create(client, auth)
    FakeSandbox.responses = {("head",): (0, b"ok \xff", b"")}
    res = client.post("/file/read", json={"path": "bin", "sandbox_id": "sb-1"}, headers=auth)
    assert res.json()["content"] == "ok �"


def test_terminate(client, auth):
    create(client, auth)
    res = client.post("/session/terminate", json={"sandbox_id": "sb-1"}, headers=auth)
    assert res.json() == {"status": "terminated"}
    assert FakeSandbox.created[0].terminated
