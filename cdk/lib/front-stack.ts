import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { createS3Bucket } from './front-stack/create-s3-bucket';
import { createCloudFront } from './front-stack/create-cloudfront';
import { addRoute53Records } from './front-stack/add-route53-records';
import { createDeploymentRole } from './front-stack/create-deployment-role';
import { createLogBucket } from './front-stack/create-log-bucket';
import { getCrossRegionSsmParameter } from './utils/ssm-cross-region';
import { CONSTANTS } from '../config/shared';

interface FrontStackProps extends cdk.StackProps {
  githubRepo: string;
}

export class FrontStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FrontStackProps) {
    super(scope, id, props);

    // スタック間参照問題の解決方法：
    // - USスタックで証明書を作成し、SSMパラメータに保存
    // - クロスリージョンカスタムリソースでSSMパラメータを参照
    // - これによりスタック間の直接的な依存関係を排除し、独立したデプロイ・削除が可能

    const rootDomain = CONSTANTS.ROOT_DOMAIN;
    const deployDomain = `${CONSTANTS.SUB_DOMAIN}.${rootDomain}`;

    // us-east-1リージョンのSSMパラメータから証明書ARNを取得
    const certificateArn = getCrossRegionSsmParameter(this, 'CertificateArnLookup', {
      parameterName: CONSTANTS.SSM_PARAMETERS.CERTIFICATE_ARN,
      region: 'us-east-1',
    });
    const cert = acm.Certificate.fromCertificateArn(this, 'ImportedCertificate', certificateArn);

    // ホストゾーンをドメイン名から取得
    const zone = route53.HostedZone.fromLookup(this, 'ImportedHostedZone', {
      domainName: rootDomain,
    });

    // アクセスログ用バケット作成
    const LogBucket = createLogBucket(this);

    // S3バケット作成
    const bucket = createS3Bucket(this, {
      bucketName: `FrontBucket00`,
      accessLogBucket: LogBucket,
    });

    // CloudFrontディストリビューション作成
    const distribution = createCloudFront(this, {
      bucket: bucket,
      cert: cert,
      deployDomain: deployDomain,
      accessLogBucket: LogBucket,
    });

    // Route53レコード作成
    addRoute53Records(this, {
      zone: zone,
      deployDomain: deployDomain,
      distribution: distribution,
    });

    // GitHub Actions用デプロイロール作成
    createDeploymentRole(this, {
      githubRepo: props.githubRepo,
      bucket: bucket,
      distribution: distribution,
    });

    // 確認用にCloudFrontのURLを出力
    new cdk.CfnOutput(this, 'my-Website-URL', {
      value: 'https://' + distribution.distributionDomainName,
    });
  }
}
