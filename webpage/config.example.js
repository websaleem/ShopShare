/*
 * ShopShare configuration — generated at deploy time.
 *
 * DO NOT commit real values to this file. The CI/CD pipeline generates
 * this file from SSM Parameter Store during deployment.
 *
 * For local development, copy config.example.js to config.js and fill
 * in your own values.
 */
const SHOPSHARE_CONFIG = {
    API_BASE_URL: "__API_BASE_URL__",
    COGNITO_USER_POOL_ID: "__COGNITO_USER_POOL_ID__",
    COGNITO_CLIENT_ID: "__COGNITO_CLIENT_ID__"
};
