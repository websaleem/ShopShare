#!/usr/bin/env bash
set -euo pipefail
# Usage: ./package_and_deploy.sh <stack-name> <bedrock-model-id>
#
# The backend CloudFormation template now creates its own S3 bucket,
# DynamoDB table, Cognito pool, and Lambda Function URL.
STACK_NAME=${1:-shopshare-stack}
BEDROCK_MODEL_ID=${2:-}
TEMPLATE=../../infra/shopshare-backend.yml

if [[ -z "$BEDROCK_MODEL_ID" ]]; then
  echo "Usage: $0 <stack-name> <bedrock-model-id>"
  exit 1
fi

# Deploy (no packaging step needed — the template uses inline ZipFile placeholder)
aws cloudformation deploy \
  --template-file "$TEMPLATE" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --parameter-overrides BedrockModelId="$BEDROCK_MODEL_ID"

# Output stack info
aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs" --output table

# Export stack outputs to SSM Parameter Store for CI/CD builds
echo "Exporting stack outputs to SSM Parameter Store..."
API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='FunctionUrl'].OutputValue" --output text)
POOL_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" --output text)

PREFIX="/shopshare"
if [[ "$STACK_NAME" == *"dev"* ]]; then
  PREFIX="/shopshare/dev"
else
  aws ssm put-parameter --name "/shopshare/prod/api-url" --value "$API_URL" --type String --overwrite
  aws ssm put-parameter --name "/shopshare/prod/cognito-user-pool-id" --value "$POOL_ID" --type String --overwrite
  aws ssm put-parameter --name "/shopshare/prod/cognito-client-id" --value "$CLIENT_ID" --type String --overwrite
  aws ssm put-parameter --name "/shopshare/mobile/cognito-user-pool-id" --value "$POOL_ID" --type String --overwrite
fi

aws ssm put-parameter --name "${PREFIX}/api-url" --value "$API_URL" --type String --overwrite
aws ssm put-parameter --name "${PREFIX}/cognito-user-pool-id" --value "$POOL_ID" --type String --overwrite
aws ssm put-parameter --name "${PREFIX}/cognito-client-id" --value "$CLIENT_ID" --type String --overwrite
echo "SSM Parameter Store updated successfully."
