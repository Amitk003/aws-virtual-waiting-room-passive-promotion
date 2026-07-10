/**
 * Switches the DynamoDB table between billing modes for event pre-warming.
 *
 * The GSI (SessionMetadataIndex) stores only ~1000 active session items,
 * so its WCU is set independently to a lower value than the main table.
 *
 * Before event: node scripts/prewarm-table.js <table-name> provisioned <wcu> <rcu> <gsi-wcu> [region]
 * After event:  node scripts/prewarm-table.js <table-name> pay-per-request [region]
 *
 * Examples:
 *   node scripts/prewarm-table.js VirtualWaitingRoom provisioned 1000000 50000 1000 us-east-1
 *   node scripts/prewarm-table.js VirtualWaitingRoom pay-per-request us-east-1
 */

import { DynamoDBClient, UpdateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';

const tableName = process.argv[2];
const mode = process.argv[3];

if (!tableName || !mode) {
  console.error('Usage: node scripts/prewarm-table.js <table-name> provisioned <wcu> <rcu> [region]');
  console.error('       node scripts/prewarm-table.js <table-name> pay-per-request [region]');
  process.exit(1);
}

let region = 'us-east-1';

if (mode === 'provisioned') {
  const wcu = parseInt(process.argv[4]);
  const rcu = parseInt(process.argv[5]);
  const gsiWcu = parseInt(process.argv[6]) || 1000;
  region = process.argv[7] || 'us-east-1';

  if (!wcu || !rcu) {
    console.error('Provisioned mode requires WCU and RCU values');
    process.exit(1);
  }

  const client = new DynamoDBClient({ region });

  await client.send(new UpdateTableCommand({
    TableName: tableName,
    BillingMode: 'PROVISIONED',
    ProvisionedThroughput: {
      ReadCapacityUnits: rcu,
      WriteCapacityUnits: wcu,
    },
    GlobalSecondaryIndexUpdates: [
      {
        Update: {
          IndexName: 'SessionMetadataIndex',
          ProvisionedThroughput: {
            ReadCapacityUnits: rcu,
            WriteCapacityUnits: gsiWcu,
          },
        },
      },
    ],
  }));

  console.log(`Switched ${tableName} to PROVISIONED (WCU: ${wcu}, RCU: ${rcu}, GSI WCU: ${gsiWcu})`);
} else if (mode === 'pay-per-request') {
  region = process.argv[4] || 'us-east-1';

  const client = new DynamoDBClient({ region });

  await client.send(new UpdateTableCommand({
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
  }));

  console.log(`Switched ${tableName} to PAY_PER_REQUEST`);
}

// Wait for update to complete
const waitClient = new DynamoDBClient({ region });
let status;
do {
  const desc = await waitClient.send(new DescribeTableCommand({ TableName: tableName }));
  status = desc.Table?.TableStatus;
  if (status === 'ACTIVE') break;
  console.log(`Waiting for table update... (${status})`);
  await new Promise(r => setTimeout(r, 5000));
} while (status !== 'ACTIVE');

console.log(`Table ${tableName} is ACTIVE`);
