import * as route53 from 'aws-cdk-lib/aws-route53';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

export interface Route53RecordsProps {
  zone: route53.IHostedZone;
  deployDomain: string;
  distribution: cloudfront.Distribution;
}

export function addRoute53Records(scope: Construct, props: Route53RecordsProps): void {
  const recordProps = {
    zone: props.zone,
    recordName: props.deployDomain,
    target: route53.RecordTarget.fromAlias(new CloudFrontTarget(props.distribution)),
  };

  new route53.ARecord(scope, 'ARecord', recordProps);
  new route53.AaaaRecord(scope, 'AaaaRecord', recordProps);
}
