import { isJsonString } from "./json";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { RUNNER_EVAL_CALL_HEADER } from "../../src/shared/runner-protocol";

import { executableSends, type ExecutableWork } from "./executable-send";

const paths = new Set(["/v1/chat/completions", "/v1/messages", "/v1/responses"]);
const bodyLimit = 20 * 1024 * 1024;

function refuse(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { "content-type": "application/json", "x-should-retry": "false" });
  res.end(JSON.stringify({ error: { code, message: code } }));
}

// A child SDK opens one local request per intentional send. The bridge retries upstream
// with that request's token. SDKs that retry independently must retain their Idempotency-Key.
export async function openEvalProxy(apiOrigin: string, item: ExecutableWork, signal: AbortSignal) {
  const prepare = executableSends(item);
  const localToken = randomUUID();
  const stop = new AbortController();
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.authorization !== "Bearer " + localToken && req.headers["x-api-key"] !== localToken)
      return refuse(res, 401, "unauthorized");
    if (req.method !== "POST" || !req.url || !paths.has(req.url)) return refuse(res, 404, "unknown_model_endpoint");
    const provided = req.headers["idempotency-key"];
    if (provided !== undefined && (!isJsonString(provided) || !provided.trim() || provided.length > 255))
      return refuse(res, 400, "invalid_idempotency_key");
    if (!provided && Number(req.headers["x-stainless-retry-count"] ?? 0) > 0)
      return refuse(res, 409, "original_idempotency_key_required");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > bodyLimit) return refuse(res, 413, "request_body_too_large");
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks, total);
    const inputHeaders = new Headers();
    for (const field of ["idempotency-key", "anthropic-version", "anthropic-beta", RUNNER_EVAL_CALL_HEADER]) {
      const value = req.headers[field];
      if (Array.isArray(value)) return refuse(res, 400, "invalid_eval_request");
      if (value !== undefined) inputHeaders.set(field, value);
    }
    const headers = prepare(req.url, inputHeaders, body.toString("utf8"));
    if (isJsonString(headers)) return refuse(res, 400, headers);
    const gone = new AbortController();
    res.once("close", () => gone.abort());
    const lifetime = AbortSignal.any([signal, stop.signal, gone.signal]);
    const url = new URL(req.url, apiOrigin);
    for (let attempt = 1; attempt <= 3; attempt++) {
      let reply: Response;
      try {
        reply = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: lifetime });
      } catch (error) {
        if (lifetime.aborted || attempt === 3) throw error;
        await delay(attempt * 250, undefined, { signal: lifetime });
        continue;
      }
      if (attempt < 3 && reply.headers.get("x-should-retry") === "true") {
        const retryAfter = Number(reply.headers.get("retry-after"));
        await reply.body?.cancel();
        await delay(Math.max(attempt * 250, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0), undefined, {
          signal: lifetime
        });
        continue;
      }
      const responseHeaders = new Headers(reply.headers);
      for (const field of ["connection", "transfer-encoding", "content-length", "content-encoding"])
        responseHeaders.delete(field);
      if (!provided) responseHeaders.set("x-should-retry", "false");
      res.writeHead(reply.status, Object.fromEntries(responseHeaders));
      if (reply.body) {
        for await (const chunk of reply.body) {
          if (!res.write(chunk)) await once(res, "drain", { signal: lifetime });
        }
      }
      res.end();
      return;
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) refuse(res, 503, "eval_transport_unavailable");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || isJsonString(address)) throw new Error("Eval proxy did not bind its local port");
  return {
    baseUrl: "http://127.0.0.1:" + address.port,
    token: localToken,
    close() {
      stop.abort();
      server.close();
      server.closeAllConnections();
    }
  };
}
