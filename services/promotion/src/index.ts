import { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;
const EVENT_ID = process.env.EVENT_ID || 'default-event';
const MAX_SLOTS = 1000;
const DENSITY_SHARD_COUNT = 20;

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

  const results = await Promise.all(
    Array.from({ length: DENSITY_SHARD_COUNT }, (_, i) =>
      ddb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': { S: `EVENT#${eventId}#DENSITY#SHARD#${i + 1}` },
          ':prefix': { S: 'BUCKET#' },
        },
        ProjectionExpression: 'SK, #count',
        ExpressionAttributeNames: { '#count': 'Count' },
      }))
    )
  );

  const merged = new Map<number, number>();
  for (const result of results) {
    for (const item of result.Items || []) {
      const sk = item.SK?.S || '';
      const count = Number(item.Count?.N || 0);
      const bucketTs = parseInt(sk.replace('BUCKET#', ''));
      if (!isNaN(bucketTs)) {
        merged.set(bucketTs, (merged.get(bucketTs) || 0) + count);
      }
    }
  }

  const buckets = Array.from(merged.entries())
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
  const timeoutMs = 58000;
  let iteration = 0;

  while (Date.now() - startTime < timeoutMs) {
    iteration++;

    // Read current global state
    const globalState = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `EVENT#${EVENT_ID}#METADATA` },
        SK: { S: 'METADATA' },
      },
      ProjectionExpression: 'ActivePurchaserCount, AdmittedUntilTimestamp',
    }));

    const activePurchaserCount = Number(globalState.Item?.ActivePurchaserCount?.N || 0);
    const admittedUntilTimestamp = Number(globalState.Item?.AdmittedUntilTimestamp?.N || 0);

    const freeSlots = MAX_SLOTS - activePurchaserCount;
    if (freeSlots <= 0) {
      await sleep(1000);
      continue;
    }

    // Load density map (cached for 2s) and walk forward from watermark
    const densityBuckets = await loadDensity(EVENT_ID);
    const currentWatermarkSec = Math.floor(admittedUntilTimestamp / 1000);

    let slotsFilled = 0;
    let newWatermarkSec = currentWatermarkSec;

    for (const bucket of densityBuckets) {
      if (bucket.bucketTs <= currentWatermarkSec) continue;

      const remaining = freeSlots - slotsFilled;
      if (remaining <= 0) break;

      const toAdmit = Math.min(bucket.count, remaining);
      slotsFilled += toAdmit;

      if (slotsFilled > 0 && bucket.bucketTs > newWatermarkSec) {
        newWatermarkSec = bucket.bucketTs;
      }

      if (slotsFilled >= freeSlots) break;
    }

    const newWatermarkMs = newWatermarkSec * 1000;
    if (newWatermarkMs > admittedUntilTimestamp) {
      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: { S: `EVENT#${EVENT_ID}#METADATA` },
          SK: { S: 'METADATA' },
        },
        UpdateExpression: 'SET AdmittedUntilTimestamp = :newWatermark',
        ConditionExpression: 'attribute_not_exists(AdmittedUntilTimestamp) OR AdmittedUntilTimestamp < :newWatermark',
        ExpressionAttributeValues: {
          ':newWatermark': { N: String(newWatermarkMs) },
        },
      }));

      console.log(
        `Promoted ${slotsFilled} users into ${freeSlots} slots. Watermark: ${admittedUntilTimestamp} → ${newWatermarkMs}`
      );
    }

    await sleep(1000);
  }
}
