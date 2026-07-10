import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getShardId } from './shard.js';
import { signJwt, JwtPayload } from './jwt.js';

const ddb = new DynamoDBClient();

const TABLE_NAME = process.env.TABLE_NAME!;
const KEY_ID = process.env.KEY_ID!;
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

    // Generate random shard for write distribution
    const shardId = getShardId();

    // Write QueueTicket to DynamoDB
    const pk = `EVENT#${eventId}#SHARD#${shardId}`;
    const sk = `TS#${entryTimestamp}#FAN#${fanId}`;

    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: { S: pk },
        SK: { S: sk },
        FanId: { S: fanId },
        EntryTimestamp: { N: String(entryTimestamp) },
        ShardId: { N: String(shardId) },
        ExpiresAt: { N: String(Math.floor(entryTimestamp / 1000) + JWT_EXPIRY_SECONDS) },
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));

    // Sign JWT with user's queue position
    const now = Math.floor(entryTimestamp / 1000);
    const jwtPayload: JwtPayload = {
      fanId,
      entryTimestamp,
      shardId,
      iat: now,
      exp: now + JWT_EXPIRY_SECONDS,
    };

    const token = await signJwt(jwtPayload, KEY_ID);

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        entryTimestamp,
        shardId,
        queuePosition: null, // Will be computed client-side
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
