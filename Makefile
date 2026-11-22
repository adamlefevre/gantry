SHELL := /bin/bash
-include .env
export

.PHONY: help test sandbox-test typecheck dev deploy modal-deploy

help:
	@echo "Gantry commands:"
	@echo "  make test         - Run the offline control-plane tests (Vitest + Miniflare)"
	@echo "  make sandbox-test - Run the offline sandbox service tests (pytest, fake modal)"
	@echo "  make typecheck    - Type-check the control plane"
	@echo "  make dev          - Run the control plane locally (wrangler dev)"
	@echo "  make deploy       - Deploy the control plane to Cloudflare"
	@echo "  make modal-deploy - Deploy the execution sandbox API to Modal"

test:
	npm test

sandbox-test:
	python3 -m pytest -q services/execution-sandbox/tests

typecheck:
	cd apps/control-plane && npx tsc --noEmit

dev:
	npm --prefix apps/control-plane run dev

deploy:
	npm --prefix apps/control-plane run deploy

modal-deploy:
	modal deploy services/execution-sandbox/service.py
