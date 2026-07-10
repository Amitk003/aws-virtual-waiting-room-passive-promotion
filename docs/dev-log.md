# Development Log

## Branch: main (initial setup)

### 2026-07-10 - Project initialization

Commands ran:
- `git init` - Initialize git repo
- `git checkout -b main` - Create main branch
- Created folders: docs/, data-model/, infra/, services/

Files created:
- `.gitignore` - Node.js and CDK ignore rules
- `README.md` - Project overview and structure
- `docs/dev-log.md` - This file

Packages installed: None

Notes:
- Base project structure is set up
- Remote added: https://github.com/Amitk003/aws-virtual-waiting-room-passive-promotion
- Pushed main branch and created feature/phase-1-data-model branch

---

## Branch: feature/phase-1-data-model

### 2026-07-10 - Data model design and access patterns

Commands ran:
- `git checkout -b feature/phase-1-data-model` - Create phase 1 feature branch

Files created:
- `data-model/virtual-waiting-room.json` - CloudFormation JSON template format (for NoSQL Workbench import)
- `docs/data-model-spec.md` - Simple data model documentation (no high-level language)
- `docs/access-patterns.md` - All 7 access patterns documented

Packages installed: None

### 2026-07-10 - Fix: Converted data model to CloudFormation JSON format

Commands ran:
- Updated `data-model/virtual-waiting-room.json` - Changed from wrong NoSQL Workbench native format to proper CloudFormation JSON template format

Reason for change:
- NoSQL Workbench does not import arbitrary JSON files. It only accepts CloudFormation JSON templates or the NoSQL Workbench native export format.
- The CloudFormation JSON uses the standard `AWS::DynamoDB::Table` syntax from AWS documentation.

How to import:
1. Open NoSQL Workbench
2. Click "Import model"
3. Select "CloudFormation JSON template"
4. Browse to `data-model/virtual-waiting-room.json`
5. The table schema will appear in the data modeler

Notes:
- Data model has 3 entities: QueueTicket, GlobalState, SessionItem
- Uses single-table design with generic PK/SK pattern
- Write sharding uses 2000 random shards
- Passive promotion uses global watermark for batch promotion
- Streams enabled (NEW_AND_OLD_IMAGES) for aggregator
- TTL enabled on ExpiresAt attribute for auto-cleanup

### 2026-07-10 - Major data model refactor: removed ActiveSlot, added SessionItem + GSI

Commands ran:
- Updated `data-model/virtual-waiting-room.json` - Changed to PAY_PER_REQUEST, removed ProvisionedThroughput, added GSIPK attribute and SessionMetadataIndex GSI
- Updated `docs/data-model-spec.md` - Replaced ActiveSlot entity with SessionItem entity, added GSI docs, added pruning note
- Updated `docs/access-patterns.md` - Replaced patterns 5-7 (slot-based) with patterns 5-9 (session-based including TTL auto-release and reconciliation)

Reason for changes:
- ActiveSlot design created a hot partition risk (all 1000 slots under one PK)
- Pre-populating 1000 slots added unnecessary init complexity
- New SessionItem approach uses unique PK per fan, naturally distributed writes
- TTL auto-release via stream is self-healing (no cron job for expiry)
- Reconciliation Lambda every 5 min corrects counter drift
- PAY_PER_REQUEST avoids account limit deployment failures
- Added SessionMetadataIndex GSI for reconciliation queries

Files changed:
- `data-model/virtual-waiting-room.json` - Schema update
- `docs/data-model-spec.md` - Full rewrite of entities section
- `docs/access-patterns.md` - Full rewrite of patterns 5-9
- `docs/dev-log.md` - This entry

---

## Branch: feature/phase-2-iac-setup

### 2026-07-10 - CDK v2 TypeScript project setup and stack definition

Commands ran:
- `git checkout main && git checkout -b feature/phase-2-iac-setup` - Create phase 2 feature branch
- `npx aws-cdk@latest init app --language typescript --generate-only` - Initialize CDK project in infra/
- `npm install` - Install CDK dependencies (aws-cdk-lib, constructs, jest, typescript, etc.)
- `npx tsc --noEmit` - Verify TypeScript compilation (fixed KeySpec enum and addAlias API)
- `npx cdk synth` - Generate CloudFormation template (verified output)

Packages installed (via CDK init + npm install):
- aws-cdk-lib ^2.261.0
- constructs ^10.5.0
- aws-cdk 2.1130.0 (dev)
- typescript ~5.9.3 (dev)
- jest ^30 (dev)
- ts-jest ^29 (dev)
- ts-node ^10.9.2 (dev)
- @types/node ^24.10.1 (dev)
- @types/jest ^30 (dev)

Files created:
- `infra/bin/infra.ts` - CDK app entry point
- `infra/lib/infra-stack.ts` - Stack with DynamoDB table, KMS key, IAM roles
- `infra/test/infra.test.ts` - Unit test template
- `infra/package.json` - Node.js project config
- `infra/tsconfig.json` - TypeScript config
- `infra/cdk.json` - CDK toolkit config
- `infra/jest.config.js` - Jest config
- `infra/.gitignore` - CDK-specific ignore rules
- `docs/iac-setup.md` - IaC documentation

Stack resources defined:
- DynamoDB Table: VirtualWaitingRoom (PAY_PER_REQUEST, PK/SK, Streams, TTL, GSI)
- KMS Key: Asymmetric ECC_NIST_P256 for JWT signing (with dynamic alias)
- IAM Roles: None (removed - Lambda functions in later phases will auto-create their own)

Notes:
- Table uses PAY_PER_REQUEST to avoid account limit errors on deployment
- Pre-warming to 1M WCU will be done via a separate CLI script before the event
- CDK stack produces AWS::DynamoDB::Table (not GlobalTable) for NoSQL Workbench compatibility
- KMS key has removalPolicy: DESTROY for safe dev cleanup (change to RETAIN for production)
- KMS pending window set to 7 days (minimum allowed)

### 2026-07-10 - Code review fixes: removed IAM roles, hardcoded names, added KMS cleanup

Commands ran:
- Updated `infra/lib/infra-stack.ts` - Removed 6 manual IAM roles (~60 lines removed), removed hardcoded tableName, added removalPolicy: DESTROY on KMS key, added dynamic alias suffix
- Updated `docs/iac-setup.md` - Reflected all changes

Reason for changes:
- IAM roles were pure boilerplate; CDK's lambda.Function auto-creates them with inline grants
- Hardcoded table name would conflict in multi-environment deployments
- KMS key needed removalPolicy: DESTROY for clean `cdk destroy` during development
- KMS alias needed dynamic suffix to prevent conflicts on redeploy

Files changed:
- `infra/lib/infra-stack.ts` - Major cleanup
- `docs/iac-setup.md` - Updated to reflect removal of IAM roles
- `docs/dev-log.md` - This entry

---

## Branch: feature/phase-3-ingestion-tier

### 2026-07-10 - Ingestion Lambda and API Gateway setup

Commands ran:
- `git checkout main && git checkout -b feature/phase-3-ingestion-tier` - Create branch
- `New-Item services/ingestion/src, services/ingestion/test` - Create Lambda project dirs
- `npm install` (in services/ingestion/) - Install SDK deps
- `npm install --save-dev esbuild` (in infra/) - Install bundler for NodejsFunction
- `npx tsc --noEmit` - Verified TypeScript compilation
- `npx cdk synth` - Generated CloudFormation (Lambda + API Gateway bundled successfully)

Packages installed:
- In services/ingestion/: @aws-sdk/client-dynamodb, @aws-sdk/client-kms, @types/aws-lambda, jest, typescript, etc.
- In infra/: esbuild (dev dependency for Lambda bundling)

Files created:
- `services/ingestion/package.json` - Node.js project config
- `services/ingestion/tsconfig.json` - TypeScript config
- `services/ingestion/src/index.ts` - Lambda handler (event parsing, sharding, DynamoDB write, JWT sign)
- `services/ingestion/src/jwt.ts` - JWT signing utility using KMS Sign API (ES256)
- `services/ingestion/src/shard.ts` - Shard ID generator (1-2000)
- `services/ingestion/test/ingestion.test.ts` - Shard distribution unit tests
- `docs/ingestion-service.md` - Ingestion service documentation

Files modified:
- `infra/lib/infra-stack.ts` - Added NodejsFunction for ingestion Lambda, HttpApi with route, IAM grants

Stack additions:
- Lambda: IngestionHandler (Node.js 22.x, ARM64, 512MB, 10s timeout)
- API Gateway: HTTP API with POST /api/v1/event/{eventId}/join
- IAM: Auto-created role with DynamoDB write + KMS sign permissions
- CORS: Enabled for content-type and authorization headers
- Provisioned Concurrency: Placeholder (commented out, to be enabled before event)
Notes:

- Lambda uses KMS Sign API directly (for production at 1M scale, switch to local key caching from Secrets Manager)
- Table name and key ID passed via environment variables
- projectRoot set to repo root for cross-directory Lambda bundling
- API Gateway uses HTTP API (v2) for lower latency and cost

### 2026-07-10 - Bug fixes: DER signature, KMS hot path, double-join check

Commands ran:
- `npm install` (in services/ingestion/) - Added jose and @aws-sdk/client-secrets-manager
- `npx cdk synth` - Verified CloudFormation (bundled jose into Lambda, 39.7kb)

Files changed:
- `services/ingestion/src/jwt.ts` - Complete rewrite
- `services/ingestion/src/index.ts` - Added tracking item write
- `services/ingestion/package.json` - Added jose and secrets-manager deps
- `infra/lib/infra-stack.ts` - Added Secrets Manager secret, changed KMS grant to GetPublicKey
- `scripts/generate-key.js` - New file for key generation
- `docs/ingestion-service.md` - Updated docs

Bug fixes applied:

1. DER vs P1363 signature format: Removed raw KMS Sign call. KMS returned ASN.1 DER but JWT/ES256 requires IEEE P1363 (raw R||S). Switched to local signing with `jose` library which handles P1363 correctly.

2. KMS hot path: Removed `kms:Sign` from Lambda. JWTs are now signed locally using a cached ECC P-256 private key loaded from Secrets Manager. KMS is only used for `kms:GetPublicKey` (authorizer needs the public key). This eliminates KMS API throttling at 1M requests/sec.

3. Double-join check: Added tracking item write with PK = `EVENT#<eventId>#FAN#<fanId>` and condition `attribute_not_exists(PK)`. If the condition fails, returns 409. The tracking item has ExpiresAt TTL so orphaned items auto-clean if Lambda crashes between the two writes.

### 2026-07-10 - Removed KMS entirely (unrelated key pair bug)

Commands ran:
- Removed `@aws-sdk/client-kms` from services/ingestion/package.json
- `npx cdk synth` - Verified CloudFormation output

Files changed:
- `infra/lib/infra-stack.ts` - Removed KMS key, alias, grants, env var; removed KmsKeyId output
- `services/ingestion/src/jwt.ts` - Removed KMS client, GetPublicKeyCommand; kid is now fixed string `vwr-v1`
- `services/ingestion/src/index.ts` - Removed KMS_KEY_ID env var
- `services/ingestion/package.json` - Removed @aws-sdk/client-kms
- `scripts/generate-key.js` - Already stored both privateKey and publicKey (no change needed)
- `docs/iac-setup.md` - Replaced KMS doc with Secrets Manager doc
- `docs/ingestion-service.md` - Updated JWT signing section
- `docs/dev-log.md` - This entry

Reason:
- There were two unrelated ECC P-256 key pairs: KMS key (for GetPublicKey) and Secrets Manager key (for local signing)
- The `kid` header derived from the KMS key ID required verifiers to reference KMS, but the actual signing key was the Secrets Manager one
- Removing KMS entirely means one key pair stored in Secrets Manager, used for both signing (private key) and verification (public key)
- Eliminates the risk of key mismatch and removes a dependency that was only used for deriving a key ID

---

## Branch: feature/phase-4-streams-aggregator

### 2026-07-10 - Streams Aggregator integration

Commands ran:
- Created `services/aggregator` project directory
- `npm install` in services/aggregator/ - Installed deps (31 packages)
- `npx tsc --noEmit` - Verified TypeScript compilation
- `npx cdk synth` - Generated CloudFormation (aggregator bundle 2.6kb)

Files created:
- `services/aggregator/package.json` - Node.js project config
- `services/aggregator/tsconfig.json` - TypeScript config
- `services/aggregator/src/index.ts` - Streams Aggregator Lambda handler

Files modified:
- `infra/lib/infra-stack.ts` - Added StreamAggregator Lambda with DynamoDB event source
- `docs/data-model-spec.md` - Added DensityBucket entity, updated density map section
- `docs/access-patterns.md` - Added Pattern 10 (Get Time Density Map), updated Patterns 2 and 3
- `docs/iac-setup.md` - Added aggregator notes to production considerations
- `docs/dev-log.md` - This entry

New stack resources:
- Lambda: StreamAggregator (Node.js 22, ARM64, 256MB, 60s timeout)
- Event Source Mapping: DynamoDB Stream (batch size 100, latest position, 3 retries)
- IAM: Auto-created role with DynamoDB write + stream read permissions

Aggregator design:
- QueueTicket INSERT events: Extracts eventId and entryTimestamp, accumulates per-second count per bucket in memory, flushes via atomic `ADD Count :inc` on DensityBucket items (`EVENT#<id>#DENSITY`, SK = `BUCKET#<ts>`)
- SessionItem REMOVE (TTL) events: Decrements `ActivePurchaserCount` on GlobalState via `ADD ActivePurchaserCount :dec`
- DensityBucket replaces the old TimeDensityMap JSON attribute on GlobalState, enabling safe concurrent writes from multiple shard aggregators

### 2026-07-10 - Fix: double-decrement guard + randomized density shard

Files changed:
- `services/aggregator/src/index.ts` - Two fixes:
  1. Added `record.userIdentity` check to skip non-TTL REMOVE events on sessions (prevents double-decrement)
  2. Changed density shard from `bucketTs % 20` to `Math.random() * 20` (prevents hopping hot partition)

---

## Branch: feature/phase-5-status-api

### 2026-07-10 - Status Polling API and CloudFront CDN

Commands ran:
- Created `services/status-api/` project directory
- `npm install` in services/status-api/ - Installed deps (35 packages)
- `npx tsc --noEmit` - Verified TypeScript compilation
- `npx cdk synth` - Generated CloudFormation (status bundle 44.7kb including jose)

Files created:
- `services/status-api/package.json` - Node.js project config
- `services/status-api/tsconfig.json` - TypeScript config
- `services/status-api/src/index.ts` - Status handler Lambda
- `services/status-api/src/jwt.ts` - JWT verification utility
- `docs/status-service.md` - Status API documentation

Files modified:
- `infra/lib/infra-stack.ts` - Added StatusHandler Lambda, status API route, CloudFront CDN; renamed API to WaitingRoomApi
- `docs/iac-setup.md` - Added new resources to table, updated production considerations
- `docs/dev-log.md` - This entry

New stack resources:
- Lambda: StatusHandler (Node.js 22, ARM64, 256MB, 10s timeout)
- API Route: GET /api/v1/event/{eventId}/status
- CloudFront Distribution: CDN with per-user caching (2s TTL) on status endpoint
- Cache Policy: Whitelists Authorization header for per-user cache key
- IAM: Auto-created role with DynamoDB read + Secrets Manager read permissions

Status API design:
- Validates JWT locally using cached public key from Secrets Manager (jose library)
- Reads GlobalState to get AdmittedUntilTimestamp and ActivePurchaserCount
- If admitted, returns immediately with `admitted: true`
- If waiting, queries all 20 DensityBucket shards in parallel, merges counts, calculates queue position
- Returns estimated wait time based on queue position and active purchaser count
- CloudFront caches status responses per-user (Authorization header in cache key) with 2-second default TTL

### 2026-07-10 - Fix: global-scope in-memory cache for density map

Files changed:
- `services/status-api/src/index.ts` - Added `Map<eventId, CachedState>` with 2s TTL outside the handler. First request per 2s window queries DynamoDB; subsequent requests served from memory. Reduces DB reads from 2M/sec to ~210/sec.

---

## Branch: feature/phase-6-slot-handler

### 2026-07-10 - Slot Handler and Reconciliation Lambda

Commands ran:
- Created `services/slot-handler/` and `services/reconciliation/` project dirs
- `npm install` in both - Installed deps
- `npx tsc --noEmit` - Verified TypeScript compilation for both
- `npx cdk synth` - Generated CloudFormation (slot bundle 44.7kb, rec bundle 1.1kb)

Files created:
- `services/slot-handler/package.json` - Node.js project config
- `services/slot-handler/tsconfig.json` - TypeScript config
- `services/slot-handler/src/index.ts` - Slot handler (claim + release)
- `services/slot-handler/src/jwt.ts` - JWT verification
- `services/reconciliation/package.json` - Node.js project config
- `services/reconciliation/tsconfig.json` - TypeScript config
- `services/reconciliation/src/index.ts` - Reconciliation handler
- `docs/slot-handler.md` - Slot handler documentation

Files modified:
- `infra/lib/infra-stack.ts` - Added SlotHandler Lambda + 2 API routes, Reconciliation Lambda + EventBridge schedule
- `docs/dev-log.md` - This entry

New stack resources:
- Lambda: SlotHandler (Node.js 22, ARM64, 256MB, 10s) - handles claim + release
- API Route: POST /api/v1/event/{eventId}/claim
- API Route: POST /api/v1/event/{eventId}/release
- Lambda: ReconciliationHandler (Node.js 22, ARM64, 256MB, 30s) - corrects counter drift
- EventBridge Rule: Every 5 minutes, targets ReconciliationHandler
- IAM: Auto-created roles with DynamoDB read/write + Secrets Manager read permissions

Slot handler design:
- Claim: Creates SessionItem, then conditionally increments ActivePurchaserCount (cap 1000). If counter full, rolls back (deletes session) and returns 429.
- Release: Deletes SessionItem, decrements ActivePurchaserCount.
- Session TTL: 5 minutes for auto-cleanup on abandon.
- Reconciliation: Queries SessionMetadataIndex GSI, counts active sessions, sets ActivePurchaserCount to actual count.

---

## Branch: feature/phase-7-promotion-engine

### 2026-07-10 - Promotion Engine (watermark advancement)

Commands ran:
- Created `services/promotion/` project directory
- `npm install` in services/promotion/ - Installed deps (33 packages)
- `npx tsc --noEmit` - Verified TypeScript compilation
- `npx cdk synth` - Generated CloudFormation (promotion bundle 3.7kb)

Files created:
- `services/promotion/package.json` - Node.js project config
- `services/promotion/tsconfig.json` - TypeScript config
- `services/promotion/src/index.ts` - Promotion Engine Lambda
- `docs/promotion-engine.md` - Promotion Engine documentation

Files modified:
- `infra/lib/infra-stack.ts` - Added PromotionEngine Lambda + EventBridge schedule
- `docs/dev-log.md` - This entry

New stack resources:
- Lambda: PromotionEngine (Node.js 22, ARM64, 256MB, 5s timeout)
- EventBridge Rule: Every 1 minute, targets PromotionEngine
- IAM: Auto-created role with DynamoDB read/write permissions

Promotion engine design:
- Runs every 1 minute (EventBridge minimum rate), loops internally every 1s up to 5s timeout
- Reads GlobalState, calculates free slots (1000 - ActivePurchaserCount)
- Loads density map from all 20 shards (cached in global scope for 2s)
- Walks forward from watermark, fills free slots from density buckets
- Advances AdmittedUntilTimestamp via single UpdateItem
- Zero DB load when slots are full (only GetItem per iteration)

---

## Branch: feature/phase-8-operational-tooling

### 2026-07-10 - Pre-warming script, CloudWatch dashboard, key rotation

Commands ran:
- Created `scripts/prewarm-table.js` and `scripts/rotate-key.js`
- `npx cdk synth` - Generated CloudFormation with dashboard and alarms

Files created:
- `scripts/prewarm-table.js` - Toggle DynamoDB billing mode (PAY_PER_REQUEST ↔ PROVISIONED)
- `scripts/rotate-key.js` - Rotate JWT signing key with new kid version

Files modified:
- `infra/lib/infra-stack.ts` - Added CloudWatch dashboard + alarms
- `docs/dev-log.md` - This entry

CDK additions:
- Dashboard: VirtualWaitingRoom with widgets for all 6 Lambdas (errors + throttles), DynamoDB throttled requests and consumed capacity, API Gateway 5XX errors
- Alarms: Ingestion Lambda errors > 0, DynamoDB write throttling > 0

Scripts:
- prewarm-table.js: Switches table to PROVISIONED with target WCU/RCU before event, back to PAY_PER_REQUEST after
- rotate-key.js: Generates new ECC P-256 key pair, stores with new kid version in Secrets Manager
