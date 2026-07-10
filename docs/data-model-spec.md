# Data Model Specification

## Overview

This is a single-table design in DynamoDB. All data goes into one table called `VirtualWaitingRoom`. We use a generic partition key (PK) and sort key (SK) pattern to store different types of items in the same table.

## Table Configuration

| Setting | Value | Reason |
|---------|-------|--------|
| Table Name | VirtualWaitingRoom | Single table for all data |
| Billing Mode | PAY_PER_REQUEST | Avoids account limit issues on deploy. Pre-warming for burst handled via CLI script. |
| Partition Key | PK (String) | Generic key for all entity types |
| Sort Key | SK (String) | Enables ordering and hierarchy |
| GSI | SessionMetadataIndex (GSIPK + ExpiresAt) | Session counting with sort-key filtering |
| TTL Attribute | ExpiresAt (Number) | Auto-cleanup sessions and old tickets |
| Streams | NEW_AND_OLD_IMAGES | Required for aggregator |

## Entities

### 1. QueueTicket

Stores each user's place in the queue when they join.

| Attribute | Type | Example | Notes |
|-----------|------|---------|-------|
| PK | String | `EVENT#match2026#SHARD#845` | Random shard between 1-2000 |
| SK | String | `TS#1719997205124#FAN#fan_12345` | Timestamp + user ID |
| FanId | String | `fan_12345` | Unique user identifier |
| EntryTimestamp | Number | `1719997205124` | Precise UTC timestamp in ms |
| ShardId | Number | `845` | Shard number for write distribution |
| ExpiresAt | Number | `1720083605` | TTL expiry in epoch seconds |

**Purpose**: Records the user's arrival time. The shard in PK spreads writes across many DynamoDB partitions to handle the traffic burst of 1 million users per second.

### 2. GlobalState

A single item that tracks the overall queue state.

| Attribute | Type | Example | Notes |
|-----------|------|---------|-------|
| PK | String | `EVENT#match2026#METADATA` | Fixed key - only one item |
| SK | String | `METADATA` | Fixed sort key |
| AdmittedUntilTimestamp | Number | `1719997202000` | Users before this time can enter |
| TieBreakerThreshold | Number | `100` | Fraction (0-100) for partial-second tie-breaking |

**Purpose**: This is the watermark item. It tells the system how far the admission window has moved. Users check their timestamp against `AdmittedUntilTimestamp` and evaluate their HMAC-based tie-breaker to know if they can enter.

### 3. DensityBucket

Stores the count of users who joined in each 1-second time bucket. Written by the Stream Aggregator.

| Attribute | Type | Example | Notes |
|-----------|------|---------|-------|
| PK | String | `EVENT#match2026#DENSITY#SHARD#3` | Sharded partition (0-9) to avoid write hotspots |
| SK | String | `BUCKET#1719997200` | Timestamp in seconds (rounded down) |
| Count | Number | `15000` | Number of users who joined in this second |

**Why separate items instead of a JSON map on GlobalState**: Atomic updates via `ADD Count :inc` are safe across concurrent aggregator instances. A JSON string on GlobalState would require read-modify-write and risk race conditions.

**PK**: The density buckets are sharded across 10 partitions (`EVENT#<EventId>#DENSITY#SHARD#<0-9>`) to prevent write hotspots in the aggregator. The read path queries all 10 shards in parallel and aggregates them in memory, which remains fast and cost-effective.

### 4. SessionItem

Represents one user's active checkout session. Created dynamically when a user enters checkout.

| Attribute | Type | Example | Notes |
|-----------|------|---------|-------|
| PK | String | `EVENT#match2026#SESSION#fan_8872` | Unique per fan, no hot partition |
| SK | String | `SESSION` | Fixed sort key |
| GSIPK | String | `EVENT#match2026#SESSION_META` | GSI key for session counting |
| FanId | String | `fan_8872` | User identifier |
| StartedAt | Number | `1719997700` | Session start timestamp |
| ExpiresAt | Number | `1720083605` | TTL expiry (5 min lease). |

**Purpose**: Controls how many users can be in the checkout process at the same time. Max 1000. TTL auto-clears abandoned sessions. The GSI index and query ensure exact counts are evaluated before watermark advancement.

### 5. Tracking

Tracks a known user's join state to prevent duplicate joins.

| Attribute | Type | Example | Notes |
|-----------|------|---------|-------|
| PK | String | `EVENT#match2026#FAN#fan_11223` | Per-user tracking item |
| SK | String | `PENDING` | Fixed sort key |
| FanId | String | `fan_11223` | User identifier |
| ExpiresAt | Number | `1720083605` | TTL expiry for cleanup |

**Purpose**: Used by the ingestion handler to detect double-join attempts. Write tracking item first. Rejoin endpoint allows recovering the token if lost.

## Density Map

The density map is stored as individual DensityBucket items across 10 shards. The read path issues parallel queries on `PK = EVENT#<Id>#DENSITY#SHARD#<0-9>` with `SK begins_with BUCKET#` and aggregates them in memory.

### Stream Aggregator Flow

1. DynamoDB Stream delivers QueueTicket INSERT events per shard.
2. Aggregator Lambda extracts `entryTimestamp`, rounds to 1-second buckets.
3. Accumulates counts per bucket in memory across a batch.
4. Flushes via `UpdateItem ADD Count :inc` on the sharded DensityBucket item.

## Global Secondary Index: SessionMetadataIndex

| Setting | Value |
|---------|-------|
| Index Name | SessionMetadataIndex |
| Hash Key | GSIPK (String) |
| Sort Key | ExpiresAt (Number) |
| Projection | INCLUDE (StartedAt) |

**Purpose**: Used by the promotion engine (every 1s) to count active sessions. Query `GSIPK = EVENT#<Id>#SESSION_META AND ExpiresAt > :now` returns only non-expired sessions. The sort key on ExpiresAt means expired sessions are filtered at the DB level, so no post-query filtering is needed. Sessions are capped at 1000, so the query always fits in one page.

## Key Design Choices

**Write Sharding**
- The QueueTicket PK has a random number (1-2000) at the end.
- This spreads 1 million writes per second evenly across DynamoDB partitions.
- No partition gets more than 500 writes per second.
- This avoids throttling during the initial traffic burst.

**Dynamic Sessions Instead of Pre-populated Slots**
- Sessions are created on-demand when a user claims a slot.
- PK is unique per fan, so writes are naturally distributed.
- No pre-population script needed.
- No risk of hot partition on slot operations.

**TTL Auto-Release and Reconciliation**
- Session items have a 5-minute TTL.
- If a user abandons checkout, the session is ignored by GSI queries as soon as it expires.
- A reconciliation Lambda runs every 5 minutes to actively purge expired session items from the table.

**Entity Overloading**
- All entity types live in the same table.
- Different PK prefixes separate them: `EVENT#...`
- This keeps the design simple and uses DynamoDB efficiently.
