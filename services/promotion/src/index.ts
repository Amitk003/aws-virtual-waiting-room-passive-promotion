import { DynamoDBClient, GetItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

const ddb = new DynamoDBClient();
const TABLE_NAME = requireEnv('TABLE_NAME');
const EVENT_ID = process.env.EVENT_ID || 'default-event';
const MAX_SLOTS = Number(process.env.MAX_SLOTS || '1000');
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || '2000');

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
  const startTime = Date.now();
  const timeoutMs = 59000;

  while (Date.now() - startTime < timeoutMs) {
    const globalState = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `EVENT#${EVENT_ID}#METADATA` },
        SK: { S: 'METADATA' },
      },
      ProjectionExpression: 'AdmittedUntilTimestamp, PartialAdmittedBucket, AdmittedFromBucket',
    }));

    const admittedUntilTimestamp = Number(globalState.Item?.AdmittedUntilTimestamp?.N || 0);
    const partialBucket = Number(globalState.Item?.PartialAdmittedBucket?.N || 0);
    const admittedFromBucket = Number(globalState.Item?.AdmittedFromBucket?.N || 0);

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

    const densityBuckets = await loadDensity(EVENT_ID);
    const currentWatermarkSec = Math.floor(admittedUntilTimestamp / 1000);

    let slotsFilled = 0;
    let newWatermarkSec = currentWatermarkSec;
    let tieBreakerThreshold: number | null = null;
    let partialBucketCount: number | null = null;

    for (const bucket of densityBuckets) {
      // Skip fully-admitted buckets. Re-process a partially-admitted bucket
      // by calculating remaining users from the stored count.
      if (bucket.bucketTs < currentWatermarkSec) continue;
      if (bucket.bucketTs === currentWatermarkSec && bucket.bucketTs !== partialBucket) continue;

      let effectiveCount = bucket.count;
      if (bucket.bucketTs === partialBucket) {
        // This bucket was partially admitted in a prior iteration.
        // Only the remaining users (not yet admitted) count toward freeSlots.
        effectiveCount = Math.max(0, bucket.count - admittedFromBucket);
      }

      const remaining = freeSlots - slotsFilled;
      if (remaining <= 0) break;

      const toAdmit = Math.min(effectiveCount, remaining);

      if (toAdmit < effectiveCount) {
        tieBreakerThreshold = Math.ceil((toAdmit / effectiveCount) * 100);
        if (tieBreakerThreshold < 1) tieBreakerThreshold = 1;
        if (tieBreakerThreshold > 99) tieBreakerThreshold = 99;
        newWatermarkSec = bucket.bucketTs;
        slotsFilled += toAdmit;
        partialBucketCount = (bucket.bucketTs === partialBucket ? admittedFromBucket : 0) + toAdmit;
        break;
      }

      slotsFilled += toAdmit;
      if (bucket.bucketTs > newWatermarkSec) {
        newWatermarkSec = bucket.bucketTs;
      }
      partialBucketCount = null;

      if (slotsFilled >= freeSlots) break;
    }

    const newWatermarkMs = newWatermarkSec * 1000;
    const isWatermarkAdvancing = newWatermarkMs > admittedUntilTimestamp;
    const isPartialBucketProgressing = newWatermarkMs === admittedUntilTimestamp &&
      (partialBucketCount === null ? (partialBucket !== 0) : (partialBucketCount > admittedFromBucket));

    if (isWatermarkAdvancing || isPartialBucketProgressing) {
      let updateExpression = 'SET AdmittedUntilTimestamp = :newWatermark, TieBreakerThreshold = :threshold';
      const expressionAttributeValues: Record<string, any> = {
        ':newWatermark': { N: String(newWatermarkMs) },
        ':threshold': { N: String(tieBreakerThreshold ?? 100) },
      };

      if (partialBucketCount !== null) {
        updateExpression += ', PartialAdmittedBucket = :partialBucket, AdmittedFromBucket = :admittedCount';
        expressionAttributeValues[':partialBucket'] = { N: String(newWatermarkSec) };
        expressionAttributeValues[':admittedCount'] = { N: String(partialBucketCount) };
      } else {
        updateExpression += ', PartialAdmittedBucket = :zero, AdmittedFromBucket = :zero';
        expressionAttributeValues[':zero'] = { N: '0' };
      }

      await ddb.send(new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: { S: `EVENT#${EVENT_ID}#METADATA` },
          SK: { S: 'METADATA' },
        },
        UpdateExpression: updateExpression,
        ConditionExpression: 'attribute_not_exists(AdmittedUntilTimestamp) OR AdmittedUntilTimestamp < :newWatermark OR (AdmittedUntilTimestamp = :newWatermark AND (AdmittedFromBucket < :newAdmittedCount OR PartialAdmittedBucket <> :zero))',
        ExpressionAttributeValues: {
          ...expressionAttributeValues,
          ':newAdmittedCount': { N: String(partialBucketCount ?? 0) },
          ':zero': { N: '0' },
        },
      }));

      console.log(JSON.stringify({
        event: 'promotion',
        slotsFilled,
        freeSlots,
        watermarkBefore: admittedUntilTimestamp,
        watermarkAfter: newWatermarkMs,
        threshold: tieBreakerThreshold ?? 100,
      }));
    }

    await sleep(1000);
  }
}
