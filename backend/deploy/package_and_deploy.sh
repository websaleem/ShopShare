#!/usr/bin/env bash
set -euo pipefail
# Usage: ./package_and_deploy.sh <stack-name> <bedrock-model-id>
#
# The backend CloudFormation template now creates its own S3 bucket,
# DynamoDB table, Cognito pool, and Lambda Function URL.
STACK_NAME=${1:-shopshare-stack}
BEDROCK_MODEL_ID=${2:-}
TEMPLATE=../cloudformation/shopshare-backend.yml

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
