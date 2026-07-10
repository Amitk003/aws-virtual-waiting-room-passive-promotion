# Promotion Engine

Advances the admission watermark to let users into checkout.

## How it works

1. Runs every minute via EventBridge (minimum rate), loops internally at 1s intervals
2. Reads `AdmittedUntilTimestamp` from GlobalState
3. Queries the `SessionMetadataIndex` GSI with `ExpiresAt > :now` sort-key filter, uses `Select COUNT` to get only non-expired session count
4. Calculates free slots: `1000 - validSessionCount`
5. Loads the density map (10 parallel Queries across sharded sub-partitions, cached 2s)
6. Walks forward from the current watermark, filling free slots from density buckets
7. If only a fraction of a second bucket can be admitted, writes `TieBreakerThreshold` (1-99) alongside the new watermark
8. Sets `AdmittedUntilTimestamp` via `UpdateItem` with forward-only `ConditionExpression`

This is the core of the passive promotion pattern. One `UpdateItem` can admit
thousands of users by advancing a single number.

## Design decisions

**Internal looping**: EventBridge minimum rate is 1 minute, but the watermark
needs to advance every ~1 second when users are flowing through checkout. The
Lambda runs the promotion loop in a `while` loop with 1s sleep, up to its 60s
timeout. This gives ~59 promotions per invocation (1s safety margin).

**GSI-based counting with sort-key filtering**: The `SessionMetadataIndex` uses
ExpiresAt as the sort key. The query `GSIPK = :key AND ExpiresAt > :now` filters
expired sessions at the DB level. No post-query filtering or pagination needed.
Sessions are capped at 1000, so the query always fits in one page.

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
