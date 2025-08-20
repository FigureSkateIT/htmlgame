// import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { CONSTANTS } from '../../config/shared';

export function readFrontCfDistId(scope: Construct): string {
  return ssm.StringParameter.valueForStringParameter(scope, CONSTANTS.SSM_PARAMETERS.CF_DIST_ID);
}

export interface SsmExportValues {
  apiEndpoint: string;
  tableName: string;
  putArn: string;
  getArn: string;
  trimArn: string;
  cfFunctionsCsv: string;
  kvsArn: string;
}

export function manageSsmParameters(scope: Construct, values: SsmExportValues) {
  const base = CONSTANTS.SSM_PARAMETERS.SCORE_API;

  new ssm.StringParameter(scope, 'SsmScoreApiApiEndpoint', {
    parameterName: base.API_ENDPOINT,
    stringValue: values.apiEndpoint,
  });

  new ssm.StringParameter(scope, 'SsmScoreApiTableName', {
    parameterName: base.TABLE_NAME,
    stringValue: values.tableName,
  });

  new ssm.StringParameter(scope, 'SsmScoreApiPutArn', {
    parameterName: base.LAMBDA_PUT_ARN,
    stringValue: values.putArn,
  });

  new ssm.StringParameter(scope, 'SsmScoreApiGetArn', {
    parameterName: base.LAMBDA_GET_ARN,
    stringValue: values.getArn,
  });

  new ssm.StringParameter(scope, 'SsmScoreApiTrimArn', {
    parameterName: base.LAMBDA_TRIM_ARN,
    stringValue: values.trimArn,
  });

  new ssm.StringParameter(scope, 'SsmScoreApiCfFuncs', {
    parameterName: base.CF_FUNCTIONS,
    stringValue: values.cfFunctionsCsv,
  });

  new ssm.StringParameter(scope, 'SsmScoreApiKvsArn', {
    parameterName: base.KVS_ARN,
    stringValue: values.kvsArn,
  });
}
