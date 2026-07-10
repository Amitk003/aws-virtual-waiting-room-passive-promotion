import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

const ddb = new DynamoDBClient();
const TABLE_NAME = requireEnv('TABLE_NAME');
const EVENT_ID = process.env.EVENT_ID || 'default-event';

async function correctCounter(eventId: string): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'SessionMetadataIndex',
    KeyConditionExpression: 'GSIPK = :gsiPk AND ExpiresAt > :now',
    ExpressionAttributeValues: {
      ':gsiPk': { S: `EVENT#${eventId}#SESSION_META` },
      ':now': { N: String(nowSeconds) },
    },
    Select: 'COUNT',
  }));

  const validCount = result.Count ?? 0;

  await ddb.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `EVENT#${eventId}#METADATA` },
      SK: { S: 'METADATA' },
    },
    UpdateExpression: 'SET ActivePurchaserCount = :count',
    ExpressionAttributeValues: {
      ':count': { N: String(validCount) },
    },
  }));

  console.log(`Reconciled ActivePurchaserCount for ${eventId}: ${validCount}`);
}

export async function handler(): Promise<void> {
  await correctCounter(EVENT_ID);
}
