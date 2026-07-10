# Status Polling Service

This service lets users check their queue position and admission status.

## Endpoint

```
GET /api/v1/event/{eventId}/status
```

### Headers

| Header | Value | Required |
|--------|-------|----------|
| Authorization | `Bearer <JWT>` | Yes |

The JWT is obtained from the ingestion endpoint (POST /join).

### Response (200 - Admitted)

```json
{
  "admitted": true,
  "fanId": "fan_12345",
  "entryTimestamp": 1719997000000,
  "admittedUntilTimestamp": 1719997202000,
  "activePurchaserCount": 950
}
```

### Response (200 - Waiting)

```json
{
  "admitted": false,
  "fanId": "fan_12345",
  "entryTimestamp": 1719997000000,
  "admittedUntilTimestamp": 1719997202000,
  "queuePosition": 4523,
  "estimatedWaitSeconds": 75,
  "activePurchaserCount": 950
}
```

### Response (401)

```json
{
  "error": "Invalid or expired token"
}
```

## How it works

1. User sends their JWT in the Authorization header
2. Lambda verifies the JWT locally using the cached public key from Secrets Manager
3. Reads GlobalState (GetItem) for the event's `AdmittedUntilTimestamp` and `TieBreakerThreshold`
4. Admission check uses tie-breaking: `hash(fanId) % 100 < TieBreakerThreshold` when entryTimestamp equals the watermark
5. If admitted, returns immediately with `admitted: true`
6. If waiting, queries the single DensityBucket PK (1 Query, not 20 parallel) for all per-second bucket counts
7. Calculates queue position = sum of counts in all buckets before user's timestamp
8. Estimates wait time based on queue position and ActivePurchaserCount

## CloudFront CDN

CloudFront sits in front of the API Gateway. The status endpoint is cached per-user
using the Authorization header as part of the cache key. Cache TTL is 2 seconds
(default) to 5 seconds (max). This dramatically reduces Lambda invocations during
polling storms.

Clients should use the CloudFront URL (CdnUrl output from CDK) as their primary
endpoint. It handles HTTPS termination, DDoS protection, and edge caching.

## JWT Verification

The public key is loaded from the same Secrets Manager secret that holds the private
key. The kid header (vwr-v1) must match. Verification is done using the jose library
with the ES256 algorithm.

## Project structure

```
services/status-api/
  src/
    index.ts    - Lambda handler
    jwt.ts      - JWT verification using public key from Secrets Manager
  package.json
  tsconfig.json
```
