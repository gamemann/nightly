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

-- Lines of code history (scc), one row per project and per folder roll-up at each new git sha and at a daily snapshot.
-- type is 'project' or 'folder'; folder_path is the folder tree path ('' for a project at the root).
CREATE TABLE IF NOT EXISTS {db}.loc_history (
    ts            DateTime64(3, 'UTC'),
    project       LowCardinality(String),
    folder_path   String,
    type          LowCardinality(String),
    code          UInt64,
    comments      UInt64,
    blanks        UInt64,
    total         UInt64,
    files         UInt64,
    sha           String
) ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (type, project, folder_path, ts);
