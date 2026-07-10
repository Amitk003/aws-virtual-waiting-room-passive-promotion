import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
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

    // --- KMS Asymmetric Key for JWT Public Key Retrieval ---
    // The KMS key is used ONLY for getting the public key (for edge authorizers).
    // JWT signing is done locally using a key from Secrets Manager to avoid
    // KMS API throttling at 1M requests/sec.

    const signingKey = new kms.Key(this, 'JwtSigningKey', {
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      description: 'Key for JWT public key retrieval at the edge',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pendingWindow: cdk.Duration.days(7),
    });
    signingKey.addAlias(`alias/virtual-waiting-room-jwt-signing-${this.stackName}`);

    // --- Secrets Manager Secret for Local JWT Signing ---
    // Stores the ECC P-256 private key (PKCS#8 PEM format).
    // The first deploy creates an empty secret.
    // Run scripts/generate-key.js after deploy to populate it.

    const signingSecret = new secretsmanager.Secret(this, 'JwtSigningSecret', {
      description: 'ECC P-256 private key for local JWT signing in the Ingestion Lambda',
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
        KMS_KEY_ID: signingKey.keyId,
      },
      bundling: {
        target: 'es2022',
        format: lambdaNodejs.OutputFormat.ESM,
        sourceMap: true,
      },
    });

    table.grantWriteData(ingestionFn);
    signingKey.grant(ingestionFn, 'kms:GetPublicKey');
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

    new cdk.CfnOutput(this, 'KmsKeyId', {
      value: signingKey.keyId,
      description: 'KMS key ID (for public key retrieval)',
    });

    new cdk.CfnOutput(this, 'SigningSecretName', {
      value: signingSecret.secretName,
      description: 'Secrets Manager secret name (populate via scripts/generate-key.js after deploy)',
    });

    new cdk.CfnOutput(this, 'IngestionApiUrl', {
      value: api.url!,
      description: 'API Gateway URL for the ingestion endpoint',
    });
  }
}
