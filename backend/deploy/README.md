Packaging & deploying ShopShare backend

Prerequisites

- AWS CLI v2 configured with credentials that can create CloudFormation stacks, IAM roles, DynamoDB, S3, and Lambda.
- The `aws` command on PATH and appropriate IAM permissions.

Quick deploy

```bash
cd backend/deploy
./package_and_deploy.sh my-shopshare-stack amazon.nova-lite-v1:0
```

Notes

- The CloudFormation template contains a placeholder ZipFile for the Lambda. After creating the stack you should update the Lambda code using `aws lambda update-function-code` with a zip file produced by the `ShopShare/aws/lambda/build.sh` script.
- Alternatively, modify the CloudFormation template to reference an S3 object for the Lambda `Code` block.
