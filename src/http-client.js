export async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Expected JSON from ${new URL(url).host}, received HTTP ${response.status}`);
    }
    if (!response.ok) {
      const detail = body?.message || body?.error || response.statusText;
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}
