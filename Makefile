SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help setup up down logs ps reset dev build typecheck lint format test test-int db-test seed check clean backup restore-rehearsal

help: ## Show available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## First-time setup: install deps, create .env with generated local secrets
	@if [ ! -f .env ]; then \
		cp .env.example .env; \
		key1=$$(openssl rand -base64 32); \
		key2=$$(openssl rand -base64 32); \
		jwt1=$$(openssl rand -base64 48); \
		jwt2=$$(openssl rand -base64 48); \
		sed -i "s|^CHAT_ENCRYPTION_KEY=.*|CHAT_ENCRYPTION_KEY=$$key1|" .env; \
		sed -i "s|^PII_HASH_PEPPER=.*|PII_HASH_PEPPER=$$key2|" .env; \
		sed -i "s|^JWT_ACCESS_SECRET=.*|JWT_ACCESS_SECRET=$$jwt1|" .env; \
		sed -i "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$$jwt2|" .env; \
		sed -i "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=|" .env; \
		sed -i "s|^TELEGRAM_WEBHOOK_SECRET_PATH=.*|TELEGRAM_WEBHOOK_SECRET_PATH=$$(openssl rand -hex 24)|" .env; \
		sed -i "s|^TELEGRAM_WEBHOOK_SECRET_TOKEN=.*|TELEGRAM_WEBHOOK_SECRET_TOKEN=$$(openssl rand -hex 32)|" .env; \
		echo "Created .env with freshly generated local development secrets."; \
		echo "These are LOCAL ONLY and .env is gitignored. Add your BotFather token to"; \
		echo "TELEGRAM_BOT_TOKEN when you reach M2."; \
	else \
		echo ".env already exists — leaving it untouched."; \
	fi
	pnpm install

up: ## Start Postgres and Redis
	docker compose up -d
	@echo "Waiting for services to report healthy..."
	@until [ "$$(docker inspect -f '{{.State.Health.Status}}' payetam-postgres 2>/dev/null)" = "healthy" ] && \
	       [ "$$(docker inspect -f '{{.State.Health.Status}}' payetam-redis 2>/dev/null)" = "healthy" ]; do \
		sleep 1; \
	done
	@echo "Postgres and Redis are healthy."

down: ## Stop services (data is preserved)
	docker compose down

logs: ## Tail service logs
	docker compose logs -f

ps: ## Show service status
	docker compose ps

reset: ## DESTRUCTIVE: delete all local database and Redis data
	@echo "This deletes the local Postgres and Redis volumes. Local data only — but it is gone."
	@read -p "Type 'reset' to confirm: " ans; [ "$$ans" = "reset" ] || (echo "Aborted."; exit 1)
	docker compose down -v

dev: ## Run api and worker in watch mode
	pnpm dev

build: ## Build all packages
	pnpm build

typecheck: ## Type-check the whole workspace
	pnpm typecheck

lint: ## Lint
	pnpm lint

format: ## Format with Prettier
	pnpm format

test: ## Unit tests
	pnpm test

test-int: ## Integration tests (real Postgres — see db-test first)
	pnpm test:integration

db-test: ## Create and migrate payetam_test, so integration tests stop truncating your dev data
	docker compose exec -T postgres \
		psql -U payetam -d postgres -tAc \
		"SELECT 1 FROM pg_database WHERE datname='payetam_test'" | grep -q 1 || \
		docker compose exec -T postgres createdb -U payetam payetam_test
	DATABASE_URL="postgresql://payetam:$$(grep -oP '(?<=^DATABASE_URL=postgresql://payetam:)[^@]+' .env)@localhost:55432/payetam_test" \
		pnpm --filter @payetam/db db:migrate:deploy
	@echo
	@echo "Add this to .env so the integration suite uses it:"
	@echo "  TEST_DATABASE_URL=postgresql://payetam:<password>@localhost:55432/payetam_test"

seed: ## Seed policies, catalog, blacklist and RBAC into the development database
	pnpm seed:policies
	pnpm seed:catalog
	pnpm seed:blacklist
	pnpm seed:rbac

backup: ## Dump the development database, through the production backup script
	docker cp tools/backup.sh payetam-postgres:/tmp/backup.sh
	docker exec -e DATABASE_URL="postgresql://payetam:$$(grep -oP '(?<=^DATABASE_URL=postgresql://payetam:)[^@]+' .env)@localhost:5432/payetam" \
		-e PAYETAM_BACKUP_DIR=/tmp/payetam-backups \
		payetam-postgres bash /tmp/backup.sh

restore-rehearsal: ## Restore the newest dump into a scratch database and time it (M16)
	docker cp tools/restore-rehearsal.sh payetam-postgres:/tmp/restore-rehearsal.sh
	docker exec -e DATABASE_URL="postgresql://payetam:$$(grep -oP '(?<=^DATABASE_URL=postgresql://payetam:)[^@]+' .env)@localhost:5432/payetam" \
		payetam-postgres bash -c \
		'bash /tmp/restore-rehearsal.sh "$$(ls -t /tmp/payetam-backups/*.dump | head -1)"'

check: typecheck lint test ## What CI runs on every commit

clean: ## Remove build output and node_modules
	rm -rf node_modules apps/*/node_modules packages/*/node_modules
	rm -rf apps/*/dist packages/*/dist
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
