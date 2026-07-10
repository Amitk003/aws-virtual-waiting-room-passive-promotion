# Data Model Specification

## Overview

This is a single-table design in DynamoDB. All data goes into one table called `VirtualWaitingRoom`. We use a generic partition key (PK) and sort key (SK) pattern to store different types of items in the same table.

## Table Configuration

| Setting | Value | Reason |
|---------|-------|--------|
| Table Name | VirtualWaitingRoom | Single table for all data |
| Billing Mode | Provisioned | Pre-warm WCUs for traffic burst |
| Partition Key | PK (String) | Generic key for all entity types |
| Sort Key | SK (String) | Enables ordering and hierarchy |
| TTL Attribute | ExpiresAt (Number) | Auto-cleanup old records |

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

### 3. ActiveSlot

Represents one of the 1000 checkout slots.

| Attribute | Type | Example | Notes |
|-----------|------|---------|-------|
| PK | String | `EVENT#match2026#ACTIVE_SLOTS` | Fixed partition for all slots |
| SK | String | `SLOT#0442` | Slot number (0001 to 1000) |
| ActiveUserId | String | `fan_8872` | User currently holding this slot |
| ExpiresAt | Number | `1719997800` | Lease expiry in epoch seconds |

**Purpose**: Controls how many users can be in the checkout process at the same time. There are exactly 1000 slots. A user must claim a slot before entering checkout.

## Key Design Choices

**Write Sharding**
- The QueueTicket PK has a random number (1-2000) at the end
- This spreads 1 million writes per second evenly across DynamoDB partitions
- No partition gets more than 500 writes per second
- This avoids throttling during the initial traffic burst

**Entity Overloading**
- All three entity types live in the same table
- Different PK prefixes separate them: `EVENT#...`
- This keeps the design simple and uses DynamoDB efficiently

**TTL Cleanup**
- Old QueueTicket and ActiveSlot items auto-expire
- No need for background cleanup jobs
- Reduces storage costs over time
