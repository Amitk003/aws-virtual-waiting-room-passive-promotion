# Slot Handler Service

Manages active checkout sessions. Users claim a slot when admitted, and release
it when they finish or abandon checkout.

## Endpoints

### Claim a slot

```
POST /api/v1/event/{eventId}/claim
Authorization: Bearer <JWT>
```

**Response (200)**:
```json
{
  "sessionStarted": true,
  "fanId": "fan_12345",
  "expiresAt": 1720087200
}
```

**Response (429 - all slots full)**:
```json
{
  "error": "All checkout slots are full. Try again shortly."
}
```

### Release a slot

```
POST /api/v1/event/{eventId}/release
Authorization: Bearer <JWT>
```

**Response (200)**:
```json
{
  "sessionReleased": true,
  "fanId": "fan_12345"
}
```

## How it works

1. User is admitted (from status polling) and wants to enter checkout
2. Client calls POST /claim with the JWT
3. Lambda reads `AdmittedUntilTimestamp` and `TieBreakerThreshold` from GlobalState
4. If `entryTimestamp > admittedUntilTimestamp` or tie-breaker fails, returns 403
5. Lambda executes a single `TransactWriteItems`:
   - Creates a SessionItem (PK = `EVENT#<id>#SESSION#<fanId>`, SK = `SESSION`)
   - Increments `ActivePurchaserCount` with condition `ActivePurchaserCount < 1000`
6. If counter at 1000, the transaction fails atomically — no session created, no rollback needed
7. Session has a 5-minute TTL for auto-cleanup on abandon
8. User calls POST /release when checkout completes
9. Lambda conditionally deletes SessionItem (`attribute_exists(PK)`) then decrements counter

## Reconciliation

The reconciliation Lambda runs every 5 minutes via EventBridge. It queries
the SessionMetadataIndex GSI (with ExpiresAt projection), filters expired
sessions in memory, deletes expired items inline, and sets ActivePurchaserCount
to the actual valid session count. This handles counter drift without relying
on TTL stream events.

## Project structure

```
services/slot-handler/
  src/
    index.ts    - Lambda handler (claim + release)
    jwt.ts      - JWT verification
  package.json
  tsconfig.json
```
