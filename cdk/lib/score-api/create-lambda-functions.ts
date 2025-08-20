import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { CONSTANTS } from '../../config/shared';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface LambdaFunctionsProps {
  table: ddb.Table;
}

const nodeOpts: lambdaNode.NodejsFunctionProps = {
  runtime: lambda.Runtime.NODEJS_22_X,
  bundling: {
    minify: true,
    externalModules: ['@aws-sdk/*'],
  },
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
};

export function createLambdaFunctions(scope: Construct, props: LambdaFunctionsProps) {
  const s3BucketName = ssm.StringParameter.valueFromLookup(
    scope,
    CONSTANTS.SSM_PARAMETERS.S3_BUCKET
  );
  const putScoreLogGroup = new logs.LogGroup(scope, 'PutScoreLogGroup', {
    retention: logs.RetentionDays.THREE_MONTHS,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const getRankingLogGroup = new logs.LogGroup(scope, 'GetRankingLogGroup', {
    retention: logs.RetentionDays.THREE_MONTHS,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const trimTopLogGroup = new logs.LogGroup(scope, 'TrimTopLogGroup', {
    retention: logs.RetentionDays.THREE_MONTHS,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  // IAM Roles
  const putScoreRole = new iam.Role(scope, 'HtmlgamePutScoreRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    roleName: `${CONSTANTS.PROJECT_NAME}-Lambda-PutScore-Role`,
    inlinePolicies: {
      LogsPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [putScoreLogGroup.logGroupArn],
          }),
        ],
      }),
      DynamoDBPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
            resources: [props.table.tableArn],
          }),
        ],
      }),
      S3Policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [`arn:aws:s3:::${s3BucketName}/${CONSTANTS.GAME_CONFIG_PATH}`],
          }),
        ],
      }),
      CloudFrontPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['cloudfront:CreateInvalidation'],
            resources: ['*'],
          }),
        ],
      }),
    },
  });

  const getRankingRole = new iam.Role(scope, 'HtmlgameGetRankingRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    roleName: `${CONSTANTS.PROJECT_NAME}-Lambda-GetRanking-Role`,
    inlinePolicies: {
      LogsPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [getRankingLogGroup.logGroupArn],
          }),
        ],
      }),
      DynamoDBPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['dynamodb:Query', 'dynamodb:Scan'],
            resources: [props.table.tableArn],
          }),
        ],
      }),
      S3Policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [`arn:aws:s3:::${s3BucketName}/${CONSTANTS.GAME_CONFIG_PATH}`],
          }),
        ],
      }),
    },
  });

  const trimTopRole = new iam.Role(scope, 'HtmlgameTrimTopRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    roleName: `${CONSTANTS.PROJECT_NAME}-Lambda-TrimTop-Role`,
    inlinePolicies: {
      LogsPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [trimTopLogGroup.logGroupArn],
          }),
        ],
      }),
      DynamoDBPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['dynamodb:Query', 'dynamodb:Scan', 'dynamodb:DeleteItem'],
            resources: [props.table.tableArn],
          }),
        ],
      }),
      S3Policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [`arn:aws:s3:::${s3BucketName}/${CONSTANTS.GAME_CONFIG_PATH}`],
          }),
        ],
      }),
      CloudFrontPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['cloudfront:DescribeKeyValueStore', 'cloudfront:UpdateKeyValueStore'],
            resources: ['*'],
          }),
        ],
      }),
    },
  });
  const putScoreFn = new lambdaNode.NodejsFunction(scope, 'PutScoreFn', {
    entry: 'asset/lambdas/put-score/handler.ts',
    ...nodeOpts,
    role: putScoreRole,
    logGroup: putScoreLogGroup,
    environment: {
      TABLE_NAME: props.table.tableName,
      EDGE_AUTH_HEADER: 'X-Edge-Auth',
      S3_BUCKET: s3BucketName,
      GAME_CONFIG_PATH: CONSTANTS.GAME_CONFIG_PATH,
    },
  });

  const getRankingFn = new lambdaNode.NodejsFunction(scope, 'GetRankingFn', {
    entry: 'asset/lambdas/get-ranking/handler.ts',
    ...nodeOpts,
    role: getRankingRole,
    logGroup: getRankingLogGroup,
    environment: {
      TABLE_NAME: props.table.tableName,
      S3_BUCKET: s3BucketName,
      GAME_CONFIG_PATH: CONSTANTS.GAME_CONFIG_PATH,
    },
  });

  const trimTopFn = new lambdaNode.NodejsFunction(scope, 'TrimTopFn', {
    entry: 'asset/lambdas/trim-top/handler.ts',
    ...nodeOpts,
    role: trimTopRole,
    logGroup: trimTopLogGroup,
    environment: {
      TABLE_NAME: props.table.tableName,
      KVS_NAME: CONSTANTS.KVS_NAME,
      S3_BUCKET: s3BucketName,
      GAME_CONFIG_PATH: CONSTANTS.GAME_CONFIG_PATH,
    },
  });

  NagSuppressions.addResourceSuppressions(
    [putScoreRole, getRankingRole, trimTopRole],
    [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CloudFront操作に必要なワイルドカード権限',
      },
    ]
  );

  return { putScoreFn, getRankingFn, trimTopFn };
}
