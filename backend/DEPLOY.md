# Deploying ShopShare to AWS

This is the runbook for the Option-A architecture: a static frontend on **S3 + CloudFront**, plus a **Lambda** (with a Function URL) for AI extraction (Textract + Bedrock). The expected cost at portfolio traffic is **$0–1/month** — well within the AWS Lambda and CloudFront free tiers.

```
                  CloudFront (websaleem.com)
                           │
        ┌──────────────────┴────────────────────┐
        ▼                                       ▼
 /shopshare/*                       /shopshare/api/*
        │                                       │
        ▼                                       ▼
     S3 bucket                          Lambda Function URL
     (static HTML/CSS/JS)               (Python 3.12)
                  │
                  ▼
                  Textract + Bedrock
                (S3 -> Textract -> Bedrock)
```

You need:
- An AWS account with permission to create S3 buckets, Lambda functions, and edit your existing CloudFront distribution.
- The AWS CLI configured (`aws configure`) — all commands below assume `us-east-1`; substitute your region.
- The existing CloudFront distribution that serves `websaleem.com` (`DIST_ID` below).

Substitute these placeholders before running anything:

```bash
export AWS_REGION=us-east-1
export BUCKET=websaleem-static                        # your existing site bucket
export DIST_ID=EXAMPLEDISTID                          # your existing CloudFront dist id
export FN_NAME=shopshare-extract
export FN_ROLE_NAME=shopshare-extract-role
export STATE_TABLE=ShopShareState
export USER_POOL_NAME=ShopShareUsers
export BEDROCK_MODEL_ID=amazon.nova-pro-v1:0   # set to the Bedrock model you will use
```

---

## 1. Package the Lambda

The Lambda is in `aws/lambda/`. The build script installs any required Python packages (none required for the built-in `boto3` use case), copies in `extract.py`, and produces a single `lambda.zip`.

```bash
cd aws/lambda
./build.sh             # → aws/lambda/lambda.zip   (~10 MB)
```

If you choose **arm64** for the Lambda, edit `build.sh` and swap `manylinux2014_x86_64` for `manylinux2014_aarch64`.

---

## 2. Create the Lambda role

A minimal IAM role that lets the function write logs:

```bash
aws iam create-role \
  --role-name "$FN_ROLE_NAME" \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }'

aws iam attach-role-policy \
  --role-name "$FN_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam attach-role-policy \
  --role-name "$FN_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess

aws iam attach-role-policy \
  --role-name "$FN_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonCognitoPowerUser

# Wait ~10 s for IAM to propagate before the Lambda create call.
```

---

## 2a. Create DynamoDB Table

```bash
aws dynamodb create-table \
  --table-name "$STATE_TABLE" \
  --attribute-definitions AttributeName=userId,AttributeType=S \
  --key-schema AttributeName=userId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

---

## 2b. Create Cognito User Pool

```bash
POOL_ID=$(aws cognito-idp create-user-pool \
  --pool-name "$USER_POOL_NAME" \
  --auto-verified-attributes email \
  --policies 'PasswordPolicy={MinimumLength=8,RequireUppercase=false,RequireLowercase=false,RequireNumbers=false,RequireSymbols=false}' \
  --query 'UserPool.Id' --output text)

CLIENT_ID=$(aws cognito-idp create-user-pool-client \
  --user-pool-id "$POOL_ID" \
  --client-name shopshare-web \
  --no-generate-secret \
  --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --query 'UserPoolClient.ClientId' --output text)

echo "USER POOL ID: $POOL_ID"
echo "CLIENT ID: $CLIENT_ID"

# ⚠️ IMPORTANT: Paste these two IDs into your `app.js` file now!
```

---

## 3. Create the Lambda function

```bash
ROLE_ARN=$(aws iam get-role --role-name "$FN_ROLE_NAME" --query 'Role.Arn' --output text)

aws lambda create-function \
  --function-name "$FN_NAME" \
  --runtime python3.12 \
  --role "$ROLE_ARN" \
  --handler extract.lambda_handler \
  --architectures x86_64 \
  --timeout 30 \
  --memory-size 512 \
  --zip-file fileb://lambda.zip \
  --environment "Variables={STATE_TABLE=$STATE_TABLE,UPLOAD_BUCKET=$BUCKET,UPLOAD_PREFIX=uploads/,BEDROCK_MODEL_ID=$BEDROCK_MODEL_ID,AWS_REGION=$AWS_REGION}"
```

Notes:
-- `timeout=30s` — Bedrock responses for small parsing prompts typically return in a few seconds; PDFs are handled asynchronously via Textract.
- `memory=512` — extraction is CPU-bound during JSON parsing of a few-KB response; 512 MB is the sweet spot (more memory = more vCPU on Lambda).

To **update** the code later: `./build.sh && aws lambda update-function-code --function-name "$FN_NAME" --zip-file fileb://lambda.zip`.

---

## 4. Create a Function URL

```bash
aws lambda create-function-url-config \
  --function-name "$FN_NAME" \
  --auth-type NONE \
  --invoke-mode BUFFERED

aws lambda add-permission \
  --function-name "$FN_NAME" \
  --statement-id FunctionURLAllowPublic \
  --action lambda:InvokeFunctionUrl \
  --principal '*' \
  --function-url-auth-type NONE
```

This returns a URL like `https://abc123xyz.lambda-url.us-east-1.on.aws/`. Capture the hostname:

```bash
export FN_URL_HOST=$(aws lambda get-function-url-config --function-name "$FN_NAME" \
  --query 'FunctionUrl' --output text | sed -E 's,^https://([^/]+)/?$,\1,')
echo "$FN_URL_HOST"
```

> ⚠ `auth-type=NONE` makes the URL public. Anyone who discovers the hostname can hit it. If you want to harden this, see "Hardening" at the bottom.

---

## 5. Upload the frontend to S3

Assuming your existing site bucket is `$BUCKET` and CloudFront serves it from the bucket root (the existing `secureparking/`, `securebin/`, etc. paths confirm this layout):

```bash
cd ../frontend
aws s3 cp index.html s3://$BUCKET/shopshare/ --content-type text/html
aws s3 cp app.css   s3://$BUCKET/shopshare/ --content-type text/css
aws s3 cp app.js    s3://$BUCKET/shopshare/ --content-type application/javascript
```

If you'd rather sync the whole folder:

```bash
aws s3 sync . s3://$BUCKET/shopshare/ \
  --exclude "*.DS_Store" \
  --cache-control "public, max-age=300"
```

---

## 6. Add the API behavior to CloudFront

In the AWS console, open your distribution (`$DIST_ID`) → **Origins** → **Create origin**:

| Field                       | Value                                                          |
| --------------------------- | -------------------------------------------------------------- |
| Origin domain               | `<the value of $FN_URL_HOST>` *(do not pick from the dropdown — paste it)* |
| Protocol                    | HTTPS only                                                     |
| Origin path                 | *(empty)*                                                      |
| Name                        | `shopshare-lambda`                                           |
| Add custom header           | *(none)*                                                       |

Then **Behaviors → Create behavior**:

| Field                          | Value                                              |
| ------------------------------ | -------------------------------------------------- |
| Path pattern                   | `/shopshare/api/*`                               |
| Origin                         | `shopshare-lambda`                               |
| Viewer protocol policy         | Redirect HTTP to HTTPS                             |
| Allowed HTTP methods           | GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE       |
| Cache policy                   | **CachingDisabled** (managed)                      |
| Origin request policy          | **AllViewerExceptHostHeader** (managed)            |
| Response headers policy        | *(none)*                                           |
| Compress objects automatically | Yes                                                |

Behavior **precedence matters**: the new `/shopshare/api/*` behavior must come **before** any existing `/shopshare/*` behavior in the ordering list. CloudFront matches top-down.

If you don't already have a behavior for static `/shopshare/*`, create one too:

| Field                          | Value                                     |
| ------------------------------ | ----------------------------------------- |
| Path pattern                   | `/shopshare/*`                          |
| Origin                         | your existing S3 origin                   |
| Viewer protocol policy         | Redirect HTTP to HTTPS                    |
| Cache policy                   | **CachingOptimized** (managed)            |
| Compress objects automatically | Yes                                       |

---

## 7. Invalidate the cache

```bash
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths "/shopshare/*"
```

---

## 8. Test

1. Open `https://www.websaleem.com/shopshare/` in a browser.
2. Add a person.
3. Switch to **AI Import**, upload a JPG/PNG/PDF receipt, click **Extract Items with AI**.
5. The pending list should populate. Assign rows to people, click **Add All**, and watch the per-person split fill in.

If something doesn't work:

| Symptom                                 | Likely cause                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| 403 from `/shopshare/api/extract`     | The Lambda Function URL permission isn't attached, or CloudFront origin protocol is set to HTTP. |
| 502 with `Extraction failed: ...`       | Lambda raised — check CloudWatch Logs `/aws/lambda/shopshare-extract`.             |
| `Missing header`                         | CloudFront isn't forwarding headers the Lambda expects. Ensure the origin request policy forwards required headers (use **AllViewerExceptHostHeader** to forward all viewer headers except `Host`). |
| 413 `File too large`                    | Receipt > 5 MB. Resize on the client or raise `MAX_BYTES` in `extract.py` (still must stay below Lambda's 6 MB sync limit). |
| CSS/JS not updating                     | CloudFront cached old assets. Re-run the invalidation in step 7.                      |

---

## Cost estimate

At portfolio traffic (a few hundred views/month, a few dozen extractions):

| Service             | Free tier                           | Realistic monthly cost |
| ------------------- | ----------------------------------- | ---------------------- |
| S3                  | 5 GB / 20K GETs / 2K PUTs           | ~$0.01                 |
| CloudFront          | 1 TB transfer + 10M HTTP requests   | $0                     |
| Lambda              | 1M requests + 400K GB-s             | $0                     |
| Lambda Function URL | included with Lambda                | $0                     |
| CloudWatch Logs     | 5 GB ingestion + 5 GB storage       | $0                     |

Total: **$0–1/month**.

---

## Hardening

- **Rate limit.** If the Function URL is hammered, your Lambda invocation count climbs (and your Bedrock/Textract bill may increase). Add a CloudFront **WAF web ACL** with a rate-based rule (`/shopshare/api/*`, e.g. 60 req/5 min/IP).
- **CloudFront-only access.** Rotate Function URL `auth-type` to `AWS_IAM`, attach an **OAC** (Origin Access Control) to the CloudFront origin so only signed CloudFront requests reach Lambda. This prevents direct hits to the `*.lambda-url.*.on.aws` host.
- **Stricter CSP.** Add a `Content-Security-Policy` response header policy in CloudFront for `/shopshare/*` — at minimum, `default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' https://cdnjs.cloudflare.com 'unsafe-inline'; connect-src 'self';`.
- **Key never sees disk.** The Lambda doesn't write logs containing the API key, but if you add custom logging, be careful not to `print(event)` — the headers contain the key.

---

## Tear-down

```bash
aws cloudfront list-distributions  # find the behaviors and remove the /shopshare/api/* one
aws lambda delete-function-url-config --function-name "$FN_NAME"
aws lambda delete-function --function-name "$FN_NAME"
aws iam detach-role-policy --role-name "$FN_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name "$FN_ROLE_NAME"
aws s3 rm s3://$BUCKET/shopshare/ --recursive
```

## Automated deploy via AWS CodePipeline

An AWS CodePipeline is defined in `cloudformation/ci-cd.yaml`. It uses CodeBuild to build the Lambda package, deploy the CloudFormation stack, and update the Lambda function code. To set it up:

1. Create an AWS CodeConnection to your GitHub repo in the AWS Console (Developer Tools → Settings → Connections). CodeConnections are **free**.
2. Deploy the `cloudformation/ci-cd.yaml` stack with parameters:
   - `FullRepositoryId` (e.g. `your-username/ShopShare`)
   - `BranchName` (default: `main`)
   - `CodeConnectionArn` (the ARN from step 1)
   - `NotificationEmail` (for build success/failure alerts)
3. The pipeline triggers automatically on pushes to the configured branch and:
   - Validates Python source syntax
   - Builds `lambda.zip`
   - Deploys the CloudFormation backend stack
   - Updates the Lambda function code
   - Builds the mobile app via EAS (parallel stage)
