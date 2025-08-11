import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export interface S3BucketProps {
  bucketName: string;
  accessLogBucket?: s3.Bucket;
}

export function createS3Bucket(scope: Construct, props: S3BucketProps): s3.Bucket {
  const bucketProps: s3.BucketProps = {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    versioned: true,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    publicReadAccess: false,
    lifecycleRules: [
      {
        enabled: true,
        noncurrentVersionExpiration: cdk.Duration.days(30),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      },
    ],
    serverAccessLogsBucket: props.accessLogBucket,
    serverAccessLogsPrefix: props.bucketName.toLowerCase(),
  };

  const bucket = new s3.Bucket(scope, props.bucketName, bucketProps);

  // CDK Nag抑制ルール（アクセスログが設定されていない場合のみ）
  if (!props.accessLogBucket) {
    NagSuppressions.addResourceSuppressions(bucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Access logging is intentionally disabled for this static site bucket to reduce costs.',
      },
    ]);
  }

  return bucket;
}
