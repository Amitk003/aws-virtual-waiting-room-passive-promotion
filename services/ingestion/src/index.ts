import { DynamoDBClient, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getShardId } from './shard.js';
import { signJwt, JwtPayload } from './jwt.js';

const ddb = new DynamoDBClient();

const TABLE_NAME = process.env.TABLE_NAME!;
const SIGNING_SECRET_ID = process.env.SIGNING_SECRET_ID!;
const EVENT_ID = process.env.EVENT_ID || 'default-event';
const JWT_EXPIRY_SECONDS = 3600; // 1 hour

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const eventId = event.pathParameters?.eventId || EVENT_ID;
    const body = JSON.parse(event.body || '{}');
    const fanId: string | undefined = body.fanId;

    if (!fanId) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'fanId is required' }),
      };
    }

    // Get precise timestamp (Lambda system clock is synced via AWS Time Sync Service)
    const entryTimestamp = Date.now();
    const nowSeconds = Math.floor(entryTimestamp / 1000);
    const expirySeconds = nowSeconds + JWT_EXPIRY_SECONDS;

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
                ExpiresAt: { N: String(expirySeconds) },
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
                ExpiresAt: { N: String(expirySeconds) },
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
            headers: { 'content-type': 'application/json' },
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
      exp: expirySeconds,
    };

    const token = await signJwt(jwtPayload, SIGNING_SECRET_ID);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
