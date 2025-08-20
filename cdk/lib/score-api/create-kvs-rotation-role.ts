import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { CONSTANTS } from '../../config/shared';

export interface KvsRotationRoleProps {
  githubRepo: string;
  kvs: cloudfront.KeyValueStore;
}

export function createKvsRotationRole(scope: Construct, props: KvsRotationRoleProps): iam.Role {
  const stack = cdk.Stack.of(scope);

  // IAMロール（GitHub ActionsがAssumeできる）
  const kvsRotationRole = new iam.Role(scope, 'GitHubActionsKvsRotationRole', {
    roleName: `${CONSTANTS.PROJECT_NAME.toLowerCase()}-kvs-rotation-role-for-github`,
    assumedBy: new iam.WebIdentityPrincipal(
      `arn:aws:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`,
      {
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${props.githubRepo}:ref:refs/heads/main`,
            `repo:${props.githubRepo}:ref:refs/heads/dev`,
          ],
        },
      }
    ),
    description: 'GitHub Actions role for KVS secret rotation',
  });

  // CloudFront KVS権限
  kvsRotationRole.addToPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cloudfront-keyvaluestore:DescribeKeyValueStore',
        'cloudfront-keyvaluestore:GetKey',
        'cloudfront-keyvaluestore:PutKey',
      ],
      resources: [props.kvs.keyValueStoreArn],
    })
  );

  // SSMパラメータ読み取り権限
  kvsRotationRole.addToPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:us-east-1:${stack.account}:parameter/htmlgame/score-api/kvs-arn`],
    })
  );

  // SSMパラメータ作成（KVS ARN）
  new ssm.StringParameter(scope, 'KvsArnParam', {
    parameterName: '/htmlgame/score-api/kvs-arn',
    stringValue: props.kvs.keyValueStoreArn,
  });

  // CDK Nag抑制ルール
  NagSuppressions.addResourceSuppressions(kvsRotationRole, [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'KVS secret rotation requires specific CloudFront KVS permissions.',
    },
  ]);

  return kvsRotationRole;
}