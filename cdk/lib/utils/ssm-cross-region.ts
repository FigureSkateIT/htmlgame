import * as cdk from 'aws-cdk-lib';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface CrossRegionSsmParameterProps {
  parameterName: string;
  region: string;
}

/**
 * クロスリージョンでSSMパラメータの値を取得する共通関数
 */
export function getCrossRegionSsmParameter(
  scope: Construct,
  id: string,
  props: CrossRegionSsmParameterProps
): string {
  // カスタム実行ロールを作成（AWS管理ポリシーを使用しない）
  const customRole = new iam.Role(scope, `${id}Role`, {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    inlinePolicies: {
      CustomResourcePolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['ssm:GetParameter'],
            resources: [
              `arn:aws:ssm:${props.region}:${cdk.Stack.of(scope).account}:parameter${props.parameterName}`,
            ],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [
              `arn:aws:logs:${props.region}:${cdk.Stack.of(scope).account}:log-group:/aws/lambda/*`,
            ],
          }),
        ],
      }),
    },
  });

  const ssmLookup = new cr.AwsCustomResource(scope, id, {
    onUpdate: {
      service: 'SSM',
      action: 'getParameter',
      region: props.region,
      parameters: {
        Name: props.parameterName,
      },
      physicalResourceId: cr.PhysicalResourceId.of(`${props.parameterName}-${props.region}`),
    },
    role: customRole, // カスタムロールのみ指定（policyは不要）
  });

  // CDK Nag抑制：Lambdaロググループのワイルドカード権限
  NagSuppressions.addResourceSuppressions(customRole, [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'Lambda function requires wildcard permissions for CloudWatch log groups creation',
      appliesTo: [
        `Resource::arn:aws:logs:${props.region}:${cdk.Stack.of(scope).account}:log-group:/aws/lambda/*`,
      ],
    },
  ]);

  return ssmLookup.getResponseField('Parameter.Value');
}
