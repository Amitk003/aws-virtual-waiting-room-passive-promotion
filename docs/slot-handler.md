# Slot Handler Service

Manages active checkout sessions. Users claim a slot when admitted, and release it when they finish or abandon checkout.

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

**Response (409 - session already exists)**:
```json
{
  "error": "Session already exists"
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

1. User is admitted (from status polling) and wants to enter checkout.
2. Client calls POST /claim with the JWT.
3. Lambda reads `AdmittedUntilTimestamp` and `TieBreakerThreshold` from GlobalState.
4. If `entryTimestamp > admittedUntilTimestamp` or tie-breaker fails, returns 403.
5. Lambda creates a SessionItem (PK = `EVENT#<id>#SESSION#<fanId>`, SK = `SESSION`) using a simple PutItem with `ConditionExpression: attribute_not_exists(PK)`.
6. This Session has a 5-minute TTL for auto-cleanup on abandon.
7. User calls POST /release when checkout completes.
8. Lambda conditionally deletes the SessionItem (`attribute_exists(PK)`).

## Reconciliation

The reconciliation Lambda runs every 5 minutes via EventBridge. It queries the SessionMetadataIndex GSI with `ExpiresAt <= :now` to find sessions that have expired but have not yet been physically removed by DynamoDB TTL. It then deletes those items immediately. This prevents the active session count from overshooting.

## Project structure

```
services/slot-handler/
  src/
    index.ts    - Lambda handler (claim + release)
    jwt.ts      - JWT verification
  package.json
  tsconfig.json
```
