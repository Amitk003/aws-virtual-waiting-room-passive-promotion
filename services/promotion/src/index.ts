import { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;
const EVENT_ID = process.env.EVENT_ID || 'default-event';
const MAX_SLOTS = 1000;

// In-memory cache: density map is read once per 2s and reused across
// rapid 1s Lambda invocations.
const CACHE_TTL_MS = 2000;

interface CachedDensity {
  timestamp: number;
  buckets: Array<{ bucketTs: number; count: number }>;
}

let densityCache: CachedDensity | null = null;

async function loadDensity(eventId: string): Promise<CachedDensity['buckets']> {
  const now = Date.now();

  if (densityCache && now - densityCache.timestamp < CACHE_TTL_MS) {
    return densityCache.buckets;
  }

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk': { S: `EVENT#${eventId}#DENSITY` },
      ':prefix': { S: 'BUCKET#' },
    },
    ProjectionExpression: 'SK, #count',
    ExpressionAttributeNames: { '#count': 'Count' },
  }));

  const buckets: Array<{ bucketTs: number; count: number }> = [];
  for (const item of result.Items || []) {
    const sk = item.SK?.S || '';
    const count = Number(item.Count?.N || 0);
    const bucketTs = parseInt(sk.replace('BUCKET#', ''));
    if (!isNaN(bucketTs)) {
      buckets.push({ bucketTs, count });
    }
  }

  buckets.sort((a, b) => a.bucketTs - b.bucketTs);

  densityCache = { timestamp: now, buckets };
  return buckets;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function handler(): Promise<void> {
  // EventBridge minimum rate is 1 minute, so we loop internally to
  // advance the watermark multiple times per invocation.
  // Timeout is 5s, giving us ~4 iterations at 1s intervals.
  const startTime = Date.now();
  const timeoutMs = 58000;
  let iteration = 0;

  while (Date.now() - startTime < timeoutMs) {
    iteration++;

    // Read current global state (watermark only — session count is computed below)
    const globalState = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `EVENT#${EVENT_ID}#METADATA` },
        SK: { S: 'METADATA' },
      },
      ProjectionExpression: 'AdmittedUntilTimestamp',
    }));

    const admittedUntilTimestamp = Number(globalState.Item?.AdmittedUntilTimestamp?.N || 0);

    // Query GSI to count valid (non-expired) sessions
    // Expired sessions are not deleted here — they are left for DynamoDB TTL
    // to remove asynchronously. TTL-driven REMOVE events are handled by the
    // Stream Aggregator which conditionally decrements the counter.
    // By counting only valid sessions and SET-ing the counter, we avoid the
    // double-decrement race that would occur if we both deleted items here
    // and relied on the stream aggregator.
    const sessionQuery = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'SessionMetadataIndex',
      KeyConditionExpression: 'GSIPK = :gsiPk',
      ExpressionAttributeValues: {
        ':gsiPk': { S: `EVENT#${EVENT_ID}#SESSION_META` },
      },
      ProjectionExpression: 'ExpiresAt',
    }));

    const nowSeconds = Math.floor(Date.now() / 1000);
    let validSessionCount = 0;
    for (const item of sessionQuery.Items || []) {
      const expiresAt = Number(item.ExpiresAt?.N || 0);
      if (expiresAt > nowSeconds) {
        validSessionCount++;
      }
    }

    // Sync counter to the real count every iteration
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `EVENT#${EVENT_ID}#METADATA` },
        SK: { S: 'METADATA' },
      },
      UpdateExpression: 'SET ActivePurchaserCount = :count',
      ExpressionAttributeValues: {
        ':count': { N: String(validSessionCount) },
      },
    }));

    const freeSlots = MAX_SLOTS - validSessionCount;
    if (freeSlots <= 0) {
      await sleep(1000);
      continue;
    }

    // Load density map (cached for 2s) and walk forward from watermark
    const densityBuckets = await loadDensity(EVENT_ID);
    const currentWatermarkSec = Math.floor(admittedUntilTimestamp / 1000);

    let slotsFilled = 0;
    let newWatermarkSec = currentWatermarkSec;
    let tieBreakerThreshold: number | null = null;

    for (const bucket of densityBuckets) {
      if (bucket.bucketTs <= currentWatermarkSec) continue;

      const remaining = freeSlots - slotsFilled;
      if (remaining <= 0) break;

      const toAdmit = Math.min(bucket.count, remaining);

      if (toAdmit < bucket.count) {
        // Partial bucket: set tie-breaker threshold so only a fraction
        // of users in this second are eligible to claim a slot.
        // hash(fanId) % 100 < TieBreakerThreshold gates admission.
        tieBreakerThreshold = Math.ceil((toAdmit / bucket.count) * 100);
        if (tieBreakerThreshold < 1) tieBreakerThreshold = 1;
        if (tieBreakerThreshold > 99) tieBreakerThreshold = 99;
        newWatermarkSec = bucket.bucketTs;
        slotsFilled += toAdmit;
        break;
      }

      slotsFilled += toAdmit;
      if (bucket.bucketTs > newWatermarkSec) {
        newWatermarkSec = bucket.bucketTs;
      }

      if (slotsFilled >= freeSlots) break;
    }

    const newWatermarkMs = newWatermarkSec * 1000;
    if (newWatermarkMs > admittedUntilTimestamp) {
      let updateExpression = 'SET AdmittedUntilTimestamp = :newWatermark';
      const expressionAttributeValues: Record<string, any> = {
        ':newWatermark': { N: String(newWatermarkMs) },
      };

      if (tieBreakerThreshold !== null) {
        updateExpression += ', TieBreakerThreshold = :threshold';
        expressionAttributeValues[':threshold'] = { N: String(tieBreakerThreshold) };
      }

      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: { S: `EVENT#${EVENT_ID}#METADATA` },
          SK: { S: 'METADATA' },
        },
        UpdateExpression: updateExpression,
        ConditionExpression: 'attribute_not_exists(AdmittedUntilTimestamp) OR AdmittedUntilTimestamp < :newWatermark',
        ExpressionAttributeValues: expressionAttributeValues,
      }));

      const thresholdMsg = tieBreakerThreshold !== null ? `, threshold=${tieBreakerThreshold}%` : '';
      console.log(
        `Promoted ${slotsFilled} users into ${freeSlots} slots. Watermark: ${admittedUntilTimestamp} → ${newWatermarkMs}${thresholdMsg}`
      );
    }

    await sleep(1000);
  }
}
