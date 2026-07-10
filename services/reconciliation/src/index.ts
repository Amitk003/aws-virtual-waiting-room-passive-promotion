import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;
const EVENT_ID = process.env.EVENT_ID || 'default-event';

async function correctCounter(eventId: string): Promise<void> {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'SessionMetadataIndex',
    KeyConditionExpression: 'GSIPK = :gsiPk',
    ExpressionAttributeValues: {
      ':gsiPk': { S: `EVENT#${eventId}#SESSION_META` },
    },
    Select: 'COUNT',
  }));

  const actualCount = result.Count ?? 0;

  await ddb.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `EVENT#${eventId}#METADATA` },
      SK: { S: 'METADATA' },
    },
    UpdateExpression: 'SET ActivePurchaserCount = :count',
    ExpressionAttributeValues: {
      ':count': { N: String(actualCount) },
    },
  }));

  console.log(`Reconciled ActivePurchaserCount for ${eventId}: ${actualCount}`);
}

export async function handler(): Promise<void> {
  // For now, reconciles the default event.
  // In production, query a list of active events from GlobalState items.
  await correctCounter(EVENT_ID);
}
