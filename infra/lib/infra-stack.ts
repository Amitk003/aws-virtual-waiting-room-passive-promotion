import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as path from 'node:path';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- DynamoDB Table ---

    const table = new dynamodb.Table(this, 'VirtualWaitingRoom', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ExpiresAt',
    });

    table.addGlobalSecondaryIndex({
      indexName: 'SessionMetadataIndex',
      partitionKey: { name: 'GSIPK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // --- Secrets Manager Secret for JWT Signing ---
    // Stores both the private key (for signing) and the public key (for verification).
    // Both are generated locally and stored in the same secret to ensure they match.
    // Run scripts/generate-key.js after the first deploy to populate this secret.

    const signingSecret = new secretsmanager.Secret(this, 'JwtSigningSecret', {
      description: 'ECC P-256 key pair for local JWT signing (private + public key)',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Ingestion Lambda ---

    const projectRoot = path.join(__dirname, '..', '..');

    const ingestionFn = new lambdaNodejs.NodejsFunction(this, 'IngestionHandler', {
      entry: path.join(projectRoot, 'services', 'ingestion', 'src', 'index.ts'),
      projectRoot,
      depsLockFilePath: path.join(projectRoot, 'services', 'ingestion', 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: cdk.Duration.seconds(10),
      environment: {
        TABLE_NAME: table.tableName,
        SIGNING_SECRET_ID: signingSecret.secretName,
      },
      bundling: {
        target: 'es2022',
        format: lambdaNodejs.OutputFormat.ESM,
        sourceMap: true,
      },
    });

    table.grantWriteData(ingestionFn);
    signingSecret.grantRead(ingestionFn);

    // Provisioned concurrency for cold-start mitigation
    // Uncomment and set desired count before the event
    // const ingestionVersion = ingestionFn.currentVersion;
    // new lambda.Alias(this, 'IngestionHandlerAlias', {
    //   aliasName: 'prod',
    //   version: ingestionVersion,
    //   provisionedConcurrentExecutions: 5000,
    // });

    // --- API Gateway HTTP API ---

    const api = new apigwv2.HttpApi(this, 'IngestionApi', {
      apiName: 'VirtualWaitingRoom-Ingestion',
      corsPreflight: {
        allowMethods: [apigwv2.CorsHttpMethod.POST],
        allowOrigins: ['*'],
        allowHeaders: ['content-type', 'authorization'],
      },
    });

    api.addRoutes({
      path: '/api/v1/event/{eventId}/join',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwIntegrations.HttpLambdaIntegration(
        'IngestionIntegration',
        ingestionFn
      ),
    });

    // --- Outputs ---

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value: table.tableArn,
      description: 'DynamoDB table ARN',
    });

    new cdk.CfnOutput(this, 'SigningSecretName', {
      value: signingSecret.secretName,
      description: 'Secrets Manager secret name (run scripts/generate-key.js after deploy)',
    });

    new cdk.CfnOutput(this, 'IngestionApiUrl', {
      value: api.url!,
      description: 'API Gateway URL for the ingestion endpoint',
    });
  }
}
