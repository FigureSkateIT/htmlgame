import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';

export function createResponseHeadersPolicy(scope: Construct): cloudfront.ResponseHeadersPolicy {
  const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
    scope,
    'ResponseHeadersPolicy',
    {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(1),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        xssProtection: {
          protection: true,
          modeBlock: true,
          override: true,
        },
        contentSecurityPolicy: {
          contentSecurityPolicy: `default-src 'self' 'unsafe-inline';style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none';`,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Cache-Control',
            value: 'no-cache',
            override: true,
          },
          {
            header: 'pragma',
            value: 'no-cache',
            override: true,
          },
          {
            header: 'server',
            value: '',
            override: true,
          },
        ],
      },
    }
  );
  return responseHeadersPolicy;
}
