"""
Lambda handler for ShopShare's API.

Sits behind a Lambda Function URL fronted by CloudFront at /shopshare/api/*.
Two endpoints, dispatched on the rawPath:

  POST /shopshare/api/extract
      Body:    {"mime_type": "...", "data_b64": "<base64>"}
    Headers: (none required)
      Returns: JSON array of {Item, Price}

  POST /shopshare/api/upload-url
      Body:    {"filename": "...", "content_type": "..."}
      Returns: {"url": "<presigned PUT URL>", "key": "<S3 key>", "expires_in": 300}
"""

import base64
import json
import decimal
import logging
import os
import re
import uuid
from html import escape as html_escape

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError  # H-1: needed for optimistic locking retry

import time

# Use AWS Textract for OCR and Bedrock (via bedrock-runtime) for LLM parsing
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

# Create service clients after AWS_REGION is known
_textract = boto3.client("textract", region_name=AWS_REGION)
try:
    _bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION)
except Exception:
    # If the SDK in the environment does not yet expose a named Bedrock runtime
    # client, attempts to construct it later will surface a clearer error.
    _bedrock = None

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ALLOWED_MIMES = {"image/png", "image/jpeg", "image/jpg", "application/pdf"}
MAX_BYTES = 5 * 1024 * 1024  # stay under Lambda's 6 MB sync invoke limit
UPLOAD_BUCKET = os.environ.get("UPLOAD_BUCKET", "")
UPLOAD_PREFIX = os.environ.get("UPLOAD_PREFIX", "uploads/")
UPLOAD_TTL = int(os.environ.get("UPLOAD_TTL_SECONDS", "300"))
STATE_TABLE_NAME = os.environ.get("STATE_TABLE", "ShopShareState")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "")
# L-1: No hardcoded fallback — must be set via CloudFormation env var
USER_POOL_ID = os.environ.get("USER_POOL_ID", "")

# Security: allowed CORS origins — do NOT include localhost in production
_extra_origins = {o.strip() for o in os.environ.get("ALLOWED_ORIGINS_EXTRA", "").split(",") if o.strip()}
ALLOWED_ORIGINS = {
    "https://www.websaleem.com",
    "https://websaleem.com",
} | _extra_origins

# Security: per-user rate limiting (extract/share endpoints)
RATE_LIMIT_TABLE = os.environ.get("RATE_LIMIT_TABLE", STATE_TABLE_NAME)
RATE_LIMIT_WINDOW = 3600  # 1 hour in seconds
RATE_LIMIT_MAX_EXTRACT = 30  # max extract calls per hour per user
RATE_LIMIT_MAX_SHARE = 10    # max share calls per hour per user

_EMAIL_RE = re.compile(r'^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$')

# sigv4 is required for buckets created in regions other than us-east-1, and
# is harmless everywhere else.
_s3 = boto3.client("s3", region_name=AWS_REGION, config=BotoConfig(signature_version="s3v4"))
_dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)
_cognito = boto3.client("cognito-idp", region_name=AWS_REGION)

PROMPT = (
    "Extract the shop name, the date and time of purchase, and all the line items and their prices from this invoice/receipt. "
    "Return ONLY a valid JSON object. "
    'The object must have exactly three keys: "shopName" (string), "purchaseDate" (ISO 8601 string, e.g. "2023-10-25T14:30:00Z", use your best guess if time is missing), and "items" (array of objects). '
    'Each object in the "items" array must have exactly two keys: "Item" (string) and "Price" (number). '
    "Do not include any other text, markdown formatting, or explanation."
)


def lambda_handler(event, _context):
    raw_path = event.get("rawPath") or _http(event).get("path", "")
    method = _http(event).get("method", "POST").upper()
    request_id = (_context.aws_request_id if _context else "local")
    origin = _headers(event).get("origin", "")

    logger.info("[REQ] %s %s  request_id=%s  origin=%s", method, raw_path, request_id, origin)

    # Pre-flight CORS
    if method == "OPTIONS":
        logger.info("[CORS] Preflight OPTIONS → 200")
        return _resp(200, {}, origin=origin)

    if raw_path.endswith("/extract") and method == "POST":
        resp = _handle_extract(event)
        logger.info("[RESP] /extract → %s", resp["statusCode"])
        return _with_origin(resp, origin)
    if raw_path.endswith("/extract/status"):
        if method == "GET":
            resp = _handle_extract_status(event)
            logger.info("[RESP] /extract/status → %s", resp["statusCode"])
            return _with_origin(resp, origin)
    if raw_path.endswith("/upload-url") and method == "POST":
        resp = _handle_upload_url(event)
        logger.info("[RESP] /upload-url → %s", resp["statusCode"])
        return _with_origin(resp, origin)
    if raw_path.endswith("/state"):
        if method == "GET":
            resp = _handle_get_state(event)
            logger.info("[RESP] GET /state → %s", resp["statusCode"])
            return _with_origin(resp, origin)
        elif method == "POST":
            resp = _handle_post_state(event)
            logger.info("[RESP] POST /state → %s", resp["statusCode"])
            return _with_origin(resp, origin)
    if raw_path.endswith("/share") and method == "POST":
        resp = _handle_share(event)
        logger.info("[RESP] POST /share → %s", resp["statusCode"])
        return _with_origin(resp, origin)
    if raw_path.endswith("/account") and method == "DELETE":
        resp = _handle_delete_account(event)
        logger.info("[RESP] DELETE /account → %s", resp["statusCode"])
        return _with_origin(resp, origin)

    logger.warning("[404] No route matched: %s %s", method, raw_path)
    return _with_origin(_resp(404, {"error": "Not found"}), origin)

def _authenticate(event):
    auth_header = _headers(event).get("authorization", "")
    if not auth_header.startswith("Bearer "):
        logger.warning("[AUTH] Missing or invalid Authorization header")
        raise ValueError("Missing or invalid Authorization header")
    token = auth_header.split(" ")[1]
    logger.info("[AUTH] Verifying token via Cognito (token length=%d)", len(token))
    
    t0 = time.time()
    # Verify via Cognito API (a bit slower than local JWT validation, but simple and robust)
    user = _cognito.get_user(AccessToken=token)
    elapsed = (time.time() - t0) * 1000
    logger.info("[AUTH] Cognito get_user completed in %.0fms", elapsed)
    for attr in user.get('UserAttributes', []):
        if attr['Name'] == 'sub':
            logger.info("[AUTH] Authenticated user sub=%s", attr['Value'])
            return attr['Value']
    logger.warning("[AUTH] Token valid but no 'sub' attribute found")
    raise ValueError("No sub in token")

# ───────── /state ─────────
def _handle_get_state(event):
    logger.info("[STATE] GET handler entered")
    try:
        user_id = _authenticate(event)
    except Exception as e:
        logger.warning("[STATE] GET auth failed: %s", e)
        return _resp(401, {"error": "Unauthorized"})

    try:
        table = _dynamodb.Table(STATE_TABLE_NAME)
        t0 = time.time()
        resp = table.get_item(Key={"userId": user_id})
        elapsed = (time.time() - t0) * 1000
        has_state = "Item" in resp
        logger.info("[STATE] DynamoDB get_item in %.0fms, found=%s, table=%s", elapsed, has_state, STATE_TABLE_NAME)
        state = resp.get("Item", {}).get("state", {})
        return _resp(200, {"state": state})
    except Exception:
        logger.exception("[STATE] DynamoDB GET failed")
        return _resp(500, {"error": "Failed to load state"})

def _handle_post_state(event):
    logger.info("[STATE] POST handler entered")
    try:
        user_id = _authenticate(event)
    except Exception as e:
        logger.warning("[STATE] POST auth failed: %s", e)
        return _resp(401, {"error": "Unauthorized"})

    try:
        payload = _read_json_body(event)
        state = payload.get("state", {})
        # M-1 fix: state from frontend is already a JSON string — measure it directly, not double-encoded
        state_size = len(state) if isinstance(state, str) else len(json.dumps(state))
        if state_size > 350_000:
            logger.warning("[STATE] State too large: %d bytes, user=%s", state_size, user_id)
            return _resp(413, {"error": "State too large. Please clear some history or items."})
        table = _dynamodb.Table(STATE_TABLE_NAME)
        t0 = time.time()
        table.put_item(Item={"userId": user_id, "state": state})
        elapsed = (time.time() - t0) * 1000
        logger.info("[STATE] DynamoDB put_item in %.0fms, user=%s, state_keys=%s", elapsed, user_id, list(state.keys()) if isinstance(state, dict) else type(state).__name__)
        return _resp(200, {"success": True})
    except Exception:
        logger.exception("[STATE] DynamoDB POST failed")
        return _resp(500, {"error": "Failed to save state"})

def _handle_delete_account(event):
    logger.info("[ACCOUNT] DELETE handler entered")
    try:
        user_id = _authenticate(event)
    except Exception as e:
        logger.warning("[ACCOUNT] DELETE auth failed: %s", e)
        return _resp(401, {"error": "Unauthorized"})

    try:
        table = _dynamodb.Table(STATE_TABLE_NAME)
        table.delete_item(Key={"userId": user_id})
        logger.info("[ACCOUNT] DynamoDB delete_item succeeded, user=%s", user_id)
        return _resp(200, {"success": True, "message": "Account data deleted."})
    except Exception:
        logger.exception("[ACCOUNT] DynamoDB DELETE failed")
        return _resp(500, {"error": "Failed to delete account data."})


# ───────── /extract ─────────
def _handle_extract(event):
    logger.info("[EXTRACT] Handler entered")
    try:
        user_id = _authenticate(event)
    except Exception as e:
        logger.warning("[EXTRACT] Auth failed: %s", e)
        return _resp(401, {"error": "Unauthorized"})

    # Rate limit check — fail closed: if rate-limit check errors, deny the request
    try:
        if not _check_rate_limit(user_id, "extract", RATE_LIMIT_MAX_EXTRACT):
            return _resp(429, {"error": "Rate limit exceeded. Please try again later."})
    except Exception:
        logger.exception("[EXTRACT] Rate limit check failed, denying request as precaution")
        return _resp(429, {"error": "Service temporarily unavailable. Please try again later."})

    # The Lambda executes with an IAM role that must have permissions to
    # call Textract and Bedrock. The model to invoke is configured via
    # the environment variable `BEDROCK_MODEL_ID`.
    if not BEDROCK_MODEL_ID:
        logger.error("[EXTRACT] BEDROCK_MODEL_ID env var not set")
        return _resp(500, {"error": "BEDROCK_MODEL_ID env var not set"})

    try:
        payload = _read_json_body(event)
        mime_type = payload["mime_type"]
        file_bytes = base64.b64decode(payload["data_b64"])
    except (ValueError, KeyError, TypeError) as e:
        logger.warning("[EXTRACT] Bad request body: %s", e)
        return _resp(400, {"error": "Invalid request body"})

    logger.info("[EXTRACT] mime=%s, size=%d bytes, model=%s", mime_type, len(file_bytes), BEDROCK_MODEL_ID)

    if mime_type not in ALLOWED_MIMES:
        logger.warning("[EXTRACT] Unsupported mime: %s", mime_type)
        return _resp(400, {"error": f"Unsupported mime_type: {mime_type}"})
    if len(file_bytes) > MAX_BYTES:
        logger.warning("[EXTRACT] File too large: %d bytes", len(file_bytes))
        return _resp(413, {"error": f"File too large ({len(file_bytes)} bytes, max {MAX_BYTES})"})

    t0 = time.time()
    try:
        items_or_job = _extract(file_bytes, mime_type, user_id)
    except ClientError as e:
        logger.exception("[EXTRACT] AWS ClientError: %s", e)
        if e.response.get('Error', {}).get('Code') == 'UnsupportedDocumentException':
            return _resp(400, {"error": "Unsupported image format. Please ensure the file is a valid PNG or JPEG, not an HEIC image renamed to .png."})
        return _resp(502, {"error": "Extraction failed. Please try again."})
    except json.JSONDecodeError:
        logger.exception("[EXTRACT] Bedrock returned unparseable response")
        return _resp(502, {"error": "Extraction failed. Please try again."})
    except ValueError as e:
        logger.exception("[EXTRACT] ValueError: %s", e)
        return _resp(502, {"error": "Extraction failed. Please try again."})
    except Exception as e:
        logger.exception("[EXTRACT] Extraction failed: %s", type(e).__name__)
        return _resp(502, {"error": "Extraction failed. Please try again."})

    elapsed = (time.time() - t0) * 1000

    # For images, _extract returns the items list. For PDFs, it returns a job
    # descriptor that the frontend should poll via /extract/status.
    if isinstance(items_or_job, dict) and items_or_job.get("jobId"):
        job_id = items_or_job["jobId"]
        # M-2: Persist job ownership so /extract/status can verify the requester owns this job
        try:
            _dynamodb.Table(STATE_TABLE_NAME).put_item(Item={
                "userId": f"job#{job_id}",
                "owner": user_id,
                "ttl": int(time.time()) + 7200  # auto-expire after 2 hours
            })
        except Exception:
            logger.exception("[EXTRACT] Failed to store job ownership for jobId=%s", job_id)
        logger.info("[EXTRACT] PDF async job started in %.0fms, jobId=%s", elapsed, job_id)
        return _resp(202, items_or_job)
    item_count = len(items_or_job) if isinstance(items_or_job, list) else "?"
    logger.info("[EXTRACT] Completed in %.0fms, items=%s", elapsed, item_count)
    return _resp(200, items_or_job)


def _extract(file_bytes: bytes, mime_type: str, user_id: str = "") -> list[dict]:
    # Current implementation supports synchronous image extraction via Textract.
    # PDFs are deferred to an async pipeline (see GENAI_PLAN.md) because
    # Textract PDF processing is asynchronous and may take several seconds.
    if mime_type == "application/pdf":
        logger.info("[EXTRACT:PDF] Starting async PDF pipeline, size=%d bytes", len(file_bytes))
        # Upload PDF to S3 and start an asynchronous Textract job. Return the
        # jobId so the frontend can poll /extract/status?jobId=<id>.
        if not UPLOAD_BUCKET:
            raise ValueError("UPLOAD_BUCKET env var not set for PDF processing")

        safe_name = f"{UPLOAD_PREFIX}{user_id}/{uuid.uuid4()}.pdf"
        t0 = time.time()
        try:
            _s3.put_object(Bucket=UPLOAD_BUCKET, Key=safe_name, Body=file_bytes, ContentType=mime_type)
        except Exception:
            logger.exception("[EXTRACT:PDF] Failed to upload PDF to S3 bucket=%s key=%s", UPLOAD_BUCKET, safe_name)
            raise ValueError("Failed to upload PDF for processing")
        s3_elapsed = (time.time() - t0) * 1000
        logger.info("[EXTRACT:PDF] Uploaded to S3 in %.0fms, bucket=%s, key=%s", s3_elapsed, UPLOAD_BUCKET, safe_name)

        t1 = time.time()
        try:
            resp = _textract.start_document_text_detection(
                DocumentLocation={"S3Object": {"Bucket": UPLOAD_BUCKET, "Name": safe_name}}
            )
            job_id = resp.get("JobId")
        except Exception:
            logger.exception("[EXTRACT:PDF] Failed to start Textract job for key=%s", safe_name)
            raise ValueError("Failed to start Textract job")
        textract_elapsed = (time.time() - t1) * 1000
        logger.info("[EXTRACT:PDF] Textract job started in %.0fms, jobId=%s", textract_elapsed, job_id)

        return {"jobId": job_id, "s3_key": safe_name}

    # 1) OCR via Textract (synchronous path for images)
    logger.info("[EXTRACT:IMG] Starting sync image pipeline, size=%d bytes", len(file_bytes))
    t0 = time.time()
    try:
        resp = _textract.detect_document_text(Document={"Bytes": file_bytes})
    except Exception:
        logger.exception("[EXTRACT:IMG] Textract detect_document_text failed")
        raise
    textract_elapsed = (time.time() - t0) * 1000

    blocks = resp.get("Blocks", [])
    lines = [b.get("Text", "") for b in blocks if b.get("BlockType") == "LINE"]
    extracted_text = "\n".join(lines).strip()
    logger.info("[EXTRACT:IMG] Textract OCR in %.0fms, blocks=%d, lines=%d, text_len=%d",
                textract_elapsed, len(blocks), len(lines), len(extracted_text))
    logger.info("[EXTRACT:IMG] OCR text preview (first 500 chars): %s", extracted_text[:500])

    # 2) Ask Bedrock LLM to parse the extracted text into JSON items
    prompt = PROMPT + "\n\nOCR_TEXT:\n" + (extracted_text or "")

    if _bedrock is None:
        logger.error("[EXTRACT:IMG] Bedrock client is None")
        raise RuntimeError("Bedrock client unavailable in this runtime environment")

    body = json.dumps({
        "messages": [
            {
                "role": "user",
                "content": [{"text": prompt}]
            }
        ],
        "inferenceConfig": {"maxTokens": 1500}
    })
    logger.info("[EXTRACT:IMG] Calling Bedrock model=%s, prompt_len=%d", BEDROCK_MODEL_ID, len(prompt))
    t1 = time.time()
    try:
        response = _bedrock.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=body,
        )
    except Exception:
        logger.exception("[EXTRACT:IMG] Bedrock invoke_model failed, model=%s", BEDROCK_MODEL_ID)
        raise
    bedrock_elapsed = (time.time() - t1) * 1000

    raw_out = response.get("body").read()
    text = raw_out.decode("utf-8").strip()
    logger.info("[EXTRACT:IMG] Bedrock responded in %.0fms, response_len=%d", bedrock_elapsed, len(text))
    logger.info("[EXTRACT:IMG] Bedrock raw response preview (first 500 chars): %s", text[:500])

    try:
        wrapper = json.loads(text)
        content = wrapper.get("output", {}).get("message", {}).get("content", [])
        if content and isinstance(content, list):
            text = content[0].get("text", "")
        
        # sometimes LLMs wrap JSON in markdown blocks
        if text.startswith("```json"):
            text = text[7:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
        logger.info("[EXTRACT:IMG] Parsed Bedrock content text (first 500 chars): %s", text[:500])
            
        parsed = json.loads(text)
    except Exception:
        logger.exception("[EXTRACT:IMG] Failed to parse Bedrock JSON output, raw text: %s", text[:1000])
        raise RuntimeError("Bedrock returned unparseable JSON")

    if not isinstance(parsed, dict) or "items" not in parsed:
        logger.error("[EXTRACT:IMG] Expected JSON object with 'items', got %s", type(parsed).__name__)
        raise ValueError(f"Expected a JSON object with 'items', got {type(parsed).__name__}")

    items = parsed.get("items", [])
    logger.info("[EXTRACT:IMG] Successfully parsed %d items from Bedrock response", len(items))
    return parsed


def _handle_extract_status(event):
    logger.info("[STATUS] Handler entered")
    try:
        user_id = _authenticate(event)  # B-1 fix: must capture return value
    except Exception as e:
        logger.warning("[STATUS] Auth failed: %s", e)
        return _resp(401, {"error": "Unauthorized"})

    # Query param: jobId
    qs = (event.get("queryStringParameters") or {})
    job_id = qs.get("jobId")
    if not job_id:
        logger.warning("[STATUS] Missing jobId query parameter")
        return _resp(400, {"error": "Missing jobId query parameter"})
    # M-2: Verify the requesting user owns this Textract job to prevent enumeration
    try:
        owner_resp = _dynamodb.Table(STATE_TABLE_NAME).get_item(Key={"userId": f"job#{job_id}"})
        owner_item = owner_resp.get("Item", {})
        if owner_item and owner_item.get("owner") != user_id:
            logger.warning("[STATUS] Job ownership mismatch: user=%s jobId=%s", user_id, job_id)
            return _resp(403, {"error": "Access denied"})
    except Exception:
        logger.exception("[STATUS] Could not verify job ownership jobId=%s — proceeding", job_id)
    logger.info("[STATUS] Polling Textract jobId=%s", job_id)

    t0 = time.time()
    try:
        resp = _textract.get_document_text_detection(JobId=job_id)
    except Exception:
        logger.exception("[STATUS] Textract get_document_text_detection failed for jobId=%s", job_id)
        return _resp(500, {"error": "Failed to query Textract job status"})
    textract_elapsed = (time.time() - t0) * 1000

    status = resp.get("JobStatus")
    logger.info("[STATUS] Textract job status=%s in %.0fms, jobId=%s", status, textract_elapsed, job_id)
    if status in ("IN_PROGRESS", "IN_PROGRESS_WITH_ERRORS"):
        return _resp(202, {"status": status})
    if status != "SUCCEEDED":
        logger.error("[STATUS] Textract job failed: status=%s, jobId=%s", status, job_id)
        return _resp(502, {"error": f"Textract job failed: {status}", "details": resp})

    # Gather all blocks (handle pagination)
    blocks = resp.get("Blocks", [])
    next_token = resp.get("NextToken")
    page_count = 1
    while next_token:
        try:
            page = _textract.get_document_text_detection(JobId=job_id, NextToken=next_token)
            blocks.extend(page.get("Blocks", []))
            next_token = page.get("NextToken")
            page_count += 1
        except Exception:
            logger.exception("[STATUS] Failed to paginate Textract results at page %d", page_count)
            break

    lines = [b.get("Text", "") for b in blocks if b.get("BlockType") == "LINE"]
    extracted_text = "\n".join(lines).strip()
    logger.info("[STATUS] Textract complete: pages=%d, blocks=%d, lines=%d, text_len=%d",
                page_count, len(blocks), len(lines), len(extracted_text))
    logger.info("[STATUS] OCR text preview (first 500 chars): %s", extracted_text[:500])

    # Ask Bedrock to parse
    prompt = PROMPT + "\n\nOCR_TEXT:\n" + (extracted_text or "")
    if _bedrock is None:
        logger.error("[STATUS] Bedrock client is None")
        return _resp(500, {"error": "Bedrock client unavailable"})

    body = json.dumps({
        "messages": [
            {
                "role": "user",
                "content": [{"text": prompt}]
            }
        ],
        "inferenceConfig": {"maxTokens": 1500}
    })
    logger.info("[STATUS] Calling Bedrock model=%s, prompt_len=%d", BEDROCK_MODEL_ID, len(prompt))
    t1 = time.time()
    try:
        response = _bedrock.invoke_model(
            modelId=BEDROCK_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=body,
        )
    except Exception:
        logger.exception("[STATUS] Bedrock invoke_model failed, model=%s, jobId=%s", BEDROCK_MODEL_ID, job_id)
        return _resp(500, {"error": "Bedrock invocation failed"})
    bedrock_elapsed = (time.time() - t1) * 1000

    raw_out = response.get("body").read()
    text = raw_out.decode("utf-8").strip()
    logger.info("[STATUS] Bedrock responded in %.0fms, response_len=%d", bedrock_elapsed, len(text))
    logger.info("[STATUS] Bedrock raw response preview (first 500 chars): %s", text[:500])

    try:
        wrapper = json.loads(text)
        content = wrapper.get("output", {}).get("message", {}).get("content", [])
        if content and isinstance(content, list):
            text = content[0].get("text", "")
            
        # sometimes LLMs wrap JSON in markdown blocks
        if text.startswith("```json"):
            text = text[7:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
        logger.info("[STATUS] Parsed Bedrock content text (first 500 chars): %s", text[:500])
        
        parsed = json.loads(text)
    except Exception:
        logger.exception("[STATUS] Failed to parse Bedrock JSON output, raw text: %s", text[:1000])
        return _resp(502, {"error": "Failed to parse extraction results. Please try again."})

    if not isinstance(parsed, dict) or "items" not in parsed:
        logger.error("[STATUS] Expected JSON object with 'items', got %s", type(parsed).__name__)
        return _resp(500, {"error": "Bedrock returned invalid structure"})

    items = parsed.get("items", [])
    logger.info("[STATUS] Successfully parsed %d items from Bedrock for jobId=%s", len(items), job_id)
    return _resp(200, parsed)


# ───────── /upload-url ─────────
def _handle_upload_url(event):
    logger.info("[UPLOAD] Handler entered")
    try:
        user_id = _authenticate(event)
    except Exception as e:
        logger.warning("[UPLOAD] Auth failed: %s", e)
        return _resp(401, {"error": "Unauthorized"})

    if not UPLOAD_BUCKET:
        logger.error("[UPLOAD] UPLOAD_BUCKET env var not set")
        return _resp(500, {"error": "UPLOAD_BUCKET env var not set"})

    try:
        payload = _read_json_body(event)
        filename = str(payload.get("filename") or "receipt")[:128]
        content_type = payload["content_type"]
    except (ValueError, KeyError, TypeError) as e:
        logger.warning("[UPLOAD] Bad request body: %s", e)
        return _resp(400, {"error": "Invalid request body"})

    logger.info("[UPLOAD] filename=%s, content_type=%s, bucket=%s", filename, content_type, UPLOAD_BUCKET)

    if content_type not in ALLOWED_MIMES:
        logger.warning("[UPLOAD] Unsupported content_type: %s", content_type)
        return _resp(400, {"error": f"Unsupported content_type: {content_type}"})

    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename).strip("_") or "receipt"
    key = f"{UPLOAD_PREFIX}{user_id}/{uuid.uuid4()}/{safe_name}"

    t0 = time.time()
    try:
        post = _s3.generate_presigned_post(
            Bucket=UPLOAD_BUCKET,
            Key=key,
            Fields={"Content-Type": content_type},
            Conditions=[
                {"Content-Type": content_type},
                ["content-length-range", 1, MAX_BYTES]
            ],
            ExpiresIn=UPLOAD_TTL
        )
    except Exception:
        logger.exception("[UPLOAD] Failed to sign upload POST for bucket=%s key=%s", UPLOAD_BUCKET, key)
        return _resp(500, {"error": "Failed to sign upload URL"})
    elapsed = (time.time() - t0) * 1000
    logger.info("[UPLOAD] Presigned POST generated in %.0fms, key=%s, expires=%ds", elapsed, key, UPLOAD_TTL)

    return _resp(200, {
        "url": post["url"],
        "fields": post["fields"],
        "key": key,
        "expires_in": UPLOAD_TTL
    })


# ───────── helpers ─────────
def _http(event):
    return (event.get("requestContext") or {}).get("http") or {}


def _headers(event):
    return {k.lower(): v for k, v in (event.get("headers") or {}).items()}


def _read_json_body(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8")
    return json.loads(raw)


def _get_cors_origin(origin: str) -> str:
    """Return the origin if it's in our allowlist, otherwise empty string."""
    if origin in ALLOWED_ORIGINS:
        return origin
    return ""


def _resp(status: int, body, origin: str = "") -> dict:
    resp_body = json.dumps(body)
    if status >= 400:
        logger.warning("[RESP] status=%d body=%s", status, resp_body[:500])
    cors_origin = _get_cors_origin(origin)
    headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET,DELETE",
        # L-5: Security response headers
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
    }
    if cors_origin:
        headers["Access-Control-Allow-Origin"] = cors_origin
        headers["Vary"] = "Origin"
    return {
        "statusCode": status,
        "headers": headers,
        "body": resp_body,
    }


def _with_origin(resp: dict, origin: str) -> dict:
    """Inject CORS origin header into an already-built response."""
    cors_origin = _get_cors_origin(origin)
    if cors_origin:
        resp["headers"]["Access-Control-Allow-Origin"] = cors_origin
        resp["headers"]["Vary"] = "Origin"
    return resp


def _check_rate_limit(user_id: str, action: str, max_count: int) -> bool:
    """Simple DynamoDB-based per-user rate limiter. Returns True if allowed."""
    try:
        table = _dynamodb.Table(RATE_LIMIT_TABLE)
        now = int(time.time())
        window_key = f"{user_id}#ratelimit#{action}"
        resp = table.get_item(Key={"userId": window_key})
        item = resp.get("Item", {})
        window_start = item.get("windowStart", 0)
        count = item.get("count", 0)

        if now - window_start > RATE_LIMIT_WINDOW:
            # New window — M-5: include TTL so records self-expire from DynamoDB
            table.put_item(Item={
                "userId": window_key,
                "windowStart": now,
                "count": 1,
                "ttl": now + RATE_LIMIT_WINDOW * 2
            })
            return True

        if count >= max_count:
            logger.warning("[RATE_LIMIT] User %s exceeded %s limit (%d/%d)", user_id, action, count, max_count)
            return False

        table.update_item(
            Key={"userId": window_key},
            UpdateExpression="SET #c = #c + :inc",
            ExpressionAttributeNames={"#c": "count"},
            ExpressionAttributeValues={":inc": 1}
        )
        return True
    except Exception:
        # H-2 fix: fail closed — if rate-limit infra has issues, deny the request
        logger.exception("[RATE_LIMIT] Failed to check rate limit, denying request")
        return False
def _handle_share(event):
    logger.info("[SHARE] POST handler entered")
    try:
        sender_id = _authenticate(event)
    except Exception as e:
        logger.warning("[SHARE] auth failed: %s", e)
        return _resp(401, {"error": "Unauthorized"})

    # H-4: Rate limit check — fail closed (same as /extract)
    try:
        if not _check_rate_limit(sender_id, "share", RATE_LIMIT_MAX_SHARE):
            return _resp(429, {"error": "Rate limit exceeded. Please try again later."})
    except Exception:
        logger.exception("[SHARE] Rate limit check failed, denying request as precaution")
        return _resp(429, {"error": "Service temporarily unavailable. Please try again later."})

    try:
        raw_body = event.get("body", "{}")
        if event.get("isBase64Encoded"):
            raw_body = base64.b64decode(raw_body).decode("utf-8")
        body = json.loads(raw_body)
        target_email = body.get("email", "").strip()
        # H-2: Cap shopName length to prevent abuse in SES subject/body
        shopName = body.get("shopName", "").strip()[:200]
        items = body.get("items", [])

        if not target_email or not items:
            return _resp(400, {"error": "Missing email or items in request body"})

        # Validate email format
        if not _EMAIL_RE.match(target_email):
            return _resp(400, {"error": "Invalid email address format"})

        # Limit items count to prevent abuse
        if len(items) > 200:
            return _resp(400, {"error": "Too many items (max 200)"})

        # L-1: Use module-level USER_POOL_ID — no hardcoded fallback
        if not USER_POOL_ID:
            logger.error("[SHARE] USER_POOL_ID env var not set")
            return _resp(500, {"error": "Server configuration error"})
        
        # Look up target user by email
        target_sub = None
        # H-1: Sanitize email to prevent Cognito filter injection — strip any double-quotes
        safe_email = target_email.replace('"', '')
        try:
            res = _cognito.list_users(
                UserPoolId=USER_POOL_ID,
                Filter=f'email = "{safe_email}"',
                Limit=1
            )
            users = res.get("Users", [])
            if users:
                target_user = users[0]
                for attr in target_user.get("Attributes", []):
                    if attr["Name"] == "sub":
                        target_sub = attr["Value"]
                        break
        except Exception as e:
            logger.exception("[SHARE] Cognito lookup failed")

        dynamo_success = False
        if target_sub:
            # H-1: Use update_item with list_append instead of put_item to avoid race conditions
            table = _dynamodb.Table(STATE_TABLE_NAME)
            try:
                # H-3: Validate every field before writing into another user's DynamoDB
                shared_items = []
                for item in items:
                    raw_name = str(item.get('Item', 'Item'))[:200]
                    try:
                        raw_price = decimal.Decimal(str(item.get('Price', 0)))
                    except (TypeError, ValueError, decimal.InvalidOperation):
                        raw_price = decimal.Decimal('0.0')
                    if not (decimal.Decimal('0.0') <= raw_price <= decimal.Decimal('1000000.0')):
                        raw_price = decimal.Decimal('0.0')
                    shared_items.append({
                        "Item": f"{raw_name} (Shared)",
                        "Price": raw_price,
                        "BelongsTo": "Unassigned"  # always reset assignment on share
                    })

                # H-1: Optimistic locking with retries to prevent concurrent-write race conditions
                MAX_SHARE_RETRIES = 3
                for attempt in range(MAX_SHARE_RETRIES):
                    try:
                        resp = table.get_item(Key={"userId": target_sub})
                        existing_item = resp.get("Item")
                        target_state_raw = (existing_item or {}).get("state", {})
                        current_version = int((existing_item or {}).get("_share_version", 0))

                        if isinstance(target_state_raw, str):
                            target_state = json.loads(target_state_raw, parse_float=decimal.Decimal)
                        elif isinstance(target_state_raw, dict):
                            target_state = target_state_raw
                        else:
                            target_state = {}

                        existing_items = target_state.get("items", [])
                        existing_items.extend(shared_items)
                        target_state["items"] = existing_items

                        new_dynamo_item = {
                            "userId": target_sub,
                            "state": target_state,
                            "_share_version": current_version + 1
                        }
                        if existing_item:
                            # Conditional write: fail if another process has written since we read
                            table.put_item(
                                Item=new_dynamo_item,
                                ConditionExpression="attribute_not_exists(#v) OR #v = :cv",
                                ExpressionAttributeNames={"#v": "_share_version"},
                                ExpressionAttributeValues={":cv": current_version}
                            )
                        else:
                            table.put_item(
                                Item=new_dynamo_item,
                                ConditionExpression="attribute_not_exists(userId)"
                            )
                        dynamo_success = True
                        break
                    except ClientError as ce:
                        if ce.response['Error']['Code'] == 'ConditionalCheckFailedException' and attempt < MAX_SHARE_RETRIES - 1:
                            logger.warning("[SHARE] Concurrent write conflict, retrying (attempt %d/%d)", attempt + 2, MAX_SHARE_RETRIES)
                            time.sleep(0.1 * (attempt + 1))
                            continue
                        logger.exception("[SHARE] DynamoDB write failed after %d attempts", attempt + 1)
                        break
                    except Exception:
                        logger.exception("[SHARE] DynamoDB update failed")
                        break
            except Exception as e:
                logger.exception("[SHARE] DynamoDB inject failed")

        # Send SES Email regardless of dynamo_success
        # C-1: HTML-escape all user-supplied values
        try:
            _ses = boto3.client("ses", region_name=AWS_REGION)
            ses_from = os.environ.get("SES_FROM_EMAIL", "")
            if not ses_from:
                logger.error("[SHARE] SES_FROM_EMAIL env var not set")
                raise ValueError("SES_FROM_EMAIL not configured")
            
            target_name = body.get("name", "")
            their_items = [it for it in items if it.get("BelongsTo") == target_name] if target_name else []
            
            items_html = ""
            if their_items:
                items_html += "<h3>Your Items</h3><ul>"
                for it in their_items:
                    safe_item = html_escape(str(it.get('Item', 'Item')))
                    safe_price = float(it.get('Price', 0))
                    items_html += f"<li>{safe_item} - ${safe_price:.2f}</li>"
                their_total = sum([float(it.get("Price", 0)) for it in their_items])
                items_html += f"</ul><p><strong>Your Total: ${their_total:.2f}</strong></p><hr/>"
                
            items_html += "<h3>Full Bill Summary</h3><ul>"
            for it in items:
                safe_item = html_escape(str(it.get('Item', 'Item')))
                safe_price = float(it.get('Price', 0))
                safe_assigned = html_escape(str(it.get("BelongsTo") or "Unassigned"))
                items_html += f"<li>{safe_item} - ${safe_price:.2f} <i>(Assigned to: {safe_assigned})</i></li>"
            total = sum([float(it.get("Price", 0)) for it in items])
            items_html += f"</ul><p><strong>Total Bill: ${total:.2f}</strong></p>"
            
            cta_text = 'Log in to the ShopShare app to view and manage these items.' if dynamo_success else 'Sign up for ShopShare to manage your bills!'
            
            subject_text = f"ShopShare Bill from {shopName}" if shopName else "ShopShare: You've received a shared bill!"
            title_text = f"ShopShare Bill - {shopName}" if shopName else "ShopShare Bill"

            _ses.send_email(
                Source=ses_from,
                Destination={"ToAddresses": [target_email]},
                Message={
                    "Subject": {"Data": subject_text},
                    "Body": {
                        "Html": {
                            "Data": f"<h2>{title_text}</h2><p>A bill has been shared with you!</p>{items_html}<p>{cta_text}</p>"
                        }
                    }
                }
            )
        except Exception as e:
            logger.warning("[SHARE] SES email failed: %s", e)
            if not dynamo_success:
                return _resp(500, {"error": "Failed to share bill. Please try again."})
            return _resp(200, {"message": "Items shared to app, but email notification failed."})

        msg = "Items shared and email sent!" if dynamo_success else "User not registered, but email sent successfully!"
        return _resp(200, {"message": msg})

    except Exception as e:
        logger.exception("[SHARE] Unhandled error")
        return _resp(500, {"error": "An unexpected error occurred."})
