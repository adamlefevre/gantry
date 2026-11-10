# Instructions for agy

Run `agy` inside this unzipped directory and paste the following prompt:

---

### agy Task Prompt

Please read `AGENTS.md` and initialize the Gantry workspace:

1. **Verify Environment:** Check if a `.env` file exists. If missing, copy `.env.example` to `.env` and remind me to provide my Cloudflare R2 and Modal credentials.
2. **Setup Dependencies:** Create and activate a local Python 3.11 virtual environment (`.venv`) and install `requirements.txt`.
3. **Inspect Infrastructure:** Verify the layout against `AGENTS.md`. Ensure scripts in `pipelines/`, `services/`, and `tests/` have correct import references.
4. **Integration Test Verification:** When `.env` is populated, run `make test` to verify the compaction pipeline against Cloudflare R2.
5. **Modal Check:** Run `modal app list` or verify Modal authentication before testing `make modal-test`.

Report back with a checklist of what was verified and any items needing manual intervention.
