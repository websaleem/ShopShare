export const BASE_URL = process.env.EXPO_PUBLIC_API_URL || "https://your-api-id.execute-api.your-region.amazonaws.com";
const API_EXTRACT = `${BASE_URL}/shopshare/api/extract`;
const API_UPLOAD  = `${BASE_URL}/shopshare/api/upload-url`;
const API_STATE   = `${BASE_URL}/shopshare/api/state`;

export type ExtractResult = { shopName?: string; purchaseDate?: string; items: Array<{ Item: string; Price: number; BelongsTo: string }> };

export async function extractInvoice(dataB64: string, mimeType: string, token: string): Promise<ExtractResult> {
  const res = await fetch(API_EXTRACT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ mime_type: mimeType, data_b64: dataB64 }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Extraction failed: ${res.status} ${errText}`);
  }

  // Support async polling if needed (returns 202)
  if (res.status === 202) {
    const { jobId } = await res.json();
    return await pollExtraction(jobId, token);
  }

  return await res.json();
}

// M-1: Add timeout cap to prevent infinite polling on hung Textract jobs
const POLL_MAX_ATTEMPTS = 50;

async function pollExtraction(jobId: string, token: string): Promise<ExtractResult> {
  let attempts = 0;
  while (attempts++ < POLL_MAX_ATTEMPTS) {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(`${API_EXTRACT}/status?jobId=${jobId}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (res.status === 202) continue;
    if (!res.ok) throw new Error(`Polling failed: ${res.status}`);
    return await res.json();
  }
  throw new Error("Extraction timed out after 100 seconds. Please try again.");
}

export async function uploadToS3(fileUri: string, filename: string, mimeType: string, token: string) {
  // Get pre-signed POST URL
  const presignRes = await fetch(API_UPLOAD, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    // M-3: Lambda expects "content_type" not "mime_type"
    body: JSON.stringify({ filename, content_type: mimeType }),
  });

  if (!presignRes.ok) throw new Error("Failed to get upload URL");
  // M-4: Lambda returns presigned POST (url + fields), not presigned PUT
  const { url, fields, key } = await presignRes.json();

  // Upload via multipart POST (matching generate_presigned_post)
  const response = await fetch(fileUri);
  const blob = await response.blob();

  const formData = new FormData();
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      formData.append(k, v as string);
    }
  }
  formData.append("file", blob, filename); // file must be last field

  const postRes = await fetch(url, {
    method: "POST",
    body: formData
  });

  if (!postRes.ok) throw new Error("Failed to upload to S3");
  return { key };
}

export async function saveStateToCloud(state: any, token: string) {
  const res = await fetch(API_STATE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({ state: JSON.stringify(state) })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to sync state to cloud: ${res.status} ${text}`);
  }
}

export async function loadStateFromCloud(token: string) {
  const res = await fetch(API_STATE, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load state from cloud: ${res.status} ${text}`);
  }
  const data = await res.json();
  if (data.state && typeof data.state === 'string') {
    try {
      return JSON.parse(data.state);
    } catch (e) {
      console.warn("Failed to parse cloud state string", e);
    }
  }
  return data.state || null;
}

