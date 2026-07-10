import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL || 'http://localhost:3000';
const TABLE_NAME = process.env.TABLE_NAME;
const REGION = process.env.AWS_REGION || 'us-east-1';

const FAN_ID = `test-fan-${Date.now()}`;
const EVENT_ID = 'test-event';

let ddb;
if (TABLE_NAME) {
  ddb = new DynamoDBClient({ region: REGION });
}

async function request(method, path, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['authorization'] = `Bearer ${token}`;

  const res = await fetch(`${CLOUDFRONT_URL}${path}`, {
    method,
    headers,
    ...(method === 'POST' ? { body: JSON.stringify({ fanId: FAN_ID }) } : {}),
  });

  return { status: res.status, body: await res.json() };
}

async function main() {
  console.log(`\n=== E2E Test ===`);
  console.log(`Fan ID: ${FAN_ID}`);
  console.log(`Event ID: ${EVENT_ID}`);
  console.log(`Endpoint: ${CLOUDFRONT_URL}\n`);

  // 1. Join
  console.log('1. JOIN');
  const join = await request('POST', `/api/v1/event/${EVENT_ID}/join`);
  console.log(`   Status: ${join.status}`);
  if (join.status !== 200) throw new Error(`Join failed: ${JSON.stringify(join.body)}`);
  const { token, entryTimestamp } = join.body;
  if (!token) throw new Error('No token in join response');
  console.log(`   Token: ${token.slice(0, 40)}...`);
  console.log(`   entryTimestamp: ${entryTimestamp}`);
  console.log('   PASS\n');

  // 2. Poll (Waiting)
  console.log('2. POLL (Waiting)');
  const poll1 = await request('GET', `/api/v1/event/${EVENT_ID}/status`, token);
  console.log(`   Status: ${poll1.status}`);
  if (poll1.status !== 200) throw new Error(`Status poll failed: ${JSON.stringify(poll1.body)}`);
  if (poll1.body.admitted !== false) throw new Error(`Expected admitted:false, got ${poll1.body.admitted}`);
  if (typeof poll1.body.queuePosition !== 'number') throw new Error('Missing queuePosition');
  if (typeof poll1.body.estimatedWaitSeconds !== 'number') throw new Error('Missing estimatedWaitSeconds');
  console.log(`   admitted: ${poll1.body.admitted}`);
  console.log(`   queuePosition: ${poll1.body.queuePosition}`);
  console.log(`   EWT: ${poll1.body.estimatedWaitSeconds}s`);
  console.log('   PASS\n');

  // 3. Promote (direct DynamoDB update simulates the Promotion Engine)
  if (!ddb) {
    console.log('3. SKIP PROMOTE — TABLE_NAME not set. Set TABLE_NAME to test promotion flow.\n');
  } else {
    console.log('3. PROMOTE (direct DynamoDB watermark update)');
    const newWatermark = (Math.floor(Date.now() / 1000) + 3600) * 1000;
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `EVENT#${EVENT_ID}#METADATA` },
        SK: { S: 'METADATA' },
      },
      UpdateExpression: 'SET AdmittedUntilTimestamp = :w',
      ExpressionAttributeValues: { ':w': { N: String(newWatermark) } },
    }));
    console.log(`   Watermark set to: ${newWatermark}`);
    console.log('   PASS\n');
  }

  // 4. Poll (Admitted) — only after promotion
  if (ddb) {
    console.log('4. POLL (Admitted)');
    const poll2 = await request('GET', `/api/v1/event/${EVENT_ID}/status`, token);
    console.log(`   Status: ${poll2.status}`);
    if (poll2.status !== 200) throw new Error(`Status poll failed: ${JSON.stringify(poll2.body)}`);
    if (poll2.body.admitted !== true) throw new Error(`Expected admitted:true, got ${poll2.body.admitted}`);
    console.log(`   admitted: ${poll2.body.admitted}`);
    console.log('   PASS\n');
  }

  // 5. Claim — requires promotion to have run; skip if no DynamoDB access
  if (ddb) {
    console.log('5. CLAIM');
    const claim = await request('POST', `/api/v1/event/${EVENT_ID}/claim`, token);
    console.log(`   Status: ${claim.status}`);
    if (claim.status !== 200) throw new Error(`Claim failed: ${JSON.stringify(claim.body)}`);
    if (claim.body.sessionStarted !== true) throw new Error('sessionStarted !== true');
    console.log(`   sessionStarted: ${claim.body.sessionStarted}`);
    console.log(`   expiresAt: ${claim.body.expiresAt}`);
    console.log('   PASS\n');
  } else {
    console.log('5. SKIP CLAIM — TABLE_NAME not set.\n');
  }

  // 6. Release
  if (ddb) {
    console.log('6. RELEASE');
    const release = await request('POST', `/api/v1/event/${EVENT_ID}/release`, token);
    console.log(`   Status: ${release.status}`);
    if (release.status !== 200) throw new Error(`Release failed: ${JSON.stringify(release.body)}`);
    if (release.body.sessionReleased !== true) throw new Error('sessionReleased !== true');
    console.log(`   sessionReleased: ${release.body.sessionReleased}`);
    console.log('   PASS\n');
  } else {
    console.log('6. SKIP RELEASE — TABLE_NAME not set.\n');
  }

  console.log('=== ALL E2E TESTS PASSED ===');
}

main().catch(err => {
  console.error('E2E TEST FAILED:', err.message);
  process.exit(1);
});
