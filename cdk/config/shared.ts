export const CONSTANTS = {
  PROJECT_NAME: 'Htmlgame',
  ROOT_DOMAIN: 'fsitlab.com',
  SUB_DOMAIN: 'htmlgame',
  KVS_NAME: 'htmlgame-thr',
  TABLE_NAME: 'htmlgame-scores-table',
  GAME_CONFIG_PATH: 'config/game-config.json',
  SSM_PARAMETERS: {
    CERTIFICATE_ARN: '/htmlgame/us-stack/certificate-arn',
    S3_BUCKET: '/htmlgame/front-stack/s3-bucket',
    CF_DIST_ID: '/htmlgame/front-stack/cf-dist-id',
    SCORE_API: {
      API_ENDPOINT: '/htmlgame/score-api/api-endpoint',
      TABLE_NAME: '/htmlgame/score-api/table-name',
      LAMBDA_PUT_ARN: '/htmlgame/score-api/lambda-put-arn',
      LAMBDA_GET_ARN: '/htmlgame/score-api/lambda-get-arn',
      LAMBDA_TRIM_ARN: '/htmlgame/score-api/lambda-trim-arn',
      CF_FUNCTIONS: '/htmlgame/score-api/cf-functions',
      KVS_ARN: '/htmlgame/score-api/kvs-arn',
    },
  },
};
