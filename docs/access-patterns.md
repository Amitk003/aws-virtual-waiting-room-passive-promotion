# Access Patterns

This document lists all database operations the system needs. Each pattern was tested in NoSQL Workbench to make sure it works before writing any code.

## Pattern 1: Add User to Queue (Ingestion)

- **Operation**: PutItem
- **Target**: Table
- **PK**: `EVENT#<EventId>#SHARD#<RandomInt>`
- **SK**: `TS#<Timestamp>#FAN#<FanId>`
- **Condition**: `attribute_not_exists(PK)`
- **Purpose**: Adds a new user to the queue when they arrive. The random shard in PK spreads writes across partitions.

## Pattern 2: Read Aggregator Stream

- **Operation**: DynamoDB Stream read (Lambda event source mapping)
- **Target**: DDB Stream (NEW_AND_OLD_IMAGES)
- **Purpose**: Deliver QueueTicket INSERT events to the Aggregator Lambda for per-second density aggregation.

## Pattern 3: Get Global State

- **Operation**: GetItem
- **Target**: Table
- **PK**: `EVENT#<EventId>#METADATA`
- **SK**: `METADATA`
- **Purpose**: Reads the current admission watermark. Density data is fetched separately (Pattern 10). Cached at the edge (CloudFront).

## Pattern 4: Move Watermark Forward

- **Operation**: UpdateItem
- **Target**: Table
- **PK**: `EVENT#<EventId>#METADATA`
- **SK**: `METADATA`
- **Purpose**: Advances the `AdmittedUntilTimestamp` and updates `TieBreakerThreshold` to promote the next batch of users. This is the only write needed to promote thousands of users (passive promotion).

## Pattern 5: Count Active Sessions (Promotion Engine + Reconciliation)

- **Operation**: Query
- **Target**: GSI (SessionMetadataIndex)
- **GSIPK**: `EVENT#<EventId>#SESSION_META`
- **Sort Key Condition**: `ExpiresAt > :now` (filters expired sessions at the DB level)
- **Projection**: COUNT only (no data transfer)
- **Purpose**: Returns the count of active (non-expired) sessions. Used by the Promotion Engine every 1 second to compute free slots. With the sort key on ExpiresAt, expired sessions are excluded at the DB level. Sessions are capped at 1000, so the query always fits in one page.

## Pattern 6: Claim Checkout Slot

- **Operation**: PutItem
- **Target**: Table
- **PK**: `EVENT#<Id>#SESSION#<FanId>`
- **SK**: `SESSION`
- **Condition**: `attribute_not_exists(PK)`
- **Purpose**: Creates a SessionItem when an admitted user enters checkout. The admission watermark gates who can claim, and the Session GSI is used to count active slots. This avoids any optimistic concurrency conflict issues.

## Pattern 7: Release Checkout Slot (Manual)

- **Operation**: Conditional DeleteItem
- **Target**: Table
- **PK**: `EVENT#<Id>#SESSION#<FanId>`
- **SK**: `SESSION`
- **Condition**: `attribute_exists(PK)` (prevents double-releases from returning 200)
- **Purpose**: Frees a slot when a user completes checkout.

## Pattern 8: TTL Auto-Release (Stream Triggered)

- **Operation**: Stream REMOVE event (no write action needed)
- **Target**: DynamoDB Stream
- **Trigger**: DynamoDB TTL deletes an expired SessionItem
- **Purpose**: Self-healing cleanup for abandoned sessions. The GSI query in the promotion engine filters expired items out, and reconciliation cleans them up.

## Pattern 9: Expired Session Cleanup (Reconciliation)

- **Operation**: Query GSI + DeleteItem
- **Target**: GSI + Table
- **Frequency**: Every 5 minutes
- **Step 1**: Query `SessionMetadataIndex` at `GSIPK = EVENT#<Id>#SESSION_META` with `ExpiresAt <= :now`
- **Step 2**: Delete each expired SessionItem from the base table using the returned keys
- **Purpose**: Corrects any delay in physical TTL deletions by proactively purging expired sessions.

## Pattern 10: Get Time Density Map

- **Operation**: Parallel Queries
- **Target**: Table
- **PK**: `EVENT#<EventId>#DENSITY#SHARD#<ShardId>` (0-9)
- **SK**: `begins_with BUCKET#`
- **Purpose**: Queries the 10 sharded density partitions in parallel and aggregates counts in memory. This eliminates write hotspots in the aggregator during the initial stampede.

## Access Pattern Summary

| # | Pattern | Operation | Frequency |
|---|---------|-----------|-----------|
| 1 | Add user to queue | PutItem | 1M/sec (burst) |
| 2 | Stream read | Stream read | Real-time |
| 3 | Get global state | GetItem | Millions/sec (cached) |
| 4 | Move watermark | UpdateItem | 1/sec |
| 5 | Count active sessions | Query GSI | 1/sec (promotion) |
| 6 | Claim checkout slot | PutItem | 1000/sec (peak) |
| 7 | Release slot (manual) | Conditional DeleteItem | 1000/sec (peak) |
| 8 | TTL auto-release | Stream trigger | On TTL expiry |
| 9 | Expired session cleanup | Query GSI + DeleteItem | 1/5min |
| 10 | Get time density map | Parallel Queries | On demand (cached) |
