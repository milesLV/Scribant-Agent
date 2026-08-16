.PHONY: help dev build lint check eval tf-init tf-validate tf-plan tf-apply tf-import tf-output tf-destroy setup memory-bank env clean

.DEFAULT_GOAL := help

help: ## Display available commands
	@echo "Available commands:"
	@echo ""
	@echo "Application Commands:"
	@echo "  make dev          - Start development server (Express + Vite)"
	@echo "  make build        - Build production bundle"
	@echo "  make lint         - Run TypeScript type checker"
	@echo "  make check        - Run type checks and full self-check suite"
	@echo "  make eval         - Run evaluation suite"
	@echo "  make clean        - Remove build artifacts"
	@echo ""
	@echo "Environment & Memory Bank Commands:"
	@echo "  make setup        - One-shot setup (Terraform + Memory Bank + .env configuration)"
	@echo "  make memory-bank  - List or create Vertex AI Memory Bank in GCP project"
	@echo "  make env          - Auto-generate/update .env from current GCP/Terraform state"
	@echo ""
	@echo "Terraform Infrastructure Commands:"
	@echo "  make tf-init      - Initialize Terraform providers & modules"
	@echo "  make tf-validate  - Validate Terraform syntax & logic"
	@echo "  make tf-plan      - Show execution plan for GCP infrastructure"
	@echo "  make tf-apply     - Apply Terraform changes to GCP"
	@echo "  make tf-import    - Import an existing GCP project into state (usage: make tf-import PROJECT_ID=my-project)"
	@echo "  make tf-output    - Display outputs from applied Terraform state"
	@echo "  make tf-destroy   - Destroy Terraform-managed infrastructure"
	@echo ""

setup: ## Full automated local setup
	@$(MAKE) tf-apply
	@npm run setup:env
	@npm run check

env: ## Regenerate .env from live state
	@npm run setup:env

memory-bank: ## Manage Memory Banks (e.g. make memory-bank CMD=list)
	@npm run create:memory-bank $(CMD)

dev:

	npm run dev

build:
	npm run build

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
