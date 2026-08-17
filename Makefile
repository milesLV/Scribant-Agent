.PHONY: help dev build start lint check eval clean setup memory-bank env tf-init tf-validate tf-plan tf-apply tf-import tf-output tf-destroy

.DEFAULT_GOAL := help

help: ## Show available commands with structured, LLM-friendly guidance
	@echo "=================================================================================="
	@echo "                      SCRIBANT AGENT DEVELOPMENT WORKFLOWS"
	@echo "=================================================================================="
	@echo ""
	@echo "Application Development:"
	@echo "  make dev          Start TypeScript development server (Express + Vite) on port 3000."
	@echo "  make dev-py       Start Python ADK backend server (FastAPI + Uvicorn) on port 3000."
	@echo "  make check-py     Run Python backend test suite."
	@echo "  make check        MANDATORY VALIDATION GATE. Runs typechecker (tsc --noEmit) and all"
	@echo "                    12 submodule self-test suites. Run this before committing any changes."
	@echo "  make build        Build production client bundle (dist/) and bundle server.ts via esbuild."
	@echo "  make start-py     Run Python production server on port 3000."
	@echo "  make start        Run compiled production server from dist/server.cjs."
	@echo "  make lint         Run fast TypeScript typecheck without emitting files."
	@echo "  make eval         Run LLM-as-a-judge evaluation benchmark suite against evals/data/."
	@echo "  make clean        Delete dist/ build directory and compiled artifacts."
	@echo ""
	@echo "Environment & Configuration:"
	@echo "  make setup        One-shot end-to-end setup (tf-apply -> setup:env -> check)."
	@echo "  make env          Regenerate/update .env file from live GCP/Terraform outputs."
	@echo ""
	@echo "Terraform GCP Infrastructure:"
	@echo "  make tf-init      Initialize Terraform providers and local backend."
	@echo "  make tf-validate  Validate Terraform syntax and configuration."
	@echo "  make tf-plan      Generate and display GCP infrastructure execution plan."
	@echo "  make tf-apply     Apply Terraform changes to provision GCP resources."
	@echo "  make tf-import    Import existing GCP project into state:"
	@echo "                      make tf-import PROJECT_ID=<gcp-project-id>"
	@echo "  make tf-output    Display structured output variables from Terraform state."
	@echo "  make tf-destroy   Tear down and destroy Terraform-managed GCP infrastructure."
	@echo "=================================================================================="

setup: ## Full automated local setup
	@$(MAKE) tf-apply
	@npm run setup:env
	@npm run check

env: ## Regenerate .env from live state
	@npm run setup:env

dev:
	npm run dev

dev-py:
	PYTHONPATH=. .venv/bin/uvicorn backend.server:app --host 127.0.0.1 --port 3000 --reload

check-py:
	PYTHONPATH=. .venv/bin/python3 -m backend.test_backend

start-py:
	PYTHONPATH=. .venv/bin/uvicorn backend.server:app --host 127.0.0.1 --port 3000

build:
	npm run build

start:
	npm start

lint:
	npm run lint

check:
	npm run check

eval:
	npm run eval

clean:
	npm run clean

tf-init:
	terraform -chdir=terraform init

tf-validate:
	terraform -chdir=terraform validate

tf-plan:
	terraform -chdir=terraform plan

tf-apply:
	terraform -chdir=terraform apply

# Import an existing GCP project (e.g. one created outside Terraform) into state
# before applying with project_id set, so Terraform adopts it instead of trying
# to create a project with an already-taken ID.
tf-import:
	terraform -chdir=terraform import -var="project_id=$(PROJECT_ID)" google_project.project $(PROJECT_ID)

tf-output:
	terraform -chdir=terraform output

tf-destroy:
	terraform -chdir=terraform destroy
