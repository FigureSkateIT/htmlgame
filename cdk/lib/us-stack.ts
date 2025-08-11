import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { CONSTANTS } from '../config/shared';

export class UsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // USリージョンでCloudFront用の証明書を作成
    // スタック間参照を避けるため、ARNを出力して環境変数経由で他スタックに渡す

    const rootDomain = CONSTANTS.ROOT_DOMAIN;
    const deployDomain = `${CONSTANTS.SUB_DOMAIN}.${rootDomain}`;

    // Route 53 ホストゾーンの取得
    const zone = route53.HostedZone.fromLookup(this, 'my-hosted-zone', {
      domainName: rootDomain,
    });

    // TLS証明書の作成（CloudFront用にus-east-1リージョンで作成）
    const cert = new acm.Certificate(this, 'my-certificate', {
      domainName: deployDomain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // 証明書ARNをSSMパラメータに保存（クロスリージョン参照用）
    new ssm.StringParameter(this, 'CertificateArnParameter', {
      parameterName: CONSTANTS.SSM_PARAMETERS.CERTIFICATE_ARN,
      stringValue: cert.certificateArn,
      description: 'Certificate ARN for CloudFront cross-region reference',
    });
  }
}
