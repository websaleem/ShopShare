# AWS GenAI (Bedrock) Implementation Plan

This document describes how ShopShare will use AWS services (Textract + Bedrock) to extract line items from a photo/PDF of a receipt, the design decisions behind the integration, and a roadmap for evolving it.

## Goal

Given an uploaded image or PDF, return a list of `{Item: str, Price: float}` rows that the user can review and assign to people. Receipt parsing will use Textract for OCR and Bedrock for structured parsing.

## AWS approach: Textract + Bedrock

We replace the external LLM call with an AWS-native pipeline:

- Textract: synchronous `detect_document_text` for images (fast, returns lines).
- Textract: asynchronous `StartDocumentTextDetection` for PDFs (multi-page). Job is polled by the frontend via `/extract/status`.
- Bedrock: a chosen model (configured by `BEDROCK_MODEL_ID`) parses OCR text to a strict JSON array of `{Item, Price}` objects.

Benefits:

1. Avoids external API keys per-user and centralises billing/monitoring.
2. Keeps data within AWS (S3 → Textract → Bedrock), simplifying compliance.
3. Allows a low-latency synchronous path for images and robust async processing for PDFs.

### Component design

The Lambda exposes these endpoints (same Function URL):

- `POST /shopshare/api/extract` — accepts `{mime_type, data_b64}`. For images returns items; for PDFs returns `{jobId, s3_key}` with HTTP 202.
- `GET /shopshare/api/extract/status?jobId=...` — polls Textract job, and when SUCCEEDED returns parsed `items`.

Internals:

- Images: `detect_document_text` → collect `LINE` blocks → build OCR text → call Bedrock `invoke_model` → parse JSON.
- PDFs: upload to S3, `StartDocumentTextDetection` → return JobId → frontend polls `/extract/status` → on SUCCEEDED run Bedrock parsing.

Failure modes are surfaced as structured JSON (401, 400, 500, 502) and the frontend keeps the result in a pending array for user confirmation.

### Step-by-step body

Example flow (Bedrock):

```python
# 1) Build prompt with OCR_TEXT (from Textract)
prompt = "Extract all the line items and their prices from this invoice/receipt. Return ONLY a valid JSON array of objects with keys 'Item' (string) and 'Price' (number).\n\nOCR_TEXT:\n" + ocr_text

# 2) Invoke Bedrock model (example SDK surface)
body = json.dumps({"input": prompt})
response = bedrock.invoke_model(modelId=BEDROCK_MODEL_ID, contentType="application/json", body=body)

# 3) Read response body and parse JSON
raw = response.get('body')
text = raw.read().decode('utf-8') if hasattr(raw, 'read') else str(raw)
parsed = json.loads(text)
if not isinstance(parsed, list):
    raise ValueError("Expected a JSON array of items")
items = [p for p in parsed if isinstance(p, dict)]
```

Three layers of defensive parsing:

1. **`(response.text or "").strip()`** — guards against `None` and trims surrounding whitespace before any prefix check, so `text.startswith("```json")` is not defeated by a leading newline.
2. **Fence stripping.** Model responses sometimes wrap JSON in ``` fences (for readability); we trim either form before parsing.
3. **Type validation.** `json.loads` could return a dict, a string, or a number. We reject anything that isn't a list and filter out non-dict entries from inside the list.

### Bedrock model

Choose a Bedrock model that fits structured parsing. Example IDs:

- `amazon.titan-embed-001` (embedding use-cases)
- `amazon.nova-lite-v1:0` or another Bedrock-hosted model suitable for instruction-following and JSON output.

Set the model via the Lambda env var `BEDROCK_MODEL_ID`. Use response prompts that request a strict JSON array and validate the result server-side.

### Why no `Part` for PIL images

The new SDK does accept PIL `Image` objects, but going through PIL means we'd carry `Pillow` as a dependency and pay a decode/encode roundtrip for no benefit — we already have raw bytes from the request and a correct MIME type. `Part.from_bytes` is strictly leaner.

## Integration with Frontend SPA

```
Frontend (app.js)
  ├── Extract Items Button
    │     └── fetch(/shopshare/api/extract, { body })
  │           └── state.pending = result
  └── per-row review UI
        ├── editable Item, Price, Belongs To inputs
        ├── "Add All"  → extends state.items
        └── "Discard"  → empties state.pending
```

The result of the Lambda API lands in a pending state array rather than going straight into the confirmed items array, so the user always confirms before anything is added to the split. PDFs will return a `jobId` immediately; the frontend should poll `/extract/status` until the job completes and then present `items` in the pending array.

## Verification

1. Ensure the Lambda execution role has the IAM permissions in `aws/iam/lambda-policy.json`.
2. Deploy the Lambda using `aws/lambda/build.sh` and deploy the frontend to CloudFront/S3.
3. Sanity tests:
    - JPG receipt → synchronous items appear in the pending list (HTTP 200).
    - PDF receipt → initial call returns HTTP 202 with `jobId`; poll `/extract/status` until HTTP 200 items returned.
    - Bedrock permission errors → 500 with a helpful message (check CloudWatch logs).
4. Edit a row's Item / Price / Belongs To, click **Add All**, confirm rows land in the main list with the edits intact.

## Future improvements

These are deliberately out of scope for the initial implementation but documented here so the next change is small.

## Next improvements

1. Use Bedrock response-mime-type / structured output features (where supported) to avoid fragile fence-stripping and gain schema validation.
2. Move `BEDROCK_MODEL_ID` to Lambda config and add a simple admin toggle to pick a model per environment (staging, prod).
3. Add rate-limiting and cost guardrails (API Gateway + usage plans or WAF rules).
4. Add a small processor Lambda (optional) that runs on Textract SNS notifications and writes parsed results to a `ShopShareResults` DynamoDB table; this offloads parsing from the polling path.
5. Instrument metrics (CloudWatch) and alerts for failed Bedrock/Textract calls and per-call cost tracking.

## IAM policy (example)

See `aws/iam/lambda-policy.json` for a minimal policy granting Textract, S3, Bedrock invocation and DynamoDB permissions required by the Lambda.

## Deployment notes

- Set `BEDROCK_MODEL_ID` and `UPLOAD_BUCKET` in the Lambda environment.
- Ensure the Lambda role includes `bedrock:InvokeModel` (or equivalent) and `textract:*` as shown in the example policy.
- Deploy via `ShopShare/aws/lambda/build.sh` and invalidate CloudFront if needed.

## Rollout checklist

1. Deploy to staging and run 10-20 sample receipts (images + PDFs).
2. Verify costs and latency, tune model selection if necessary.
3. Enable lifecycle rules on `UPLOAD_BUCKET` to delete uploads within 24–72 hours.
4. Promote to production once satisfied.
