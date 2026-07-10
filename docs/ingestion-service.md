# Ingestion Service

This service handles incoming users and adds them to the queue.

## Endpoint

```
POST /api/v1/event/{eventId}/join
```

### Request

```json
{
  "fanId": "fan_12345"
}
```

### Response (200)

```json
{
  "token": "<JWT token>",
  "entryTimestamp": 1719997205124,
  "shardId": 845,
  "queuePosition": null
}
```

### Response (400)

```json
{
  "error": "fanId is required"
}
```

### Response (409)

```json
{
  "error": "User already in queue"
}
```

## How it works

1. User sends their fan ID (email, username, or internal ID)
2. Lambda gets the current time (microsecond precision via AWS Time Sync)
3. A random shard ID (1-2000) is generated to spread writes across DynamoDB partitions
4. A QueueTicket item is written to DynamoDB
5. A JWT is signed using the KMS asymmetric key (ECC P-256)
6. The JWT contains the fan ID, entry timestamp, and expiration
7. The token is returned to the user for subsequent polling

## Key design points

**Shard distribution**: The partition key uses a random shard suffix (`SHARD#<1-2000>`). This spreads 1M writes/second evenly across DynamoDB partitions (500 writes/sec per partition, well below the 1000 WCU limit).

**JWT signing**: Uses KMS asymmetric key (ECC_NIST_P256) with ES256 algorithm. For production at 1M scale, the private key can be cached from Secrets Manager to avoid KMS API throttling.

**Provisioned Concurrency**: Uncomment the alias block in the CDK stack before the event to pre-warm Lambda containers and eliminate cold starts.

## Local development

```bash
cd services/ingestion/
npm install
npm test
```

## Project structure

```
services/ingestion/
  src/
    index.ts    - Lambda handler
    jwt.ts      - JWT signing
    shard.ts    - Shard calculation
  test/
    ingestion.test.ts
  package.json
  tsconfig.json
```
