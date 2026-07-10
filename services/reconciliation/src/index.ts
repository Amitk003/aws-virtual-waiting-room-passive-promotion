import { DynamoDBClient, QueryCommand, UpdateItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;
const EVENT_ID = process.env.EVENT_ID || 'default-event';

async function correctCounter(eventId: string): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const deletePromises: Promise<any>[] = [];

  // Query GSI for all session items
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'SessionMetadataIndex',
    KeyConditionExpression: 'GSIPK = :gsiPk',
    ExpressionAttributeValues: {
      ':gsiPk': { S: `EVENT#${eventId}#SESSION_META` },
    },
    ProjectionExpression: 'ExpiresAt',
  }));

  // Count only non-expired sessions; collect expired ones for deletion
  let validCount = 0;
  for (const item of result.Items || []) {
    const expiresAt = Number(item.ExpiresAt?.N || 0);
    if (expiresAt > nowSeconds) {
      validCount++;
    } else {
      const pk = item.PK?.S || '';
      const sk = item.SK?.S || 'SESSION';
      if (pk) {
        deletePromises.push(ddb.send(new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: { S: pk },
            SK: { S: sk },
          },
        })));
      }
    }
  }

  // Update GlobalState with the real count
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

  // Fire-and-forget expired session deletions
  if (deletePromises.length > 0) {
    Promise.all(deletePromises).catch(err =>
      console.error('Failed to delete expired sessions:', err)
    );
  }

  console.log(`Reconciled ActivePurchaserCount for ${eventId}: ${validCount} (deleted ${deletePromises.length} expired)`);
}

export async function handler(): Promise<void> {
  // For now, reconciles the default event.
  // In production, query a list of active events from GlobalState items.
  await correctCounter(EVENT_ID);
}
