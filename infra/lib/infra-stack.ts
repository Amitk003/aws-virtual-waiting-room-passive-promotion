import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- DynamoDB Table ---

    const table = new dynamodb.Table(this, 'VirtualWaitingRoom', {
      tableName: 'VirtualWaitingRoom',
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

    // --- KMS Asymmetric Key for JWT Signing ---

    const signingKey = new kms.Key(this, 'JwtSigningKey', {
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      description: 'Asymmetric key for signing JWT tokens in the Virtual Waiting Room',
    });
    signingKey.addAlias('alias/virtual-waiting-room-jwt-signing');

    // --- IAM Roles (Least Privilege) ---

    // Ingestion Lambda: write QueueTicket items and sign JWTs
    const ingestionRole = new iam.Role(this, 'IngestionLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the ingestion Lambda - write tickets and sign JWTs',
    });
    table.grantWriteData(ingestionRole);
    signingKey.grantSign(ingestionRole);
    ingestionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Aggregator Stream Lambda: read stream, update GlobalState metadata
    const aggregatorRole = new iam.Role(this, 'AggregatorLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the Stream Aggregator Lambda - process stream and update metadata',
    });
    table.grantStreamRead(aggregatorRole);
    table.grantWriteData(aggregatorRole);
    aggregatorRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Status API Lambda: read GlobalState item
    const statusRole = new iam.Role(this, 'StatusApiLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the Status API Lambda - read global state',
    });
    table.grantReadData(statusRole);
    statusRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Slot Handler Lambda: create/delete session items, update counter
    const slotRole = new iam.Role(this, 'SlotHandlerLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the Slot Handler Lambda - manage checkout sessions',
    });
    table.grantWriteData(slotRole);
    slotRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Promotion Loop Lambda: read metadata, update watermark
    const promotionRole = new iam.Role(this, 'PromotionLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the Promotion Loop Lambda - advance watermark',
    });
    table.grantReadData(promotionRole);
    table.grantWriteData(promotionRole);
    promotionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Reconciliation Lambda: query GSI and correct counter drift
    const reconciliationRole = new iam.Role(this, 'ReconciliationLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for the Reconciliation Lambda - correct counter drift',
    });
    table.grantReadData(reconciliationRole);
    table.grantWriteData(reconciliationRole);
    reconciliationRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // --- Outputs ---

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value: table.tableArn,
      description: 'DynamoDB table ARN',
    });

    new cdk.CfnOutput(this, 'SigningKeyId', {
      value: signingKey.keyId,
      description: 'KMS signing key ID',
    });

    new cdk.CfnOutput(this, 'SigningKeyArn', {
      value: signingKey.keyArn,
      description: 'KMS signing key ARN',
    });
  }
}
