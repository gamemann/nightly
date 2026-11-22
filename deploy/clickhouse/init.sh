#!/bin/bash
# Runs once, from /docker-entrypoint-initdb.d, on the first start of an empty volume: creates the Usage tables in $CLICKHOUSE_DB.
set -euo pipefail
db="${CLICKHOUSE_DB:-nightly_usage}"
sed "s/{db}/${db}/g" /usr/share/nightly/schema.sql | clickhouse-client --user "${CLICKHOUSE_USER:-default}" --password "${CLICKHOUSE_PASSWORD:-}" --multiquery
