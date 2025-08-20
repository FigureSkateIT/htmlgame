import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { createKvsRotationRole } from './create-kvs-rotation-role';

export interface CloudFrontFunctionsProps {
  githubRepo: string;
}

export function createCloudFrontFunctions(scope: Construct, props: CloudFrontFunctionsProps) {
  const kvs = new cloudfront.KeyValueStore(scope, 'CfgThrKVS', {
    keyValueStoreName: 'cfgthr',
  });

  const cfGetStart = new cloudfront.Function(scope, 'CfGetStart', {
    code: cloudfront.FunctionCode.fromFile({
      filePath: 'asset/cf-funcs/get-start.js',
    }),
    keyValueStore: kvs,
  });

  const cfGetEnd = new cloudfront.Function(scope, 'CfGetEnd', {
    code: cloudfront.FunctionCode.fromFile({
      filePath: 'asset/cf-funcs/get-end.js',
    }),
    keyValueStore: kvs,
  });

  const cfValidate = new cloudfront.Function(scope, 'CfValidate', {
    code: cloudfront.FunctionCode.fromFile({
      filePath: 'asset/cf-funcs/validate.js',
    }),
    keyValueStore: kvs,
  });

  // KVS rotation role for GitHub Actions
  const kvsRotationRole = createKvsRotationRole(scope, {
    githubRepo: props.githubRepo,
    kvs,
  });

  return { kvs, cfGetStart, cfGetEnd, cfValidate, kvsRotationRole };
}

export interface CloudFrontAssociationProps {
  distId: string;
  apiBasePath: string;
  functions: {
    cfGetStart: cloudfront.Function;
    cfGetEnd: cloudfront.Function;
    cfValidate: cloudfront.Function;
  };
}

export function patchCloudFrontAssociations(scope: Construct, props: CloudFrontAssociationProps) {
  const customRole = new iam.Role(scope, 'PatchCfAssocRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    inlinePolicies: {
      CloudFrontPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: ['cloudfront:GetDistributionConfig', 'cloudfront:UpdateDistribution'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [`arn:aws:logs:*:${cdk.Stack.of(scope).account}:log-group:/aws/lambda/*`],
          }),
        ],
      }),
    },
  });

  NagSuppressions.addResourceSuppressions(customRole, [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'CloudFront操作に必要なワイルドカード権限',
    },
  ]);

  return new cr.AwsCustomResource(scope, 'PatchCfAssoc', {
    onUpdate: {
      service: 'CloudFront',
      action: 'updateDistribution',
      parameters: {
        Id: props.distId,
        DistributionConfig: {
          // 実際の実装では、GetDistributionConfigの結果を使用してパッチを適用
          // ここでは簡略化
        },
      },
      physicalResourceId: cr.PhysicalResourceId.of('PatchCfAssocV1'),
    },
    role: customRole,
  });
}
