import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { createScoreTable } from './score-api/create-score-table';
import { createLambdaFunctions } from './score-api/create-lambda-functions';
import { createHttpApi } from './score-api/create-http-api';
import {
  createCloudFrontFunctions,
  patchCloudFrontAssociations,
} from './score-api/create-cloudfront-functions';
import { createEventSchedule } from './score-api/create-event-schedule';
import { readFrontCfDistId, manageSsmParameters } from './score-api/manage-ssm-parameters';
import * as pathsConfig from '../../config/paths.json';

export class ScoreApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const apiBasePath = pathsConfig.API_BASE_PATH;

    // DynamoDB テーブル作成
    const table = createScoreTable(this);

    // Lambda 関数作成
    const { putScoreFn, getRankingFn, trimTopFn } = createLambdaFunctions(this, { table });

    // HTTP API 作成
    const { api } = createHttpApi(this, {
      apiBasePath,
      putFn: putScoreFn,
      getFn: getRankingFn,
    });

    // CloudFront Functions 作成
    const { kvs, cfGetStart, cfGetEnd, cfValidate } = createCloudFrontFunctions(this, {
      githubRepo: process.env.GITHUB_REPOSITORY || 'default/repo',
    });

    // 既存 CloudFront Distribution ID を取得
    const distId = readFrontCfDistId(this);

    // CloudFront Association パッチ
    patchCloudFrontAssociations(this, {
      distId,
      apiBasePath,
      functions: { cfGetStart, cfGetEnd, cfValidate },
    });

    // 日次スケジュール作成
    createEventSchedule(this, trimTopFn);

    // SSM パラメータにエクスポート
    manageSsmParameters(this, {
      apiEndpoint: `${api.apiEndpoint}${apiBasePath}`,
      tableName: table.tableName,
      putArn: putScoreFn.functionArn,
      getArn: getRankingFn.functionArn,
      trimArn: trimTopFn.functionArn,
      cfFunctionsCsv: [
        cfGetStart.functionName,
        cfGetEnd.functionName,
        cfValidate.functionName,
      ].join(','),
      kvsArn: kvs.keyValueStoreArn,
    });
  }
}
