#!/usr/bin/env bash
# Container entrypoint: make the database match the schema (tables, ClickHouse, first admin), then start the panel.
set -euo pipefail
cd /app
node --no-warnings lib/bootstrap.mjs
exec "$@"
