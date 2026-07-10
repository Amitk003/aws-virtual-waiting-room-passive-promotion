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
