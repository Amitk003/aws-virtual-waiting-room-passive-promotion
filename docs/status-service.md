# Status Polling Service

This service returns the global waiting-room state (watermark, tiebreaker, density).
Admission evaluation, queue position, and EWT are computed **client-side** by
comparing the user's JWT (entryTimestamp, shardId) against the cached global state.

## Endpoint

```
GET /api/v1/event/{eventId}/status
```

No authentication required. The response is cached at the CloudFront edge with a
**global cache key** (no Authorization header), achieving ~99.9999% cache hit rate.

### Response (200)

```json
{
  "admittedUntilTimestamp": 1719997202000,
  "tieBreakerThreshold": 100,
  "densityBuckets": [
    { "bucketTs": 1719997199, "count": 14820 },
    { "bucketTs": 1719997200, "count": 15000 }
  ]
}
```

| Field | Description |
|-------|-------------|
| `admittedUntilTimestamp` | Watermark in ms — users with entryTimestamp < this are fully admitted |
| `tieBreakerThreshold` | 0-100 — users whose HMAC-tiebreaker value < this are admitted at the watermark boundary |
| `densityBuckets` | Per-second density histogram for queue-position calculation |

## Client-side admission algorithm

```typescript
const jwt = decodeJwt(token); // fanId, entryTimestamp, shardId
const status = await fetch('/api/v1/event/{eventId}/status').then(r => r.json());

const entrySec = Math.floor(jwt.entryTimestamp / 1000);
const admittedSec = Math.floor(status.admittedUntilTimestamp / 1000);

if (entrySec < admittedSec) {
  // Fully admitted — call /claim
} else if (entrySec === admittedSec) {
  // Tiebreaker zone — call /claim, server decides
} else {
  // Waiting — estimate position from densityBuckets
}
```

The HMAC tiebreaker value cannot be computed client-side (server holds the key).
Client-side users at the watermark boundary must call /claim to learn their
admission status.

## CloudFront CDN

CloudFront sits in front of API Gateway. The status endpoint uses a **global cache
key** (no Authorization header). Cache TTL: 2s default, 5s max. All users share
the same cached response, so 10M concurrent pollers result in ~2 Lambda invocations
per second instead of millions.

Clients should use the CloudFront URL (CdnUrl output from CDK) as their primary
endpoint.

## Rationale

The original design performed per-user admission on the server, requiring JWT
verification on every poll. This made the response uncacheable (Authorization
header in cache key), causing 0% CDN hit rate and ~$40K/month Lambda costs for
10M concurrent users. Moving admission logic to the client eliminates this
bottleneck.

## Project structure

```
services/status-api/
  src/
    index.ts    - Lambda handler (global state, no JWT)
    jwt.ts      - Unused (kept for reference)
  package.json
  tsconfig.json
```
