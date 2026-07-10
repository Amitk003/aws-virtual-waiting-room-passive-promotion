import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { verifyJwt, JwtPayload } from './jwt.js';

const ddb = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;
const SIGNING_SECRET_ID = process.env.SIGNING_SECRET_ID!;
const EVENT_ID = process.env.EVENT_ID || 'default-event';
const DENSITY_SHARD_COUNT = 20;

// Global-scope in-memory cache: the density map and GlobalState are
// identical for all users in the same event. This avoids hammering
// DynamoDB with 20 queries per request.
const CACHE_TTL_MS = 2000;

interface CachedState {
  timestamp: number;
  admittedUntilTimestamp: number;
  tieBreakerThreshold: number;
  activePurchaserCount: number;
  densityBuckets: DensityBucket[];
}

interface DensityBucket {
  bucketTs: number;
  count: number;
}

const stateCache = new Map<string, CachedState>();

function extractBearerToken(event: APIGatewayProxyEventV2): string | null {
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  const parts = auth.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  }
  return null;
}

async function queryDensityShards(eventId: string): Promise<DensityBucket[]> {
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

  const buckets: DensityBucket[] = [];
  for (const result of results) {
    for (const item of result.Items || []) {
      const sk = item.SK?.S || '';
      const count = Number(item.Count?.N || 0);
      const bucketTs = parseInt(sk.replace('BUCKET#', ''));
      if (!isNaN(bucketTs)) {
        buckets.push({ bucketTs, count });
      }
    }
  }

  const merged = new Map<number, number>();
  for (const b of buckets) {
    merged.set(b.bucketTs, (merged.get(b.bucketTs) || 0) + b.count);
  }

  return Array.from(merged.entries())
    .map(([bucketTs, count]) => ({ bucketTs, count }))
    .sort((a, b) => a.bucketTs - b.bucketTs);
}

async function loadState(eventId: string): Promise<CachedState> {
  const cached = stateCache.get(eventId);
  const now = Date.now();

  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached;
  }

  const [globalState, densityBuckets] = await Promise.all([
    ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `EVENT#${eventId}#METADATA` },
        SK: { S: 'METADATA' },
      },
      ProjectionExpression: 'AdmittedUntilTimestamp, ActivePurchaserCount, TieBreakerThreshold',
    })),
    queryDensityShards(eventId),
  ]);

  const state: CachedState = {
    timestamp: now,
    admittedUntilTimestamp: Number(globalState.Item?.AdmittedUntilTimestamp?.N || 0),
    tieBreakerThreshold: Number(globalState.Item?.TieBreakerThreshold?.N || 100),
    activePurchaserCount: Number(globalState.Item?.ActivePurchaserCount?.N || 0),
    densityBuckets,
  };

  stateCache.set(eventId, state);
  return state;
}

function calculateQueuePosition(
  densityBuckets: DensityBucket[],
  entryTimestamp: number
): number {
  let position = 0;
  const entrySec = Math.floor(entryTimestamp / 1000);
  for (const bucket of densityBuckets) {
    if (bucket.bucketTs < entrySec) {
      position += bucket.count;
    } else {
      break;
    }
  }
  return position;
}

function estimateWaitSeconds(
  queuePosition: number,
  activePurchaserCount: number
): number | null {
  if (queuePosition <= 0) return 0;
  const completionRatePerSec = Math.max(activePurchaserCount * 0.01, 1);
  return Math.ceil(queuePosition / completionRatePerSec);
}

function hashCodeFanId(fanId: string): number {
  let hash = 0;
  for (let i = 0; i < fanId.length; i++) {
    const char = fanId.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function isAdmitted(
  entryTimestamp: number,
  admittedUntilTimestamp: number,
  fanId: string,
  tieBreakerThreshold: number
): boolean {
  if (entryTimestamp < admittedUntilTimestamp) return true;
  if (entryTimestamp === admittedUntilTimestamp) {
    return hashCodeFanId(fanId) % 100 < tieBreakerThreshold;
  }
  return false;
}

function extractEventId(path: string): string | null {
  const parts = path.split('/');
  const idx = parts.indexOf('event');
  if (idx >= 0 && idx + 1 < parts.length) {
    return parts[idx + 1];
  }
  return null;
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const token = extractBearerToken(event);
    if (!token) {
      return {
        statusCode: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Missing or invalid Authorization header' }),
      };
    }

    const jwtPayload: JwtPayload = await verifyJwt(token, SIGNING_SECRET_ID);
    const eventId = extractEventId(event.rawPath) || EVENT_ID;

    const state = await loadState(eventId);
    const admitted = isAdmitted(jwtPayload.entryTimestamp, state.admittedUntilTimestamp, jwtPayload.fanId, state.tieBreakerThreshold);

    if (admitted) {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          admitted: true,
          fanId: jwtPayload.fanId,
          entryTimestamp: jwtPayload.entryTimestamp,
          admittedUntilTimestamp: state.admittedUntilTimestamp,
          activePurchaserCount: state.activePurchaserCount,
        }),
      };
    }

    const queuePosition = calculateQueuePosition(state.densityBuckets, jwtPayload.entryTimestamp);
    const estimatedWaitSeconds = estimateWaitSeconds(queuePosition, state.activePurchaserCount);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        admitted: false,
        fanId: jwtPayload.fanId,
        entryTimestamp: jwtPayload.entryTimestamp,
        admittedUntilTimestamp: state.admittedUntilTimestamp,
        queuePosition,
        estimatedWaitSeconds,
        activePurchaserCount: state.activePurchaserCount,
      }),
    };
  } catch (error: any) {
    if (error.code === 'ERR_JWT_EXPIRED' || error.code === 'ERR_JWS_INVALID') {
      return {
        statusCode: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid or expired token' }),
      };
    }

    console.error('Status error:', error);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
