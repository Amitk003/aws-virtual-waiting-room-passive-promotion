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
| GSI | SessionMetadataIndex (GSIPK, SK) | Keys-only projection for session counting and reconciliation |
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
| TotalQueued | Number | `2500000` | Total users in queue |
| TimeDensityMap | String | JSON array | Count of users per second bucket |

**Purpose**: This is the "watermark" item. It tells the system how far the admission window has moved. Users check their timestamp against `AdmittedUntilTimestamp` to know if they can enter.

### 3. SessionItem

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

## Global Secondary Index: SessionMetadataIndex

| Setting | Value |
|---------|-------|
| Index Name | SessionMetadataIndex |
| Hash Key | GSIPK (String) |
| Sort Key | SK (String) |
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

**Density Map Pruning**
- Timestamp buckets older than `AdmittedUntilTimestamp` are removed by the Stream Aggregator
- This keeps the `TimeDensityMap` item size under 10 KB
- Prevents hitting the 400 KB DynamoDB item size limit
- Also makes reads and writes cheaper since DynamoDB charges by item size

**Entity Overloading**
- All entity types live in the same table
- Different PK prefixes separate them: `EVENT#...`
- This keeps the design simple and uses DynamoDB efficiently
