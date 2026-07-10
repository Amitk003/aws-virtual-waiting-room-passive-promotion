# Infrastructure Setup (IaC)

This folder contains the AWS CDK v2 (TypeScript) project that defines all cloud resources for the Virtual Waiting Room.

## What is deployed

| Resource | Type | Purpose |
|----------|------|---------|
| DynamoDB Table | `AWS::DynamoDB::Table` | Main data store (single-table design) |
| KMS Key | `AWS::KMS::Key` | Asymmetric ECC P-256 key for JWT signing |
| IAM Roles | 6 roles | Least-privilege roles for each Lambda function |

## Stack resources

### DynamoDB Table: VirtualWaitingRoom

- Billing: PAY_PER_REQUEST (avoids account limit errors on deploy)
- Partition Key: PK (String, HASH)
- Sort Key: SK (String, RANGE)
- Streams: NEW_AND_OLD_IMAGES
- TTL: ExpiresAt attribute
- GSI: SessionMetadataIndex (GSIPK, KEYS_ONLY)

### KMS Key: JwtSigningKey

- Type: Asymmetric (ECC_NIST_P256)
- Usage: SIGN_VERIFY
- Alias: alias/virtual-waiting-room-jwt-signing

### IAM Roles

| Role | Permissions |
|------|-------------|
| IngestionLambdaRole | dynamodb:PutItem, kms:Sign |
| AggregatorLambdaRole | Stream read, table write |
| StatusApiLambdaRole | Table read |
| SlotHandlerLambdaRole | Table write |
| PromotionLambdaRole | Table read + write |
| ReconciliationLambdaRole | Table read + write |

## Useful commands

```bash
cd infra/
npm run build     # compile TypeScript to JS
npm run test      # run unit tests
npx cdk list      # list stacks
npx cdk diff      # compare with deployed stack
npx cdk deploy    # deploy to AWS account
npx cdk synth     # generate CloudFormation template
```

## Pre-warming for the event

The table starts in PAY_PER_REQUEST mode. Before an event:

1. Request a DynamoDB limit increase from AWS Support (target: 1M WCUs)
2. Use a CLI script to switch to PROVISIONED mode with the desired capacity
3. After the event peak, switch back to PAY_PER_REQUEST

This keeps the base template deployable without account limit issues.
