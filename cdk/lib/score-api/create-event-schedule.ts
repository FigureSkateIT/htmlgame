import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export function createEventSchedule(scope: Construct, trimFn: lambda.IFunction) {
  const rule = new events.Rule(scope, 'TrimTopDaily', {
    schedule: events.Schedule.rate(cdk.Duration.days(1)),
  });

  rule.addTarget(new targets.LambdaFunction(trimFn));

  return rule;
}
