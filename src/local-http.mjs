// Browser requests must never consume the native CLI's routing credentials.
export function allowLocalRequest(req, res) {
  const expected = `127.0.0.1:${req.socket.localPort}`;
  if (req.headers.host !== expected || req.headers.origin !== undefined ||
      req.headers["sec-fetch-site"] !== undefined) {
    res.writeHead(403, { "content-type": "application/json", connection: "close" });
    res.end('{"error":{"message":"Native local clients only"}}');
    req.resume();
    return false;
  }
  return true;
}

export const MAX_BODY_BYTES = 32 * 1024 * 1024;

// Bound the bytes actually received, including chunked requests, before routing.
export function readLocalBody(req, res) {
  return new Promise(resolve => {
    const chunks = [];
    let bytes = 0;
    let done = false;
    const reject = status => {
      if (done) return;
      done = true;
      chunks.length = 0;
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(status, { "content-type": "application/json", connection: "close" });
        res.end('{"error":{"message":"Invalid or oversized request"}}');
      }
      resolve(null);
    };
    req.on("error", () => reject(400));
    req.on("aborted", () => reject(400));
    req.on("data", chunk => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) reject(413);
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks, bytes));
    });
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) reject(413);
  });
}
