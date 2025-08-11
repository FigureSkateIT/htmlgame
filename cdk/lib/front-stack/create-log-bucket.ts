import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

export function createLogBucket(scope: Construct): s3.Bucket {
  const bucket = new s3.Bucket(scope, 'LogBucket00', {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
    versioned: true,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    lifecycleRules: [
      {
        enabled: true,
        expiration: cdk.Duration.days(90), // 3ヶ月で削除
        noncurrentVersionExpiration: cdk.Duration.days(30),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      },
    ],
  });

  NagSuppressions.addResourceSuppressions(bucket, [
    {
      id: 'AwsSolutions-S1',
      reason: 'access log of access log bucket is not required.',
    },
  ]);

  return bucket;
}
