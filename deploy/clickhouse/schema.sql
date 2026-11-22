-- Usage tab schema. Counts, ids and names only: no message text is ever stored.
-- {db} is replaced by the configured database name: by init.sh on the first start of an empty volume (docker compose),
-- by `nightly usage ensure` on an existing one.
-- ReplacingMergeTree(ver): the same key inserted again (a re-ingest, a streamed message) keeps the row with the highest ver.
CREATE DATABASE IF NOT EXISTS {db};

CREATE TABLE IF NOT EXISTS {db}.usage_message (
    msg_key       String,
    ts            DateTime64(3, 'UTC'),
    session_id    String,
    agent_id      String,
    agent_type    LowCardinality(String),
    sidechain     UInt8,
    project       LowCardinality(String),
    branch        LowCardinality(String),
    model         LowCardinality(String),
    input         UInt64,
    output        UInt64,
    cache_read    UInt64,
    cache_5m      UInt64,
    cache_1h      UInt64,
    thinking      UInt64,
    tools         Array(String),
    stop_reason   LowCardinality(String),
    request_id    String,
    skill         LowCardinality(String),
    idle          UInt8,
    ver           UInt64
) ENGINE = ReplacingMergeTree(ver)
PARTITION BY toYYYYMM(ts)
ORDER BY msg_key;

CREATE TABLE IF NOT EXISTS {db}.usage_tool (
    tool_use_id   String,
    ts            DateTime64(3, 'UTC'),
    session_id    String,
    agent_id      String,
    agent_type    LowCardinality(String),
    project       LowCardinality(String),
    model         LowCardinality(String),
    tool          LowCardinality(String),
    sig           String,
    result_tokens UInt64,
    is_error      UInt8,
    skill         LowCardinality(String),
    ver           UInt64
) ENGINE = ReplacingMergeTree(ver)
PARTITION BY toYYYYMM(ts)
ORDER BY tool_use_id;

CREATE TABLE IF NOT EXISTS {db}.usage_event (
    event_key     String,
    ts            DateTime64(3, 'UTC'),
    kind          LowCardinality(String),
    session_id    String,
    agent_id      String,
    project       LowCardinality(String),
    ver           UInt64
) ENGINE = ReplacingMergeTree(ver)
PARTITION BY toYYYYMM(ts)
ORDER BY event_key;
