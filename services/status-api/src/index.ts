import { DynamoDBClient, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

const ddb = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;
const EVENT_ID = process.env.EVENT_ID || 'default-event';
const CACHE_TTL_MS = 2000;

interface GlobalState {
  admittedUntilTimestamp: number;
  tieBreakerThreshold: number;
  activePurchaserCount: number;
  densityBuckets: Array<{ bucketTs: number; count: number }>;
}

interface CachedState extends GlobalState {
  timestamp: number;
}

const stateCache = new Map<string, CachedState>();

async function queryDensity(eventId: string): Promise<Array<{ bucketTs: number; count: number }>> {
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

  return Array.from(bucketMap.entries())
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
    queryDensity(eventId),
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
  const requestId = event.requestContext?.requestId || 'unknown';
  const baseHeaders = { 'content-type': 'application/json', 'x-request-id': requestId };

  try {
    const eventId = extractEventId(event.rawPath) || EVENT_ID;
    const state = await loadState(eventId);

    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({
        admittedUntilTimestamp: state.admittedUntilTimestamp,
        tieBreakerThreshold: state.tieBreakerThreshold,
        activePurchaserCount: state.activePurchaserCount,
        densityBuckets: state.densityBuckets,
      }),
    };
  } catch (error: any) {
    console.error('Status error:', error);
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
