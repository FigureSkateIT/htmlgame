import * as cdk from 'aws-cdk-lib';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { CONSTANTS } from '../../config/shared';

export function createScoreTable(scope: Construct): ddb.TableV2 {
  const table = new ddb.TableV2(scope, 'ScoreTable', {
    partitionKey: { name: 'gameName', type: ddb.AttributeType.STRING },
    sortKey: { name: 'userId', type: ddb.AttributeType.STRING },
    billing: ddb.Billing.onDemand(),
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    pointInTimeRecovery: false, // 最小コスト運用のため
    tableName: CONSTANTS.TABLE_NAME,
    encryption: ddb.TableEncryptionV2.awsManagedKey(),
  });

  NagSuppressions.addResourceSuppressions(table, [
    {
      id: 'AwsSolutions-DDB3',
      reason: '最小コスト運用のためPITRは無効化。Top100運用で重要データではない',
    },
  ]);

  return table;
}
