#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FrontStack } from '../lib/front-stack';
import { UsStack } from '../lib/us-stack';
import { CONSTANTS } from '../config/shared';

// 環境変数から必要な情報を取得
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;
const githubRepo = process.env.GITHUB_REPOSITORY;

if (!account || !region || !githubRepo) {
  throw new Error('invalid prosess.env');
}

// CDKアプリケーション作成
const app = new cdk.App();

// CDK Nag追加
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

cdk.Tags.of(app).add('Project', `${CONSTANTS.PROJECT_NAME}`);

const env = {
  account: account,
  region: region,
};

// USスタック作成（証明書とホストゾーン）
const usStack = new UsStack(app, `${CONSTANTS.PROJECT_NAME}UsStack`, {
  env: { ...env, region: 'us-east-1' },
});

// フロントエンドスタックの作成
const frontStack = new FrontStack(app, `${CONSTANTS.PROJECT_NAME}FrontStack`, {
  env: env,
  githubRepo: githubRepo,
});

frontStack.addDependency(usStack);
