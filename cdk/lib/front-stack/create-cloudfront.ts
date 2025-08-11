import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { createResponseHeadersPolicy } from './create-response-headers-policy';
import { CONSTANTS } from '../../config/shared';

export interface CloudFrontProps {
  bucket: s3.Bucket;
  cert: acm.ICertificate;
  deployDomain: string;
  accessLogBucket?: s3.Bucket;
}

export function createCloudFront(
  scope: Construct,
  props: CloudFrontProps
): cloudfront.Distribution {
  const myCachePolicy = new cloudfront.CachePolicy(scope, 'myCachepolicy', {
    cachePolicyName: `${CONSTANTS.PROJECT_NAME.toLowerCase()}-default-cache-policy`,
    defaultTtl: cdk.Duration.days(30),
    minTtl: cdk.Duration.days(1),
    maxTtl: cdk.Duration.days(365),
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    headerBehavior: cloudfront.CacheHeaderBehavior.allowList('content-type'),
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    enableAcceptEncodingGzip: true,
    enableAcceptEncodingBrotli: true,
  });

  const origin = S3BucketOrigin.withOriginAccessControl(props.bucket);

  const responseHeadersPolicy = createResponseHeadersPolicy(scope);

  const additionalBehaviors = {
    'data/*': {
      origin: origin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: new cloudfront.CachePolicy(scope, 'myDataCachePolicy', {
        cachePolicyName: `${CONSTANTS.PROJECT_NAME.toLowerCase()}-data-cache-policy`,
        defaultTtl: cdk.Duration.seconds(10),
        maxTtl: cdk.Duration.seconds(60),
        headerBehavior: cloudfront.CacheHeaderBehavior.allowList('content-type'),
      }),
    },
  };

  const fn = new cloudfront.Function(scope, 'DirIndex', {
    code: cloudfront.FunctionCode.fromInline(`
      function handler(event) {
        var req = event.request;
        if (req.uri.endsWith('/')) req.uri += 'index.html';
        return req;
      }`),
  });

  const distributionProps: cloudfront.DistributionProps = {
    defaultRootObject: 'index.html',
    priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    defaultBehavior: {
      origin: origin,
      cachePolicy: myCachePolicy,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy: responseHeadersPolicy,
      functionAssociations: [
        {
          function: fn,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
    },
    additionalBehaviors: additionalBehaviors,
    certificate: props.cert,
    domainNames: [props.deployDomain],
    enableLogging: true,
    logBucket: props.accessLogBucket,
    logFilePrefix: 'cloudfront',
  };

  const myDistribution = new cloudfront.Distribution(
    scope,
    'cloudfront-distribution',
    distributionProps
  );

  // CDK Nag抑制ルール
  NagSuppressions.addResourceSuppressions(myDistribution, [
    {
      id: 'AwsSolutions-CFR1',
      reason: 'Geo restrictions are not required for this static website serving global content.',
    },
    {
      id: 'AwsSolutions-CFR2',
      reason: 'WAF is not required for this static website with no dynamic content or user input.',
    },
  ]);

  return myDistribution;
}
