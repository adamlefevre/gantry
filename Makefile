SHELL := /bin/bash
-include .env
export

.PHONY: help init-bucket cors ingest compact test modal-test modal-deploy clean

help:
	@echo "Gantry Commands:"
	@echo "  make init-bucket  - Provision the R2 bucket via Wrangler"
	@echo "  make cors         - Apply CORS policy to the R2 bucket"
	@echo "  make ingest       - Stream NYC Taxi parquet sample into R2 via DuckDB"
	@echo "  make compact      - Run partition bin-packing & compaction locally"
	@echo "  make test         - Run ephemeral integration tests"
	@echo "  make modal-test   - Run scheduled compaction once on Modal (real bucket; deletes source files)"
	@echo "  make modal-deploy - Deploy cron compaction and sandbox API to Modal"
	@echo "  make clean        - Delete the R2 bucket"

init-bucket:
	@echo "==> Creating R2 bucket: $(R2_BUCKET_NAME)..."
	npx wrangler r2 bucket create $(R2_BUCKET_NAME)

cors:
	@echo "==> Setting open CORS policy for DuckDB-Wasm / client read access..."
	@echo '[{"AllowedOrigins":["*"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"]}]' > .cors.json
	npx wrangler r2 bucket cors set $(R2_BUCKET_NAME) .cors.json
	@rm -f .cors.json

ingest:
	@echo "==> Ingesting partition-pruned dataset into r2://$(R2_BUCKET_NAME)..."
	python pipelines/ingest.py

compact:
	@echo "==> Running partition compaction on r2://$(R2_BUCKET_NAME)..."
	python pipelines/compact.py

test:
	@echo "==> Running lakehouse integration test suite..."
	pytest tests/test_compaction.py -v -s

modal-test:
	@echo "==> Running scheduled compaction once on Modal (real bucket)..."
	modal run jobs/scheduled_compaction.py

modal-deploy:
	@echo "==> Deploying daily scheduled compaction job & sandbox service to Modal..."
	modal deploy jobs/scheduled_compaction.py
	modal deploy services/execution-sandbox/service.py

clean:
	@echo "==> Deleting R2 bucket: $(R2_BUCKET_NAME)..."
	npx wrangler r2 bucket delete $(R2_BUCKET_NAME)
