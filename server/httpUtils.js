/**
 * @fileoverview Shared helpers for the raw-`http` JSON endpoints (auth, gallery,
 * user, admin, messenger). Each module keeps its own CORS method list and body-size
 * limit; this centralizes the otherwise-duplicated response writing and body reading.
 */

/**
 * Builds a CORS header set for a JSON endpoint.
 * @param {string} [methods='GET, POST, OPTIONS'] - Allowed methods header value.
 * @returns {Record<string, string>}
 */
export function corsHeaders(methods = 'GET, POST, OPTIONS') {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

/**
 * Writes a JSON response with the given status and (optional) extra headers.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {*} body - JSON-serializable payload.
 * @param {Record<string, string>} [extraHeaders={}] - e.g. CORS headers.
 */
export function writeJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

/**
 * Reads a request body as a string, rejecting if it exceeds maxBytes.
 * @param {import('http').IncomingMessage} req
 * @param {number} maxBytes - Hard cap; exceeding it rejects with "Payload too large".
 * @returns {Promise<string>}
 */
export function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        return;
      }
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
