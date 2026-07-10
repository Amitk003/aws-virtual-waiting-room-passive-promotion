import { DynamoDBClient, GetItemCommand, DeleteItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createHmac } from 'node:crypto';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { verifyJwt } from './jwt.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

const ddb = new DynamoDBClient();
const sm = new SecretsManagerClient();
const TABLE_NAME = requireEnv('TABLE_NAME');
const SIGNING_SECRET_ID = requireEnv('SIGNING_SECRET_ID');
const EVENT_ID = process.env.EVENT_ID || 'default-event';
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || '300'); // 5 min

let _tiebreakerKey: string | null = null;
async function getTiebreakerKey(): Promise<string> {
  if (_tiebreakerKey) return _tiebreakerKey;
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: SIGNING_SECRET_ID }));
  _tiebreakerKey = resp.SecretString || '';
  return _tiebreakerKey;
}

function computeTiebreakerValue(fanId: string, entryTimestamp: number, key: string): number {
  // HMAC-based tiebreaker: client cannot precompute because the key is
  // server-side only. Incorporates both fanId and entryTimestamp so that
  // two entries by the same fanId get different tiebreaker values.
  const hmac = createHmac('sha256', key);
  hmac.update(`${fanId}:${entryTimestamp}`);
  const digest = hmac.digest();
  return digest.readUInt32BE(0) % 100;
}

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
  tieBreakerThreshold: number,
  tiebreakerValue: number
): boolean {
  const entrySec = Math.floor(entryTimestamp / 1000);
  const admittedSec = Math.floor(admittedUntilTimestamp / 1000);
  if (entrySec < admittedSec) return true;
  if (entrySec === admittedSec) {
    return tiebreakerValue < tieBreakerThreshold;
  }
  return false;
}

function validateFanId(fanId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(fanId);
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext?.requestId || 'unknown';
  const baseHeaders = { 'content-type': 'application/json', 'x-request-id': requestId };

  try {
    const token = extractBearerToken(event);
    if (!token) {
      return {
        statusCode: 401,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Missing or invalid Authorization header' }),
      };
    }

    const jwtPayload = await verifyJwt(token, SIGNING_SECRET_ID);
    const eventId = extractEventId(event.rawPath) || EVENT_ID;
    const fanId = jwtPayload.fanId;

    if (!validateFanId(fanId)) {
      return {
        statusCode: 400,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Invalid fanId in token' }),
      };
    }
    const sessionPk = `EVENT#${eventId}#SESSION#${fanId}`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expirySeconds = nowSeconds + SESSION_TTL_SECONDS;

    const method = event.requestContext.http.method;

    if (method === 'POST' && event.rawPath.includes('/claim')) {
      // Read GlobalState to check admission eligibility
      const globalState = await ddb.send(new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: { S: `EVENT#${eventId}#METADATA` },
          SK: { S: 'METADATA' },
        },
        ProjectionExpression: 'AdmittedUntilTimestamp, TieBreakerThreshold',
      }));

      const admittedUntilTimestamp = Number(globalState.Item?.AdmittedUntilTimestamp?.N || 0);
      const tieBreakerThreshold = Number(globalState.Item?.TieBreakerThreshold?.N || 100);

      const tiebreakerKey = await getTiebreakerKey();
      const tiebreakerValue = computeTiebreakerValue(fanId, jwtPayload.entryTimestamp, tiebreakerKey);
      if (!isAdmitted(jwtPayload.entryTimestamp, admittedUntilTimestamp, fanId, tieBreakerThreshold, tiebreakerValue)) {
        return {
          statusCode: 403,
          headers: baseHeaders,
          body: JSON.stringify({ error: 'You are not eligible to enter checkout yet.' }),
        };
      }

      // Create session item. The admission watermark gates who can claim, so
      // no counter check is needed here. The Promotion Engine continuously
      // reconciles slot capacity via the GSI count and advances the watermark
      // accordingly. Short-lived overshoot (TOCTOU) is bounded and corrected
      // by the 5-min Reconciliation Lambda.
      try {
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
      } catch (err: any) {
        if (err.name === 'ConditionalCheckFailedException') {
          return {
            statusCode: 409,
            headers: baseHeaders,
            body: JSON.stringify({ error: 'Session already exists' }),
          };
        }
        throw err;
      }

      return {
        statusCode: 200,
        headers: baseHeaders,
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

        // Decrement counter only if it is positive.
        // Prevents the counter from going negative due to:
        // - TTL expiry race (TTL fires between DeleteItem and this Update)
        // - Stale /release from before an invalidation
        const decrementResult = await ddb.send(new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: { S: `EVENT#${eventId}#METADATA` },
            SK: { S: 'METADATA' },
          },
          UpdateExpression: 'ADD ActivePurchaserCount :negOne',
          ConditionExpression: 'ActivePurchaserCount > :zero',
          ExpressionAttributeValues: {
            ':negOne': { N: '-1' },
            ':zero': { N: '0' },
          },
        }));
        console.log(JSON.stringify({ event: 'slot_released', requestId, eventId, fanId }));
      } catch (err: any) {
        if (err.name === 'ConditionalCheckFailedException') {
          // Session already deleted (completed, released, or TTL-expired)
          return {
            statusCode: 200,
            headers: baseHeaders,
            body: JSON.stringify({ sessionReleased: true, fanId }),
          };
        }
        throw err;
      }

      return {
        statusCode: 200,
        headers: baseHeaders,
        body: JSON.stringify({ sessionReleased: true, fanId }),
      };
    }

    return {
      statusCode: 405,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  } catch (error: any) {
    if (error.code === 'ERR_JWT_EXPIRED' || error.code === 'ERR_JWS_INVALID') {
      return {
        statusCode: 401,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Invalid or expired token' }),
      };
    }

    console.error(JSON.stringify({ event: 'slot_error', requestId, error: error.message }));
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
