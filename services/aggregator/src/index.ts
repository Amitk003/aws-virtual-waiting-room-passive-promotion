import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBStreamEvent, DynamoDBStreamHandler } from 'aws-lambda';

const ddb = new DynamoDBClient();
const TABLE_NAME = process.env.TABLE_NAME!;
const DENSITY_SHARD_COUNT = 20;

function extractEventId(pk: string): string | null {
  const parts = pk.split('#');
  if (parts.length >= 2) {
    return parts[1];
  }
  return null;
}

function flush(
  buffer: Array<{ eventId: string; bucketTs: string; count: number }>,
  ttlCounters: Map<string, number>
): Promise<any>[] {
  const promises: Promise<any>[] = [];

  for (const entry of buffer) {
    const shardId = Math.floor(Math.random() * DENSITY_SHARD_COUNT) + 1;
    promises.push(ddb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `EVENT#${entry.eventId}#DENSITY#SHARD#${shardId}` },
        SK: { S: `BUCKET#${entry.bucketTs}` },
      },
      UpdateExpression: 'ADD #count :inc',
      ExpressionAttributeNames: { '#count': 'Count' },
      ExpressionAttributeValues: { ':inc': { N: String(entry.count) } },
    })));
  }

  for (const [eventId, count] of ttlCounters) {
    promises.push(ddb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `EVENT#${eventId}#METADATA` },
        SK: { S: 'METADATA' },
      },
      UpdateExpression: 'ADD ActivePurchaserCount :dec',
      ExpressionAttributeValues: { ':dec': { N: String(-count) } },
    })));
  }

  return promises;
}

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  const densityByBucket = new Map<string, number>();
  const ttlCounters = new Map<string, number>();

  for (const record of event.Records) {
    // QueueTicket INSERT: aggregate per-second density
    if (record.eventName === 'INSERT' && record.dynamodb?.NewImage) {
      const pk = record.dynamodb.NewImage.PK?.S || '';
      const sk = record.dynamodb.NewImage.SK?.S || '';
      const entryTimestamp = record.dynamodb.NewImage.EntryTimestamp?.N;

      if (pk.includes('#SHARD#') && sk.startsWith('TS#') && entryTimestamp) {
        const eventId = extractEventId(pk);
        if (!eventId) continue;

        const bucketTs = String(Math.floor(parseInt(entryTimestamp) / 1000));
        const key = `${eventId}#${bucketTs}`;
        densityByBucket.set(key, (densityByBucket.get(key) || 0) + 1);
      }
    }

    // SessionItem REMOVE: only process TTL-driven expirations
    // Manual DeleteItem from the Slot Handler already decrements the counter,
    // so we must skip those to avoid double-decrement.
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

  const buffer: Array<{ eventId: string; bucketTs: string; count: number }> = [];
  for (const [key, count] of densityByBucket) {
    const [eventId, bucketTs] = key.split('#');
    buffer.push({ eventId: eventId!, bucketTs: bucketTs!, count });
  }

  const promises = flush(buffer, ttlCounters);
  if (promises.length > 0) {
    await Promise.all(promises);
  }
};
