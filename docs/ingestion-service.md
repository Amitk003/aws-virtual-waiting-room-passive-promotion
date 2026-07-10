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

1. User sends their fan ID
2. Lambda writes a tracking item (PK = `EVENT#<id>#FAN#<fanId>`) to prevent double-join
3. If tracking item write fails (user already exists), returns 409
4. Lambda gets the current time (microsecond precision via AWS Time Sync)
5. A random shard ID (1-2000) is generated to spread writes across DynamoDB partitions
6. A QueueTicket item is written to DynamoDB with sharded PK
7. A JWT is signed locally using the ECC P-256 key (cached in memory from Secrets Manager)
8. The JWT is returned to the user for subsequent polling

## Key design points

**Double-join prevention**: A tracking item is written first with PK = `EVENT#<eventId>#FAN#<fanId>`. If the user already has a tracking item, the write fails and they get a 409 response. The tracking item has an ExpiresAt TTL so orphaned items (from Lambda crashes between the two writes) auto-expire.

**Shard distribution**: The QueueTicket partition key uses a random shard suffix (`SHARD#<1-2000>`). This spreads 1M writes/second evenly across DynamoDB partitions (500 writes/sec per partition, well below the 1000 WCU limit).

**JWT signing (local, no KMS API call)**: The ECC P-256 private key is stored in AWS Secrets Manager. The Lambda fetches the key once at cold start and caches it in memory. All subsequent invocations sign JWTs locally using the `jose` library. This avoids KMS API throttling at 1M requests/sec. KMS is only used for `GetPublicKey` (retrieving the public key for edge authorizers).

**JWT format**: ES256 algorithm (ECDSA P-256). The `kid` header contains the KMS key ID so edge verifiers can fetch the matching public key.

**Provisioned Concurrency**: Uncomment the alias block in the CDK stack before the event to pre-warm Lambda containers and eliminate cold starts.

## Deployment steps

After first `cdk deploy`, you need to populate the signing key:

```bash
node scripts/generate-key.js <SigningSecretName>
```

This generates an ECC P-256 key pair and stores the private key in Secrets Manager.

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
    jwt.ts      - JWT signing (local jose library, no KMS in hot path)
    shard.ts    - Shard calculation
  test/
    ingestion.test.ts
  package.json
  tsconfig.json
```
