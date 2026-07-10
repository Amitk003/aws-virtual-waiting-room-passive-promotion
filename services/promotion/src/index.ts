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

  // Density map is sharded across 10 sub-partitions. Read all in parallel.
  const densityPks = Array.from({ length: 10 }, (_, i) => `EVENT#${eventId}#DENSITY#SHARD#${i}`);

  const results = await Promise.all(densityPks.map(pk =>
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': { S: pk },
        ':prefix': { S: 'BUCKET#' },
      },
      ProjectionExpression: 'SK, #count',
      ExpressionAttributeNames: { '#count': 'Count' },
    }))
  ));

  const bucketMap = new Map<number, number>();
  for (const result of results) {
    for (const item of result.Items || []) {
      const sk = item.SK?.S || '';
      const count = Number(item.Count?.N || 0);
      const bucketTs = parseInt(sk.replace('BUCKET#', ''));
      if (!isNaN(bucketTs)) {
        bucketMap.set(bucketTs, (bucketMap.get(bucketTs) || 0) + count);
      }
    }
  }

  const buckets = Array.from(bucketMap.entries())
    .map(([bucketTs, count]) => ({ bucketTs, count }))
    .sort((a, b) => a.bucketTs - b.bucketTs);

  densityCache = { timestamp: now, buckets };
  return buckets;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function handler(): Promise<void> {
  // EventBridge minimum rate is 1 minute, so we loop internally to
  // advance the watermark multiple times per invocation.
  // Timeout is 5s, giving us ~4 iterations at 1s intervals.
  const startTime = Date.now();
  const timeoutMs = 59000;
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

    // Query GSI for active (non-expired) sessions only.
    // Since ExpiresAt is now the GSI sort key, the condition
    // ExpiresAt > :now filters out expired sessions at the DB level.
    // With max 1000 active sessions, the query never needs pagination.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const sessionQuery = await ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'SessionMetadataIndex',
      KeyConditionExpression: 'GSIPK = :gsiPk AND ExpiresAt > :now',
      ExpressionAttributeValues: {
        ':gsiPk': { S: `EVENT#${EVENT_ID}#SESSION_META` },
        ':now': { N: String(nowSeconds) },
      },
      Select: 'COUNT',
    }));

    const validSessionCount = sessionQuery.Count ?? 0;
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
