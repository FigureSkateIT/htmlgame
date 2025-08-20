import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { CONSTANTS } from '../../config/shared';

export interface HttpApiProps {
  apiBasePath: string;
  putFn: lambda.IFunction;
  getFn: lambda.IFunction;
}

export function createHttpApi(scope: Construct, props: HttpApiProps) {
  const logGroup = new logs.LogGroup(scope, 'ApiAccessLogs', {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const api = new apigwv2.HttpApi(scope, 'ScoreApi', {
    createDefaultStage: false,
    corsPreflight: {
      allowOrigins: [`https://${CONSTANTS.SUB_DOMAIN}.${CONSTANTS.ROOT_DOMAIN}`],
      allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.PUT],
      allowHeaders: [
        'Content-Type',
        'X-Token-Start',
        'X-Token-End',
        'X-Score',
        'X-Player',
        'X-Sig',
        'X-Idem-Key',
      ],
      allowCredentials: true,
    },
  });

  const putInt = new integrations.HttpLambdaIntegration('PutInt', props.putFn);
  const getInt = new integrations.HttpLambdaIntegration('GetInt', props.getFn);

  const putRoute = api.addRoutes({
    path: `${props.apiBasePath}/scores/{gameId}/{period}/{userId}`,
    methods: [apigwv2.HttpMethod.PUT],
    integration: putInt,
  });

  const getRoute = api.addRoutes({
    path: `${props.apiBasePath}/ranking/{gameId}/{period}`,
    methods: [apigwv2.HttpMethod.GET],
    integration: getInt,
  });

  new apigwv2.CfnStage(scope, 'ScoreApiStage', {
    apiId: api.apiId,
    stageName: 'prod',
    defaultRouteSettings: {
      throttlingRateLimit: 2,
      throttlingBurstLimit: 5,
    },
    accessLogSettings: {
      destinationArn: logGroup.logGroupArn,
      format: JSON.stringify({
        requestId: '$context.requestId',
        ip: '$context.identity.sourceIp',
        requestTime: '$context.requestTime',
        httpMethod: '$context.httpMethod',
        routeKey: '$context.routeKey',
        status: '$context.status',
        protocol: '$context.protocol',
        responseLength: '$context.responseLength',
        error: '$context.error.message',
        integrationError: '$context.integrationErrorMessage',
      }),
    },
  });

  NagSuppressions.addResourceSuppressions(api, [
    {
      id: 'AwsSolutions-APIG4',
      reason: 'CloudFront Functionsで認証を実装済み',
    },
  ]);

  NagSuppressions.addResourceSuppressions(putRoute, [
    {
      id: 'AwsSolutions-APIG4',
      reason: 'CloudFront Functionsで認証を実装済み',
    },
  ]);

  NagSuppressions.addResourceSuppressions(getRoute, [
    {
      id: 'AwsSolutions-APIG4',
      reason: 'CloudFront Functionsで認証を実装済み',
    },
  ]);

  return { api };
}
