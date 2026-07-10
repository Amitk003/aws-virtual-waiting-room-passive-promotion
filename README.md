# AWS Virtual Waiting Room - Passive Promotion

A high-scale virtual waiting room system built on AWS. It uses a Zero-Write Passive Promotion design with Time-Density Watermarking to handle high traffic events.

## Project Structure

```
docs/          - Project documentation
data-model/    - DynamoDB data model files
edge/          - CloudFront Function code
infra/         - Infrastructure as Code (CDK)
scripts/       - Operational tooling (key rotation, pre-warming, e2e test)
services/      - Lambda function code
```

## Tech Stack

- Node.js / TypeScript
- AWS CDK v2
- Amazon DynamoDB (single-table, PAY_PER_REQUEST, streams, TTL, GSI)
- AWS Lambda (Node.js 22, ARM64)
- Amazon API Gateway (HTTP API v2)
- Amazon CloudFront (CDN + edge function for token format check)
- AWS Secrets Manager (ECC P-256 key pair for local JWT signing/verification)
- Amazon EventBridge (scheduled reconciliation + promotion)
- Amazon CloudWatch (dashboard + alarms)

## Setup

1. Install Node.js 22+
2. Install AWS CLI and configure credentials
3. Run `npm install` in each service directory and in infra/
4. Generate the signing key: `node scripts/generate-key.js <secret-name>`
5. Deploy with `cdk deploy` from infra/
6. Run the e2e test: `CLOUDFRONT_URL=<url> TABLE_NAME=<table> node scripts/test-e2e.js`

## Branches

- `main` - Stable base
- `feature/*` - Feature branches (one per phase)

## Phases

1. Data Model Design (NoSQL Workbench)
2. Infrastructure as Code (CDK)
3. Ingestion Service (JWT signing, double-join tracking)
4. Streams Aggregator (density map, TTL session cleanup)
5. Status API + CDN (queue position, EWT, edge caching)
6. Slot Handler + Reconciliation (claim/release, counter drift correction)
7. Promotion Engine (continuous watermark advancement with forward-only guard)
8. Operational Tooling (key rotation, pre-warming, dashboard, alarms)
