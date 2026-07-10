import { DynamoDBClient, PutItemCommand, DeleteItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { verifyJwt } from './jwt.js';

const ddb = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;
const SIGNING_SECRET_ID = process.env.SIGNING_SECRET_ID!;
const EVENT_ID = process.env.EVENT_ID || 'default-event';
const SESSION_TTL_SECONDS = 300; // 5 min

function extractBearerToken(event: APIGatewayProxyEventV2): string | null {
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  const parts = auth.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  }
  return null;
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

    const jwtPayload = await verifyJwt(token, SIGNING_SECRET_ID);
    const eventId = extractEventId(event.rawPath) || EVENT_ID;
    const fanId = jwtPayload.fanId;
    const sessionPk = `EVENT#${eventId}#SESSION#${fanId}`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expirySeconds = nowSeconds + SESSION_TTL_SECONDS;

    const method = event.requestContext.http.method;

    if (method === 'POST' && event.rawPath.includes('/claim')) {
      // Create session item
      await ddb.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: { S: sessionPk },
          SK: { S: 'SESSION' },
          GSIPK: { S: `EVENT#${eventId}#SESSION_META` },
          FanId: { S: fanId },
          StartedAt: { N: String(nowSeconds) },
          ExpiresAt: { N: String(expirySeconds) },
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }));

      // Increment counter, capped at 1000
      // If counter hits 1000, the condition fails and we rollback
      try {
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: { S: `EVENT#${eventId}#METADATA` },
            SK: { S: 'METADATA' },
          },
          UpdateExpression: 'ADD ActivePurchaserCount :one',
          ConditionExpression: 'ActivePurchaserCount < :max OR attribute_not_exists(ActivePurchaserCount)',
          ExpressionAttributeValues: {
            ':one': { N: '1' },
            ':max': { N: '1000' },
          },
        }));
      } catch (err: any) {
        // Counter at 1000 — rollback session item
        await ddb.send(new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: { S: sessionPk },
            SK: { S: 'SESSION' },
          },
        }));

        if (err.name === 'ConditionalCheckFailedException') {
          return {
            statusCode: 429,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: 'All checkout slots are full. Try again shortly.' }),
          };
        }
        throw err;
      }

      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionStarted: true,
          fanId,
          expiresAt: expirySeconds,
        }),
      };
    }

    if (method === 'POST' && event.rawPath.includes('/release')) {
      // Conditional delete: only succeed if the session item exists.
      // Prevents double-decrement from:
      // 1. Duplicate /release requests (delete succeeds twice)
      // 2. TTL expiry race (TTL deletes item + aggregator decrements,
      //    then stale client /release decrements again)
      try {
        await ddb.send(new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: { S: sessionPk },
            SK: { S: 'SESSION' },
          },
          ConditionExpression: 'attribute_exists(PK)',
        }));

        // Only decrement if the item was actually deleted
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: { S: `EVENT#${eventId}#METADATA` },
            SK: { S: 'METADATA' },
          },
          UpdateExpression: 'ADD ActivePurchaserCount :negOne',
          ExpressionAttributeValues: {
            ':negOne': { N: '-1' },
          },
        }));
      } catch (err: any) {
        if (err.name === 'ConditionalCheckFailedException') {
          // Session already deleted (completed, released, or TTL-expired)
          return {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionReleased: true, fanId }),
          };
        }
        throw err;
      }

      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionReleased: true, fanId }),
      };
    }

    return {
      statusCode: 405,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  } catch (error: any) {
    if (error.code === 'ERR_JWT_EXPIRED' || error.code === 'ERR_JWS_INVALID') {
      return {
        statusCode: 401,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid or expired token' }),
      };
    }

    if (error.name === 'ConditionalCheckFailedException') {
      return {
        statusCode: 409,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'Session already exists' }),
      };
    }

    console.error('Slot handler error:', error);
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
