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
| GSI | SessionMetadataIndex (GSIPK) | Keys-only projection for session counting and reconciliation |
| TTL Attribute | ExpiresAt (Number) | Auto-cleanup sessions and old tickets |
| Streams | NEW_AND_OLD_IMAGES | Required for aggregator and TTL-auto-release |

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
| ActivePurchaserCount | Number | `950` | How many users are currently buying |
| TieBreakerThreshold | Number | `100` | Fraction (0-100) for partial-second tie-breaking |

**Purpose**: This is the "watermark" item. It tells the system how far the admission window has moved. Users check their timestamp against `AdmittedUntilTimestamp` to know if they can enter.

### 3. DensityBucket

Stores the count of users who joined in each 1-second time bucket. Written by the
Stream Aggregator which accumulates counts per batch and flushes via atomic ADD.
Shard-level pre-aggregation reduces GlobalState updates from millions to ~2000/sec.

| Attribute | Type | Example | Notes |
|-----------|------|---------|-------|
| PK | String | `EVENT#match2026#DENSITY#SHARD#7` | Hash of bucket timestamp mod 20 (scatters writes) |
| SK | String | `BUCKET#1719997200` | Timestamp in seconds (rounded down) |
| Count | Number | `4521` | Number of users who joined in this second |

**Why separate items instead of a JSON map on GlobalState**: Atomic updates via
`ADD Count :inc` are safe across concurrent aggregator instances. A JSON string
on GlobalState would require read-modify-write and risk race conditions.

**PK**: A single partition key `EVENT#<EventId>#DENSITY` is used instead of
sharding. The stream aggregator pre-aggregates counts in memory per batch
before writing, so the write rate to this partition stays well below 1000 WCU.
The read path issues a single Query, eliminating read amplification.

**Pruning**: After `AdmittedUntilTimestamp` advances past a bucket, the bucket
data is no longer needed. A periodic task can delete old DensityBucket items.

### 4. SessionItem

Represents one user's active checkout session. Created dynamically when a user enters checkout.

| Attribute | Type | Example | Notes |
|-----------|------|---------|-------|
| PK | String | `EVENT#match2026#SESSION#fan_8872` | Unique per fan, no hot partition |
| SK | String | `SESSION` | Fixed sort key |
| GSIPK | String | `EVENT#match2026#SESSION_META` | GSI key for session counting |
| FanId | String | `fan_8872` | User identifier |
| StartedAt | Number | `1719997700` | Session start timestamp |
| ExpiresAt | Number | `1720083605` | TTL expiry (5 min lease). Auto-deletes on abandon. |

**Purpose**: Controls how many users can be in the checkout process at the same time. Max 1000. TTL auto-clears abandoned sessions. Stream triggers decrement `ActivePurchaserCount` on cleanup.

## Density Map

The density map is stored as individual DensityBucket items (one per 1-second
bucket). The read path issues a single Query on `PK = EVENT#<Id>#DENSITY` with
`SK begins_with BUCKET#` to retrieve all buckets. With at most 3600 items for a
typical event, this is fast and cost-effective.

### Stream Aggregator Flow

1. DynamoDB Stream delivers QueueTicket INSERT events per shard
2. Aggregator Lambda extracts `entryTimestamp`, rounds to 1-second buckets
3. Accumulates counts per bucket in memory across a batch (up to 100 records)
4. Flushes via `UpdateItem ADD Count :inc` on the DensityBucket item
5. TTL REMOVE events on SessionItem decrement `ActivePurchaserCount` on GlobalState

This is a shard-level pre-aggregation pattern. Each DynamoDB Stream shard has its
own Lambda instance, so aggregation is naturally parallelized.

## Global Secondary Index: SessionMetadataIndex

| Setting | Value |
|---------|-------|
| Index Name | SessionMetadataIndex |
| Hash Key | GSIPK (String) |
| Sort Key | (none - HASH only) |
| Projection | KEYS_ONLY |

**Purpose**: Used by the reconciliation Lambda to quickly count active sessions. Query `GSIPK = EVENT#<EventId>#SESSION_META` returns all session keys. Because sessions are capped at 1000, this query costs very little.

## Key Design Choices

**Write Sharding**
- The QueueTicket PK has a random number (1-2000) at the end
- This spreads 1 million writes per second evenly across DynamoDB partitions
- No partition gets more than 500 writes per second
- This avoids throttling during the initial traffic burst

**Dynamic Sessions Instead of Pre-populated Slots**
- Sessions are created on-demand when a user passes edge auth
- PK is unique per fan, so writes are naturally distributed
- No pre-population script needed
- No risk of hot partition on slot operations

**TTL Auto-Release**
- Session items have a 5-minute TTL
- If a user abandons checkout, the session auto-deletes
- The Stream Aggregator detects the TTL REMOVE event and decrements `ActivePurchaserCount`
- A reconciliation Lambda runs every 5 minutes to correct counter drift

**Density Bucket Pruning**
- DensityBucket items for timestamps before `AdmittedUntilTimestamp` can be deleted
- A periodic task (reconciliation Lambda) removes old buckets to reduce storage
- With at most 3600 buckets per event, storage is negligible

**Entity Overloading**
- All entity types live in the same table
- Different PK prefixes separate them: `EVENT#...`
- This keeps the design simple and uses DynamoDB efficiently
