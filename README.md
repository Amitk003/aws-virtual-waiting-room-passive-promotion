# AWS Virtual Waiting Room - Passive Promotion

This project is a high-scale virtual waiting room built on AWS. It handles millions of users during major sales events without crashing your servers or costing a fortune.

## The Approach

When millions of users join a queue at the same time, traditional waiting rooms try to update the status of each user in the database. This causes a massive write storm that crashes databases.

We solved this with a new approach: Zero-Write Passive Promotion.

1. Queue Entry: When a user arrives, they get a cryptographically signed ticket (JWT) containing their entry timestamp. This ticket is saved to a sharded DynamoDB table.
2. Density Mapping: A background aggregator counts how many users arrived during each second. It saves this information to a time-density map.
3. Shifting the Watermark: Instead of updating every single user record to make them eligible, the promotion engine updates just one global watermark timestamp in the database.
4. Edge Verification: To check if they are allowed to buy, the user compares their ticket timestamp against the global watermark. Since this check happens at the CDN edge (CloudFront) and API Gateway, it does not query the main database. 

If the user's timestamp is less than or equal to the watermark, they are admitted. Promoting 100,000 users requires only 1 database write, instead of 100,000 writes.

## Key Benefits

* High Scale: Built to handle 10 million concurrent users and keep exactly 1,000 active checkout sessions.
* Huge Cost Savings: Reduces database write costs by 99.999% during the promotion phase.
* Guaranteed Fairness: Uses cryptographic tokens and hash-based tie-breakers. Users cannot tamper with their queue position or skip the line.
* Downstream Protection: Limits the checkout area to a precise number of active sessions to protect payment systems.

## Project Structure

* docs: Project documentation and specs.
* data-model: NoSQL Workbench files for DynamoDB.
* edge: CloudFront Function code for quick token verification.
* infra: Infrastructure as Code using AWS CDK.
* scripts: Operational tools for key generation, rotation, pre-warming, and testing.
* services: AWS Lambda code for ingestion, aggregation, promotion, and slot management.

## Tech Stack

* Node.js and TypeScript
* AWS CDK v2
* Amazon DynamoDB
* AWS Lambda
* Amazon CloudFront
* AWS Secrets Manager
* Amazon EventBridge

## Setup Guide

1. Install Node.js 22 or higher.
2. Install the AWS CLI and configure your credentials.
3. Install dependencies by running npm install in each service folder and inside the infra folder.
4. Generate the cryptographic key pair:
   node scripts/generate-key.js <secret-name>
5. Deploy the infrastructure:
   cd infra && cdk deploy
6. Run the end-to-end test:
   CLOUDFRONT_URL=<your-url> TABLE_NAME=<your-table> node scripts/test-e2e.js
