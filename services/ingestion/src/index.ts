import { DynamoDBClient, TransactWriteItemsCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getShardId } from './shard.js';
import { signJwt, JwtPayload } from './jwt.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

const ddb = new DynamoDBClient();

const TABLE_NAME = requireEnv('TABLE_NAME');
const SIGNING_SECRET_ID = requireEnv('SIGNING_SECRET_ID');
const EVENT_ID = process.env.EVENT_ID || 'default-event';
const JWT_EXPIRY_SECONDS = 3600; // 1 hour
const QUEUE_TTL_SECONDS = 86400; // 24 hours — data persists beyond JWT expiry

function validateFanId(fanId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(fanId);
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext?.requestId || 'unknown';
  const baseHeaders = { 'content-type': 'application/json', 'x-request-id': requestId };

  try {
    const eventId = event.pathParameters?.eventId || EVENT_ID;
    const body = JSON.parse(event.body || '{}');
    const fanId: string | undefined = body.fanId;

    if (!fanId) {
      return {
        statusCode: 400,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'fanId is required' }),
      };
    }

    if (!validateFanId(fanId)) {
      return {
        statusCode: 400,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Invalid fanId format' }),
      };
    }

    // If this is a rejoin request, look up existing QueueTicket and re-sign JWT
    if (event.rawPath?.includes('/rejoin')) {
      const trackingResult = await ddb.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: { S: `EVENT#${eventId}#FAN#${fanId}` },
          SK: { S: 'PENDING' },
        },
        ProjectionExpression: 'EntryTimestamp, ShardId',
      }));

      const storedEntryTimestamp = trackingResult.Item?.EntryTimestamp?.N;
      const storedShardId = trackingResult.Item?.ShardId?.N;

      if (!storedEntryTimestamp || !storedShardId) {
        return {
          statusCode: 404,
          headers: baseHeaders,
          body: JSON.stringify({ error: 'No existing queue entry found. Use /join instead.' }),
        };
      }

      const newJwtPayload: JwtPayload = {
        fanId,
        entryTimestamp: parseInt(storedEntryTimestamp),
        shardId: parseInt(storedShardId),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS,
      };

      const newToken = await signJwt(newJwtPayload, SIGNING_SECRET_ID);

      return {
        statusCode: 200,
        headers: baseHeaders,
        body: JSON.stringify({
          token: newToken,
          entryTimestamp: parseInt(storedEntryTimestamp),
          shardId: parseInt(storedShardId),
          queuePosition: null,
        }),
      };
    }

    // Get precise timestamp via system clock
    const entryTimestamp = Date.now();
    const nowSeconds = Math.floor(entryTimestamp / 1000);
    const jwtExpiry = nowSeconds + JWT_EXPIRY_SECONDS;
    const queueTtl = nowSeconds + QUEUE_TTL_SECONDS;

    // Atomically write tracking item + QueueTicket via transaction.
    // If the tracking item already exists, the entire transaction fails
    // and the user gets a 409 — no partial state, no orphaned items.
    const shardId = getShardId();
    const trackingPk = `EVENT#${eventId}#FAN#${fanId}`;
    const queuePk = `EVENT#${eventId}#SHARD#${shardId}`;
    const queueSk = `TS#${entryTimestamp}#FAN#${fanId}`;

    try {
      await ddb.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: { S: trackingPk },
                SK: { S: 'PENDING' },
                FanId: { S: fanId },
                EntryTimestamp: { N: String(entryTimestamp) },
                ShardId: { N: String(shardId) },
                ExpiresAt: { N: String(queueTtl) },
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: TABLE_NAME,
              Item: {
                PK: { S: queuePk },
                SK: { S: queueSk },
                FanId: { S: fanId },
                EntryTimestamp: { N: String(entryTimestamp) },
                ShardId: { N: String(shardId) },
                ExpiresAt: { N: String(queueTtl) },
              },
            },
          },
        ],
      }));
    } catch (err: any) {
      if (err.name === 'TransactionCanceledException') {
        const reasons = err.CancellationReasons || [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') {
          return {
            statusCode: 409,
            headers: baseHeaders,
            body: JSON.stringify({ error: 'User already in queue' }),
          };
        }
      }
      throw err;
    }

    // Sign JWT locally using cached ECC key
    const jwtPayload: JwtPayload = {
      fanId,
      entryTimestamp,
      shardId,
      iat: nowSeconds,
      exp: jwtExpiry,
    };

    const token = await signJwt(jwtPayload, SIGNING_SECRET_ID);

    return {
      statusCode: 200,
      headers: baseHeaders,
      body: JSON.stringify({
        token,
        entryTimestamp,
        shardId,
        queuePosition: null,
      }),
    };
  } catch (error: any) {
    console.error('Ingestion error:', error);

    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
