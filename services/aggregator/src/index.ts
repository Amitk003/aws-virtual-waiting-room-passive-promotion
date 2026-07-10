import { DynamoDBClient, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBStreamEvent, DynamoDBStreamHandler } from 'aws-lambda';
import { createHash } from 'node:crypto';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

const ddb = new DynamoDBClient();
const TABLE_NAME = requireEnv('TABLE_NAME');
const CHECKPOINT_TTL_SECONDS = 3600;

function extractEventId(pk: string): string | null {
  const parts = pk.split('#');
  if (parts.length >= 2) {
    return parts[1];
  }
  return null;
}

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  const densityByBucket = new Map<string, number>();
  const ttlCounters = new Map<string, number>();
  let sequenceInput = '';

  for (const record of event.Records) {
    const seq = record.dynamodb?.SequenceNumber || '';
    sequenceInput += seq;

    if (record.eventName === 'INSERT' && record.dynamodb?.NewImage) {
      const pk = record.dynamodb.NewImage.PK?.S || '';
      const sk = record.dynamodb.NewImage.SK?.S || '';
      const entryTimestamp = record.dynamodb.NewImage.EntryTimestamp?.N;

      if (pk.includes('#SHARD#') && sk.startsWith('TS#') && entryTimestamp) {
        const eventId = extractEventId(pk);
        if (!eventId) continue;

        const bucketTs = String(Math.floor(parseInt(entryTimestamp, 10) / 1000));
        const key = `${eventId}#${bucketTs}`;
        densityByBucket.set(key, (densityByBucket.get(key) || 0) + 1);
      }
    }

    if (
      record.eventName === 'REMOVE' &&
      record.dynamodb?.OldImage &&
      record.userIdentity?.type === 'Service' &&
      record.userIdentity?.principalId === 'dynamodb.amazonaws.com'
    ) {
      const pk = record.dynamodb.OldImage.PK?.S || '';

      if (pk.includes('#SESSION#')) {
        const eventId = extractEventId(pk);
        if (!eventId) continue;

        ttlCounters.set(eventId, (ttlCounters.get(eventId) || 0) + 1);
      }
    }
  }

  if (densityByBucket.size === 0 && ttlCounters.size === 0) return;

  // Compute idempotent batch fingerprint from all sequence numbers
  const batchId = createHash('sha256').update(sequenceInput).digest('hex').slice(0, 16);
  const checkpointPk = `STREAM_CHECKPOINT`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const transactItems: any[] = [];

  // Claim this batch with a condition — if it already exists, the entire
  // transaction is aborted and we skip. This makes retries idempotent.
  transactItems.push({
    Put: {
      TableName: TABLE_NAME,
      Item: {
        PK: { S: checkpointPk },
        SK: { S: batchId },
        ExpiresAt: { N: String(nowSeconds + CHECKPOINT_TTL_SECONDS) },
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  });

  for (const [key, count] of densityByBucket) {
    const [eventId, bucketTs] = key.split('#');
    if (!eventId || !bucketTs) continue;

    let hash = 5381;
    for (let i = 0; i < bucketTs.length; i++) {
      hash = ((hash << 5) + hash) + bucketTs.charCodeAt(i);
    }
    const shard = Math.abs(hash) % 10;

    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: {
          PK: { S: `EVENT#${eventId}#DENSITY#SHARD#${shard}` },
          SK: { S: `BUCKET#${bucketTs}` },
        },
        UpdateExpression: 'ADD #count :inc',
        ExpressionAttributeNames: { '#count': 'Count' },
        ExpressionAttributeValues: { ':inc': { N: String(count) } },
      },
    });
  }

  for (const [eventId, count] of ttlCounters) {
    transactItems.push({
      Update: {
        TableName: TABLE_NAME,
        Key: {
          PK: { S: `EVENT#${eventId}#METADATA` },
          SK: { S: 'METADATA' },
        },
        UpdateExpression: 'ADD ActivePurchaserCount :dec',
        ExpressionAttributeValues: { ':dec': { N: String(-count) } },
      },
    });
  }

  try {
    await ddb.send(new TransactWriteItemsCommand({
      TransactItems: transactItems,
    }));
  } catch (err: any) {
    if (err.name === 'TransactionCanceledException') {
      const reasons = err.CancellationReasons || [];
      if (reasons[0]?.Code === 'ConditionalCheckFailed') {
        // Batch was already processed by a prior invocation — safe to skip
        console.log(JSON.stringify({ event: 'aggregator_skip', batchId }));
        return;
      }
    }
    throw err;
  }
};
