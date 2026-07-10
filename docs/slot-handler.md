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
3. Lambda creates a SessionItem (PK = `EVENT#<id>#SESSION#<fanId>`, SK = `SESSION`)
4. Lambda atomically increments ActivePurchaserCount with condition < 1000
5. If counter at 1000, rolls back (deletes SessionItem) and returns 429
6. Session has a 5-minute TTL for auto-cleanup on abandon
7. User calls POST /release when checkout completes
8. Lambda deletes SessionItem and decrements ActivePurchaserCount

## Reconciliation

The reconciliation Lambda runs every 5 minutes via EventBridge. It queries
the SessionMetadataIndex GSI to count actual active sessions and corrects
ActivePurchaserCount on GlobalState. This handles edge cases like missed
TTL events or duplicate stream processing.

## Project structure

```
services/slot-handler/
  src/
    index.ts    - Lambda handler (claim + release)
    jwt.ts      - JWT verification
  package.json
  tsconfig.json
```
