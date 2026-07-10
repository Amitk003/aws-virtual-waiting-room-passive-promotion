import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;
const EVENT_ID = process.env.EVENT_ID || 'default-event';

async function correctCounter(eventId: string): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'SessionMetadataIndex',
    KeyConditionExpression: 'GSIPK = :gsiPk',
    ExpressionAttributeValues: {
      ':gsiPk': { S: `EVENT#${eventId}#SESSION_META` },
    },
    ProjectionExpression: 'ExpiresAt',
  }));

  let validCount = 0;
  for (const item of result.Items || []) {
    const expiresAt = Number(item.ExpiresAt?.N || 0);
    if (expiresAt > nowSeconds) {
      validCount++;
    }
  }

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
