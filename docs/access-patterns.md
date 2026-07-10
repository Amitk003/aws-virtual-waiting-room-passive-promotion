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
- **Purpose**: Deliver QueueTicket INSERT events (per-second density aggregation) and SessionItem REMOVE events (TTL session counter decrement) to the Aggregator Lambda.

## Pattern 3: Get Global State

- **Operation**: GetItem
- **Target**: Table
- **PK**: `EVENT#<EventId>#METADATA`
- **SK**: `METADATA`
- **Purpose**: Reads the current admission watermark and active session count. Density data is fetched separately (Pattern 10). Cached at the edge (CloudFront).

## Pattern 4: Move Watermark Forward

- **Operation**: UpdateItem
- **Target**: Table
- **PK**: `EVENT#<EventId>#METADATA`
- **SK**: `METADATA`
- **Purpose**: Advances the `AdmittedUntilTimestamp` to promote the next batch of users. This is the only write needed to promote thousands of users (passive promotion).

## Pattern 5: Count Active Sessions (Promotion Engine + Reconciliation)

- **Operation**: Query
- **Target**: GSI (SessionMetadataIndex)
- **GSIPK**: `EVENT#<EventId>#SESSION_META`
- **Sort Key Condition**: `ExpiresAt > :now` (filters expired sessions at the DB level)
- **Projection**: COUNT only (no data transfer)
- **Purpose**: Returns the count of active (non-expired) sessions. Used by the Promotion Engine every 1 second to compute free slots, and by the Reconciliation Lambda every 5 minutes to correct counter drift. With the sort key on ExpiresAt, expired sessions are excluded at the DB level. Sessions are capped at 1000, so the query always fits in one page.

## Pattern 6: Claim Checkout Slot

- **Operation**: TransactWriteItems (session item + counter update)
- **Target**: Table
- **Transact 1**: PutItem with `PK = EVENT#<Id>#SESSION#<FanId>`, `SK = SESSION`, `ExpiresAt = <now + 5min>`, `GSIPK = EVENT#<Id>#SESSION_META`
- **Transact 2**: UpdateItem on GlobalState: `ADD ActivePurchaserCount 1`
- **Admission gate**: Before the transaction, the slot handler checks isAdmitted() and verifies `ActivePurchaserCount < 1000`. Tie-breaking uses entryTimestamp at second granularity.
- **Purpose**: Atomic claim of a checkout slot. No rollback needed — if the transaction fails, no partial state remains. Writes are naturally distributed across unique PKs.

## Pattern 7: Release Checkout Slot (Manual)

- **Operation**: Conditional DeleteItem
- **Target**: Table
- **Condition**: `attribute_exists(PK)` — prevents double-releases from returning 200
- **Action**: DeleteItem on `PK = EVENT#<Id>#SESSION#<FanId>`, `SK = SESSION`. The decrement of `ActivePurchaserCount` is handled by the Stream Aggregator on the REMOVE event, keeping the release path simple.
- **Purpose**: Frees a slot when a user completes checkout.

## Pattern 8: TTL Auto-Release (Stream Triggered)

- **Operation**: Stream REMOVE event → Lambda handler
- **Target**: DynamoDB Stream
- **Trigger**: DynamoDB TTL deletes an expired SessionItem
- **Action**: Stream Aggregator Lambda detects REMOVE event where `userIdentity` is TTL, then decrements `ActivePurchaserCount` on GlobalState
- **Purpose**: Self-healing cleanup for abandoned sessions. No custom cron work needed.

## Pattern 9: Counter Drift Correction (Reconciliation)

- **Operation**: Query GSI + UpdateItem
- **Target**: GSI + Table
- **Frequency**: Every 5 minutes
- **Step 1**: Query `SessionMetadataIndex` at `GSIPK = EVENT#<Id>#SESSION_META`, count results
- **Step 2**: UpdateItem on GlobalState to set `ActivePurchaserCount` to the actual count
- **Purpose**: Corrects any counter drift from missed TTL events or duplicate stream processing.

## Pattern 10: Get Time Density Map

- **Operation**: Single Query
- **Target**: Table
- **PK**: `EVENT#<EventId>#DENSITY`
- **SK**: `begins_with BUCKET#`
- **Purpose**: Returns all DensityBucket items for an event in a single query. Each item has a `Count` attribute representing the number of users who joined in that 1-second bucket. No sharding needed because the Stream Aggregator pre-aggregates counts in memory per batch before writing, keeping the write rate well below 1000 WCU per partition. The total queue position for a user at timestamp T is the sum of all Count values for buckets before T. With at most 3600 items total, a single query fits well within 1MB.

## Access Pattern Summary

| # | Pattern | Operation | Frequency |
|--|---------|-----------|-----------|
| 1 | Add user to queue | PutItem | 1M/sec (burst) |
| 2 | Stream read | Stream read | Real-time |
| 3 | Get global state | GetItem | Millions/sec (cached) |
| 4 | Move watermark | UpdateItem | 1/sec |
| 5 | Count active sessions | Query GSI | 1/sec (promotion) + 1/5min (reconciliation) |
| 6 | Claim checkout slot | TransactWriteItems | 1000/sec (peak) |
| 7 | Release slot (manual) | Conditional DeleteItem | 1000/sec (peak) |
| 8 | TTL auto-release | Stream trigger | On TTL expiry |
| 9 | Counter drift correction | Query GSI + UpdateItem | 1/5min |
| 10 | Get time density map | Query table (single partition) | On demand (cached) |
