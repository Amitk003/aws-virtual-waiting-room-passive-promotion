# AWS Virtual Waiting Room - Passive Promotion

A high-scale virtual waiting room system built on AWS. It uses a Zero-Write Passive Promotion design with Time-Density Watermarking to handle high traffic events.

## Project Structure

```
docs/          - Project documentation
data-model/    - DynamoDB data model files
infra/         - Infrastructure as Code (CDK)
services/      - Lambda function code
```

## Tech Stack

- Node.js / TypeScript
- AWS CDK v2
- Amazon DynamoDB
- AWS Lambda
- Amazon API Gateway
- Amazon CloudFront
- AWS KMS

## Setup

1. Install Node.js 20+
2. Install AWS CLI and configure credentials
3. Run `npm install` in each service directory
4. Deploy with `cdk deploy`

## Branches

- `main` - Stable base
- `feature/*` - Feature branches (one per phase)

## Phases

1. Data Model Design (NoSQL Workbench)
2. Infrastructure as Code Setup
3. Ingestion Service
4. Streams Aggregator
5. Edge Polling and CDN
6. Active Slot Pool
7. Watermark Promotion Loop
8. Load Testing
9. Hardening and Monitoring
