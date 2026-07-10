# Promotion Engine

Advances the admission watermark to let users into checkout.

## How it works

1. Runs every minute via EventBridge (minimum rate), loops internally at 1s intervals
2. Reads GlobalState: `ActivePurchaserCount` and `AdmittedUntilTimestamp`
3. Calculates free slots: `1000 - ActivePurchaserCount`
4. Loads the density map (from all 20 shards, cached for 2 seconds in Lambda memory)
5. Walks forward from the current watermark, filling free slots from density buckets
6. Sets `AdmittedUntilTimestamp` to the highest included bucket timestamp

This is the core of the passive promotion pattern. One `UpdateItem` can admit
thousands of users by advancing a single number.

## Design decisions

**Internal looping**: EventBridge minimum rate is 1 minute, but the watermark
needs to advance every ~1 second when users are flowing through checkout. The
Lambda runs the promotion loop in a `while` loop with 1s sleep, up to its 5s
timeout. This gives ~4 promotions per invocation.

**Density cache**: The 20-shard density query is cached in Lambda global scope
with a 2-second TTL. The promotion engine runs every ~1s, so it reads from
cache most of the time.

**No-op when full**: If `ActivePurchaserCount` is at 1000, the loop skips and
waits for slots to free up.

## Project structure

```
services/promotion/
  src/index.ts - Lambda handler
  package.json
  tsconfig.json
```
