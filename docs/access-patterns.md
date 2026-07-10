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

## Pattern 5: Get Active Session Count (Reconciliation)

- **Operation**: Query
- **Target**: GSI (SessionMetadataIndex)
- **GSIPK**: `EVENT#<EventId>#SESSION_META`
- **Purpose**: Returns all active session keys to count current checkout users. Used by the reconciliation Lambda that runs every 5 minutes to correct counter drift. Costs very little since sessions are capped at 1000.

## Pattern 6: Claim Checkout Slot

- **Operation**: PutItem (session item) + UpdateItem (counter)
- **Target**: Table
- **Step 1**: PutItem with `PK = EVENT#<Id>#SESSION#<FanId>`, `SK = SESSION`, `ExpiresAt = <now + 5min>`, `GSIPK = EVENT#<Id>#SESSION_META`
- **Step 2**: UpdateItem on GlobalState: `ADD ActivePurchaserCount 1` with condition `ActivePurchaserCount < 1000`
- **Rollback**: If step 2 fails (counter at 1000), delete the session item created in step 1
- **Purpose**: Dynamically creates a checkout session and increments the counter. Writes are naturally distributed since each session has a unique PK.

## Pattern 7: Release Checkout Slot (Manual)

- **Operation**: DeleteItem (session) + UpdateItem (counter)
- **Target**: Table
- **Step 1**: DeleteItem on `PK = EVENT#<Id>#SESSION#<FanId>`, `SK = SESSION`
- **Step 2**: UpdateItem on GlobalState: `ADD ActivePurchaserCount -1`
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

- **Operation**: Query
- **Target**: Table
- **PK**: `EVENT#<EventId>#DENSITY`
- **SK**: begins_with `BUCKET#`
- **Purpose**: Returns all DensityBucket items for an event. Each item has a `Count` attribute representing the number of users who joined in that 1-second bucket. The total queue position for a user at timestamp T is the sum of all Count values for buckets before T. With at most 3600 items for a typical 1-hour event, this is fast enough to serve at the edge.

- **Operation**: Query GSI + UpdateItem
- **Target**: GSI + Table
- **Frequency**: Every 5 minutes
- **Step 1**: Query `SessionMetadataIndex` at `GSIPK = EVENT#<Id>#SESSION_META`, count results
- **Step 2**: UpdateItem on GlobalState to set `ActivePurchaserCount` to the actual count
- **Purpose**: Corrects any counter drift from missed TTL events or duplicate stream processing.

## Access Pattern Summary

| # | Pattern | Operation | Frequency |
|---|---------|-----------|-----------|
| 1 | Add user to queue | PutItem | 1M/sec (burst) |
| 2 | Stream read | Stream read | Real-time |
| 3 | Get global state | GetItem | Millions/sec (cached) |
| 4 | Move watermark | UpdateItem | 1/sec |
| 5 | Count sessions (reconciliation) | Query GSI | 1/5min |
| 6 | Claim checkout slot | PutItem + UpdateItem | 1000/sec (peak) |
| 7 | Release slot (manual) | DeleteItem + UpdateItem | 1000/sec (peak) |
| 8 | TTL auto-release | Stream trigger | On TTL expiry |
| 9 | Counter drift correction | Query GSI + UpdateItem | 1/5min |
| 10 | Get time density map | Query table (DensityBucket) | On demand (cached) |
