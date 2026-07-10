# Promotion Engine

Advances the admission watermark to let users into checkout.

## How it works

1. Runs every minute via EventBridge (minimum rate), loops internally at 1s intervals
2. Reads `AdmittedUntilTimestamp` from GlobalState (not ActivePurchaserCount)
3. Queries the `SessionMetadataIndex` GSI for session items with ExpiresAt
4. Filters expired sessions in memory, deletes them inline (fire-and-forget)
5. Calculates free slots: `1000 - validSessionCount`
6. Loads the density map (single Query on `EVENT#<id>#DENSITY`, cached 2s)
7. Walks forward from the current watermark, filling free slots from density buckets
8. If only a fraction of a second bucket can be admitted, writes `TieBreakerThreshold` (1-99) alongside the new watermark
9. Sets `AdmittedUntilTimestamp` via `UpdateItem` with forward-only `ConditionExpression`

This is the core of the passive promotion pattern. One `UpdateItem` can admit
thousands of users by advancing a single number.

## Design decisions

**Internal looping**: EventBridge minimum rate is 1 minute, but the watermark
needs to advance every ~1 second when users are flowing through checkout. The
Lambda runs the promotion loop in a `while` loop with 1s sleep, up to its 60s
timeout. This gives ~58 promotions per invocation.

**GSI-based counting instead of TTL**: DynamoDB TTL deletions are asynchronous
and can be delayed up to 48 hours. The engine queries the GSI directly, filters
expired sessions in memory, and uses only the valid count. Expired sessions are
deleted inline so slots free up in seconds.

**Tie-breaking**: When only a fraction of users from a crowded second can be
admitted, the engine writes `TieBreakerThreshold` to GlobalState. Verifiers use
`hash(fanId) % 100 < TieBreakerThreshold` to gate admission, preventing
oversubscription.

**No-op when full**: If all 1000 slots are occupied, the loop skips and waits
for slots to free up.

## Project structure

```
services/promotion/
  src/index.ts - Lambda handler
  package.json
  tsconfig.json
```
