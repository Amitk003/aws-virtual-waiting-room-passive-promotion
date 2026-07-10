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

- **Operation**: DynamoDB Stream read
- **Target**: DDB Stream
- **Purpose**: Captures new QueueTicket inserts asynchronously. Used to build the time-density map without slowing down the main write path.

## Pattern 3: Get Global State

- **Operation**: GetItem
- **Target**: Table
- **PK**: `EVENT#<EventId>#METADATA`
- **SK**: `METADATA`
- **Purpose**: Reads the current admission watermark and time-density map. This data is cached at the edge (CloudFront) to handle millions of user polling requests.

## Pattern 4: Move Watermark Forward

- **Operation**: UpdateItem
- **Target**: Table
- **PK**: `EVENT#<EventId>#METADATA`
- **SK**: `METADATA`
- **Purpose**: Advances the `AdmittedUntilTimestamp` to promote the next batch of users. This is the only write needed to promote thousands of users (passive promotion).

## Pattern 5: Monitor Active Slots

- **Operation**: Query
- **Target**: Table
- **PK**: `EVENT#<EventId>#ACTIVE_SLOTS`
- **Condition**: None
- **Purpose**: Reads all 1000 checkout slots to see how many are free. Runs every 1-2 seconds to keep the checkout flow full.

## Pattern 6: Claim an Active Slot

- **Operation**: UpdateItem
- **Target**: Table
- **PK**: `EVENT#<EventId>#ACTIVE_SLOTS`
- **SK**: `SLOT#<SlotId>`
- **Condition**: `attribute_not_exists(ActiveUserId) OR ExpiresAt < :now`
- **Purpose**: Assigns a checkout slot to a user. The condition prevents two users from taking the same slot.

## Pattern 7: Release an Active Slot

- **Operation**: UpdateItem
- **Target**: Table
- **PK**: `EVENT#<EventId>#ACTIVE_SLOTS`
- **SK**: `SLOT#<SlotId>`
- **Purpose**: Frees a slot when a user completes checkout or their session expires. Uses `REMOVE` on `ActiveUserId`.

## Access Pattern Summary

| # | Pattern | Operation | Frequency |
|---|---------|-----------|-----------|
| 1 | Add user to queue | PutItem | 1M/sec (burst) |
| 2 | Stream read | Stream read | Real-time |
| 3 | Get global state | GetItem | Millions/sec (cached) |
| 4 | Move watermark | UpdateItem | 1/sec |
| 5 | Monitor slots | Query | 1/sec |
| 6 | Claim slot | UpdateItem (conditional) | 1000/sec (peak) |
| 7 | Release slot | UpdateItem | 1000/sec (peak) |
