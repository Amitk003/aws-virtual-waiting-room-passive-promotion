import { DynamoDBClient, QueryCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

const ddb = new DynamoDBClient();
const TABLE_NAME = requireEnv('TABLE_NAME');
const EVENT_ID = process.env.EVENT_ID || 'default-event';

async function reconcileExpiredSessions(eventId: string): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Query GSI for sessions that have expired but are not yet deleted by TTL
  const expiredQuery = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'SessionMetadataIndex',
    KeyConditionExpression: 'GSIPK = :gsiPk AND ExpiresAt <= :now',
    ExpressionAttributeValues: {
      ':gsiPk': { S: `EVENT#${eventId}#SESSION_META` },
      ':now': { N: String(nowSeconds) },
    },
  }));

  const expiredItems = expiredQuery.Items || [];
  console.log(JSON.stringify({ event: 'reconciliation_expired_found', eventId, count: expiredItems.length }));

  // Delete the expired session items from the base table
  for (const item of expiredItems) {
    const pk = item.PK?.S;
    const sk = item.SK?.S;

    if (pk && sk) {
      try {
        await ddb.send(new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: { S: pk },
            SK: { S: sk },
          },
        }));
        console.log(JSON.stringify({ event: 'reconciliation_cleanup_session', pk }));
      } catch (err: any) {
        console.error(JSON.stringify({ event: 'reconciliation_cleanup_failed', pk, error: err.message }));
      }
    }
  }
}

export async function handler(): Promise<void> {
  await reconcileExpiredSessions(EVENT_ID);
}
