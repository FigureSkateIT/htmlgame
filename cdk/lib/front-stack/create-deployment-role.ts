import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { CONSTANTS } from '../../config/shared';

export interface DeploymentRoleProps {
  githubRepo: string;
  bucket: s3.Bucket;
  distribution: cloudfront.Distribution;
}

export function createDeploymentRole(scope: Construct, props: DeploymentRoleProps): iam.Role {
  const stack = cdk.Stack.of(scope);

  // IAMロール（GitHub ActionsがAssumeできる）
  const githubDeployRole = new iam.Role(scope, 'GitHubActionsDeployRole', {
    roleName: `${CONSTANTS.PROJECT_NAME.toLowerCase()}-front-deploy-role-for-github`,
    assumedBy: new iam.WebIdentityPrincipal(
      `arn:aws:iam::${stack.account}:oidc-provider/token.actions.githubusercontent.com`,
      {
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${props.githubRepo}:ref:refs/heads/main`,
        },
      }
    ),
    description: 'GitHub Actions role for deploying static site',
  });

  // S3へのアクセス権限を付与
  props.bucket.grantReadWrite(githubDeployRole);

  // SSMパラメータアクセス権限
  const ssmArn = `arn:aws:ssm:${stack.region}:${stack.account}:*`;

  githubDeployRole.addToPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [ssmArn],
    })
  );

  // CloudFront無効化権限
  githubDeployRole.addToPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      resources: [
        `arn:aws:cloudfront::${stack.account}:distribution/${props.distribution.distributionId}`,
      ],
    })
  );

  // SSMパラメータ作成
  new ssm.StringParameter(scope, 'S3BucketParam', {
    parameterName: CONSTANTS.SSM_PARAMETERS.S3_BUCKET,
    stringValue: props.bucket.bucketName,
  });

  new ssm.StringParameter(scope, 'CfDistIdParam', {
    parameterName: CONSTANTS.SSM_PARAMETERS.CF_DIST_ID,
    stringValue: props.distribution.distributionId,
  });

  // CDK Nag抑制ルール（IAMワイルドカード権限）
  NagSuppressions.addResourceSuppressions(
    githubDeployRole.node.findChild('DefaultPolicy') as iam.Policy,
    [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Wildcard permissions are required for GitHub Actions to deploy static site content to S3 and manage CloudFront invalidations.',
      },
    ]
  );

  return githubDeployRole;
}
