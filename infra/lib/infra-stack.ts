import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
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

    // --- Stream Aggregator Lambda ---

    const aggregatorFn = new lambdaNodejs.NodejsFunction(this, 'StreamAggregator', {
      entry: path.join(projectRoot, 'services', 'aggregator', 'src', 'index.ts'),
      projectRoot,
      depsLockFilePath: path.join(projectRoot, 'services', 'aggregator', 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      environment: {
        TABLE_NAME: table.tableName,
      },
      bundling: {
        target: 'es2022',
        format: lambdaNodejs.OutputFormat.ESM,
        sourceMap: true,
      },
    });

    table.grantWriteData(aggregatorFn);

    aggregatorFn.addEventSource(new lambdaEventSources.DynamoEventSource(table, {
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      retryAttempts: 3,
    }));

    // --- Status Polling Lambda ---
    // Verifies JWT and returns admission status and queue position.
    // Reads GlobalState and queries all 20 DensityBucket shards in parallel.

    const statusFn = new lambdaNodejs.NodejsFunction(this, 'StatusHandler', {
      entry: path.join(projectRoot, 'services', 'status-api', 'src', 'index.ts'),
      projectRoot,
      depsLockFilePath: path.join(projectRoot, 'services', 'status-api', 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
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

    table.grantReadData(statusFn);
    signingSecret.grantRead(statusFn);

    // --- Slot Handler Lambda ---
    // POST /claim  - Creates a SessionItem and increments ActivePurchaserCount (capped at 1000)
    // POST /release - Deletes a SessionItem and decrements ActivePurchaserCount

    const slotFn = new lambdaNodejs.NodejsFunction(this, 'SlotHandler', {
      entry: path.join(projectRoot, 'services', 'slot-handler', 'src', 'index.ts'),
      projectRoot,
      depsLockFilePath: path.join(projectRoot, 'services', 'slot-handler', 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
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

    table.grantReadWriteData(slotFn);
    signingSecret.grantRead(slotFn);

    // --- Reconciliation Lambda ---
    // Runs every 5 minutes to correct ActivePurchaserCount drift.

    const reconciliationFn = new lambdaNodejs.NodejsFunction(this, 'ReconciliationHandler', {
      entry: path.join(projectRoot, 'services', 'reconciliation', 'src', 'index.ts'),
      projectRoot,
      depsLockFilePath: path.join(projectRoot, 'services', 'reconciliation', 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
      },
      bundling: {
        target: 'es2022',
        format: lambdaNodejs.OutputFormat.ESM,
        sourceMap: true,
      },
    });

    table.grantReadWriteData(reconciliationFn);

    new events.Rule(this, 'ReconciliationSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventTargets.LambdaFunction(reconciliationFn)],
    });

    // --- Promotion Engine Lambda ---
    // Runs every 1 second. Reads the density map and advances
    // AdmittedUntilTimestamp to admit users as checkout slots free up.

    const promotionFn = new lambdaNodejs.NodejsFunction(this, 'PromotionEngine', {
      entry: path.join(projectRoot, 'services', 'promotion', 'src', 'index.ts'),
      projectRoot,
      depsLockFilePath: path.join(projectRoot, 'services', 'promotion', 'package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      environment: {
        TABLE_NAME: table.tableName,
      },
      bundling: {
        target: 'es2022',
        format: lambdaNodejs.OutputFormat.ESM,
        sourceMap: true,
      },
    });

    table.grantReadWriteData(promotionFn);

    new events.Rule(this, 'PromotionSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new eventTargets.LambdaFunction(promotionFn)],
    });

    // --- API Gateway HTTP API ---

    const api = new apigwv2.HttpApi(this, 'WaitingRoomApi', {
      apiName: 'VirtualWaitingRoom-Api',
      corsPreflight: {
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
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

    api.addRoutes({
      path: '/api/v1/event/{eventId}/status',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwIntegrations.HttpLambdaIntegration(
        'StatusIntegration',
        statusFn
      ),
    });

    api.addRoutes({
      path: '/api/v1/event/{eventId}/claim',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwIntegrations.HttpLambdaIntegration(
        'ClaimIntegration',
        slotFn
      ),
    });

    api.addRoutes({
      path: '/api/v1/event/{eventId}/release',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwIntegrations.HttpLambdaIntegration(
        'ReleaseIntegration',
        slotFn
      ),
    });

    // --- CloudFront CDN ---
    // Caches status responses at the edge for reduced latency.
    // Cache key includes the Authorization header (per-user caching).
    // The ingestion POST endpoint is proxied without caching.

    const cachePolicy = new cloudfront.CachePolicy(this, 'StatusCachePolicy', {
      cachePolicyName: 'StatusPolicy',
      comment: 'Short TTL for status polling, per-user via Authorization header',
      defaultTtl: cdk.Duration.seconds(2),
      maxTtl: cdk.Duration.seconds(5),
      minTtl: cdk.Duration.seconds(0),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList('Authorization'),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingGzip: true,
    });

    const distribution = new cloudfront.Distribution(this, 'CdnDistribution', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', api.url!)), {
          originId: 'api-origin',
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/api/v1/event/*/status': {
          origin: new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', api.url!)), {
            originId: 'api-origin-status',
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          }),
          cachePolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      defaultRootObject: '',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
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

    new cdk.CfnOutput(this, 'CdnUrl', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution URL (primary endpoint for clients)',
    });
  }
}
