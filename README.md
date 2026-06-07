# ShopShare

A serverless web app for splitting shopping/restaurant expenses across multiple people. Items can be added manually or extracted from a photo/PDF of a receipt using an AWS GenAI pipeline (Textract + Bedrock). The app then prorates a subtotal, optional service tax, and discount across the people the items are assigned to.

## Features

- **Manual item entry** — name, price, owner.
- **AI invoice import** — upload a JPG/PNG/PDF receipt; the backend returns a JSON array of `{Item, Price}` rows that you can review, edit, reassign, and bulk-accept.
- **Per-person prorated split** — the final total (subtotal + tax − discount) is divided in proportion to each person's subtotal.
- **Configurable** — service-tax toggle and percentage, discount percentage, dynamic people list.
- **Privacy-conscious** — no user API keys are required. Processing happens inside AWS and uploads can be short-lived.

## Architecture

Static frontend hosted on S3 and CloudFront, with a Python AWS Lambda backend for AI extraction. State is held entirely in the browser memory:

| Key | Type | Purpose |
| --- | --- | --- |
| `items` | `list[dict]` | Confirmed items: `{Item, Price, Belongs To}` |
| `pending_items` | `list[dict]` | AI-extracted items awaiting user review |
| `people` | `list[str]` | The set of people to split costs across |

### Request flow for AI import

```
Browser upload    ─►  POST /shopshare/api/extract
                          │
                          ▼
             Lambda extract handler
                          │
                          ▼
             [images] Textract.detect_document_text (sync)
                          │
             [pdfs] upload to S3 + Textract.StartDocumentTextDetection (async)
                          │
                          ▼
             Bedrock.invoke_model(prompt with OCR text) → JSON array
                          │
                          ▼
             Browser pending state
```

### Calculation pipeline

```
total_subtotal    = Σ subtotals
total_tax         = total_subtotal * tax_pct       (if include_tax else 0)
total_discount    = (total_subtotal + total_tax) * discount_pct
total             = total_subtotal + total_tax − total_discount
per_person_share  = total × (person_subtotal / total_subtotal)
```

If an item's `Belongs To` is no longer in the current people list (e.g. the person was renamed), the item is bucketed under `"Unassigned"` instead of being silently reassigned to the first person — that way the user can see and fix it.

## Repository layout

```
ShopShare/
├── aws/                      # Production deployment on AWS (S3 + CloudFront + Lambda)
│   ├── lambda/               # AI extraction Lambda (Python)
│   │   ├── extract.py
│   │   ├── requirements.txt
│   │   └── build.sh
│   └── DEPLOY.md             # step-by-step AWS runbook
├── frontend/                 # Static SPA (located in websaleem/shopshare)
│   ├── index.html
│   ├── app.css
│   └── app.js
├── .gitignore                # excludes OS junk
├── README.md
└── GENAI_PLAN.md             # design notes for the GenAI integration (Textract + Bedrock)
```

There is one deployment shape in this repo:

**AWS** *(production)* — static frontend on S3+CloudFront under `websaleem.com/shopshare`, plus a Lambda API. Cost: ~$0–1/month at portfolio traffic. See [`aws/DEPLOY.md`](aws/DEPLOY.md).

## Setup & Running

ShopShare is a static web application communicating with an AWS Lambda backend.
To deploy it, follow the step-by-step instructions in [`aws/DEPLOY.md`](aws/DEPLOY.md).

Once deployed, open `https://www.websaleem.com/shopshare/`.

In the sidebar:
1. Add the people who should split the bill.
2. Toggle service tax and adjust the tax/discount percentages.

Then use the **Manual Entry** or **AI Import** tab to add items.

## Configuration for AI import

The backend uses AWS Textract and Bedrock. No per-user external API keys are required.

Before deploying, set these environment variables for the Lambda (see `aws/DEPLOY.md`):

- `UPLOAD_BUCKET` — S3 bucket for temporary uploads
- `UPLOAD_PREFIX` — object prefix for uploads (default `uploads/`)
- `BEDROCK_MODEL_ID` — Bedrock model ID to invoke (e.g. `amazon.nova-lite-v1:0`)

Uploaded files are kept only as long as needed; enable S3 lifecycle rules to delete older uploads automatically.

Switch to the **AI Import (Invoice/Receipt)** tab, upload a JPG/PNG/PDF receipt, and click **Extract Items with AI**. Images are processed synchronously; PDFs return a `jobId` which the frontend polls via `/extract/status` until results are available.

## Security notes
 
- **No secrets in repo.** No third-party API keys are stored in the repository.
- **Bounded uploads.** The file uploader restricts MIME types to `png`, `jpg`, `jpeg`, `pdf` and the Lambda enforces a 5MB size limit.
- **Defensive parsing.** The Bedrock output is validated server-side to be a JSON array of objects before being returned to the UI.

## Implementation details

### `extract_invoice_data` Lambda Handler

- Images: call `textract.detect_document_text` (synchronous) and collect `LINE` blocks into OCR text.
- PDFs: upload the file to S3 and call `textract.start_document_text_detection` (asynchronous). The Lambda returns a `jobId`; the frontend polls `/extract/status?jobId=...` until results are ready.
- Once OCR text is available, the handler calls Bedrock via `bedrock-runtime` (or `boto3` `bedrock-runtime` client) with a prompt that asks for a strict JSON array of `{Item, Price}` objects. The response body is decoded and parsed as JSON.
- The server validates the parsed JSON is a list of objects, filters out invalid rows, and returns the cleaned list to the browser for user review.
- Environment variables: `UPLOAD_BUCKET`, `UPLOAD_PREFIX`, `BEDROCK_MODEL_ID`, `AWS_REGION`, and `STATE_TABLE` (DynamoDB) are expected by the Lambda.

### Manual Entry tab

A simple form. Validates that the item name is non-empty and the price is greater than zero before appending to the local state.

### AI Import tab

1. The file uploader collects the receipt; the Lambda API is invoked when the user clicks **Extract Items with AI**.
2. Extracted rows land in the pending state.
3. Each row is rendered with editable Item / Price fields and a "Belongs To" selector.
4. **Add All** moves the edited rows into the confirmed state; **Discard** drops them.

## Verification

1. Ensure the Lambda execution role has the IAM permissions in `aws/iam/lambda-policy.json`.
2. Deploy the Lambda using `ShopShare/aws/lambda/build.sh` (or your normal deployment method). Set env vars: `UPLOAD_BUCKET`, `UPLOAD_PREFIX`, `BEDROCK_MODEL_ID`, `AWS_REGION`, `STATE_TABLE`.
3. Deploy the frontend to S3/CloudFront or run locally and update `MainActivity.kt` in `android-app` to point `START_URL` at your local host.
4. Sanity tests:
    - JPG/PNG receipt → synchronous items appear in the pending list (HTTP 200).
    - PDF receipt → initial call returns HTTP 202 with `jobId`; poll `/extract/status` until HTTP 200 items returned.
    - Bedrock permission errors → 500 with a helpful message (check CloudWatch logs).

### Manual test helper

Use `ShopShare/test/sample_post.sh` to POST a local receipt image to your staging extract endpoint:

```bash
./ShopShare/test/sample_post.sh https://staging.example.com/shopshare/api/extract ./receipt.jpg "<JWT if required>"
```

If your Lambda is secured via Cognito, provide a valid `Authorization: Bearer <JWT>` token as the third argument.

### Clear All Data

Resets all items and people back to defaults.

## Limitations & future work

- Single-page app, no persistence — refresh loses state. Would need a small database if persistence is wanted.
- The discount applies to subtotal + tax. If a venue applies discount before tax, the math has to be reordered.
- The AI extractor uses prompt-based JSON guidance. Bedrock models often respect strict output instructions; server-side validation remains in place to handle unexpected or malformed model output.
- No automated tests. Pure-function units are the obvious targets.
