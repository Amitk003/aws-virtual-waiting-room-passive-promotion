import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getShardId } from './shard.js';
import { signJwt, JwtPayload } from './jwt.js';

const ddb = new DynamoDBClient();

const TABLE_NAME = process.env.TABLE_NAME!;
const SIGNING_SECRET_ID = process.env.SIGNING_SECRET_ID!;
const KMS_KEY_ID = process.env.KMS_KEY_ID!;
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

    // Write tracking item to prevent double-join
    // PK contains FanId so each user has exactly one tracking item
    // If Lambda crashes between this write and the QueueTicket write,
    // TTL auto-cleans the orphaned tracking item within 1 hour
    const trackingPk = `EVENT#${eventId}#FAN#${fanId}`;

    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: { S: trackingPk },
        SK: { S: 'PENDING' },
        FanId: { S: fanId },
        ExpiresAt: { N: String(expirySeconds) },
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    // Generate random shard for write distribution
    const shardId = getShardId();

    // Write QueueTicket to DynamoDB
    const queuePk = `EVENT#${eventId}#SHARD#${shardId}`;
    const queueSk = `TS#${entryTimestamp}#FAN#${fanId}`;

    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: { S: queuePk },
        SK: { S: queueSk },
        FanId: { S: fanId },
        EntryTimestamp: { N: String(entryTimestamp) },
        ShardId: { N: String(shardId) },
        ExpiresAt: { N: String(expirySeconds) },
      },
    }));

    // Sign JWT locally using cached ECC key (no KMS call in hot path)
    const jwtPayload: JwtPayload = {
      fanId,
      entryTimestamp,
      shardId,
      iat: nowSeconds,
      exp: expirySeconds,
    };

    const token = await signJwt(jwtPayload, SIGNING_SECRET_ID, KMS_KEY_ID);

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

    if (error.name === 'ConditionalCheckFailedException') {
      return {
        statusCode: 409,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'User already in queue' }),
      };
    }

    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
