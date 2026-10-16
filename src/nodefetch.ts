// A fetch() over node:http(s). In Obsidian's renderer the browser fetch is bound by CORS, which
// YouTube's endpoints do not allow; Node's stack has no such rule and can use an HTTPS proxy.

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import { Readable, type Duplex } from "node:stream";
import { isCertificateError, systemCertificates } from "./certs.ts";

export type NodeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NodeFetchOptions {
  /** Supplies the operating system's certificates; tests replace it. */
  systemCertificates?: () => Promise<string[] | null>;
}

/**
 * Certificate trust for one fetch. `ca` stays unset (Node's defaults) until a certificate error shows
 * that the request needs the system store; from then on every request uses `ca`.
 */
interface Trust {
  ca: string[] | undefined;
  load: () => Promise<string[] | null>;
}

const MAX_REDIRECTS = 10;

interface ConnectOptions {
  host?: string | null;
  hostname?: string | null;
  port?: number | string | null;
  servername?: string;
  ca?: string[];
}

class ProxyAgent extends https.Agent {
  private readonly proxy: URL;
  constructor(proxy: URL) {
    super({ keepAlive: true });
    this.proxy = proxy;
  }
  // Tunnel through the proxy with CONNECT, then do TLS to the target over that socket.
  override createConnection(options: ConnectOptions, callback?: (err: Error | null, stream: Duplex) => void): Duplex | undefined {
    const proxy = this.proxy;
    const port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    const host = String(options.host ?? options.hostname ?? "");
    const targetPort = options.port ?? 443;
    // An https:// proxy is itself verified against the same trusted set.
    const socket: net.Socket = proxy.protocol === "https:"
      ? tls.connect({ host: proxy.hostname.replace(/^\[|\]$/g, ""), port, ca: options.ca })
      : net.connect({ host: proxy.hostname.replace(/^\[|\]$/g, ""), port });
    const fail = (error: Error) => { socket.destroy(); (callback as ((err: Error) => void) | undefined)?.(error); };
    socket.once("error", fail);
    const readyEvent = proxy.protocol === "https:" ? "secureConnect" : "connect";
    socket.once(readyEvent, () => {
      const headers = [`CONNECT ${host}:${targetPort} HTTP/1.1`, `Host: ${host}:${targetPort}`];
      if (proxy.username) {
        const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
        headers.push("Proxy-Authorization: Basic " + Buffer.from(credentials).toString("base64"));
      }
      socket.write(headers.join("\r\n") + "\r\n\r\n");
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffer.length > 16384) { socket.off("data", onData); fail(new Error("Proxy sent an oversized response.")); }
          return;
        }
        socket.off("data", onData);
        socket.off("error", fail);
        const status = /^HTTP\/1\.\d (\d{3})/.exec(buffer.subarray(0, end).toString("latin1"));
        if (!status || status[1] !== "200") { fail(new Error(`Proxy refused the connection (${status?.[1] ?? "no status"}).`)); return; }
        const secure = tls.connect({ socket, servername: options.servername ?? host, ca: options.ca });
        callback?.(null, secure);
      };
      socket.on("data", onData);
    });
    return undefined;
  }
}

const agents = new Map<string, ProxyAgent>();

function proxyFor(proxy: string, target: URL): ProxyAgent | null {
  if (!proxy || target.protocol !== "https:") return null;
  let agent = agents.get(proxy);
  if (!agent) {
    let url: URL;
    try { url = new URL(proxy.includes("://") ? proxy : "http://" + proxy); } catch { throw new TypeError("The proxy URL is not valid: " + proxy); }
    agent = new ProxyAgent(url);
    agents.set(proxy, agent);
  }
  return agent;
}

/**
 * A ReadableStream built from the global constructor. In Obsidian's renderer `Readable.toWeb` yields
 * Node's own stream class, which Chromium's `Response` does not recognise (it would stringify it),
 * so the body is bridged by hand, with backpressure.
 */
export function toWebStream(stream: Readable): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer | string) => {
        if (done) return;
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        controller.enqueue(bytes);
        if (controller.desiredSize !== null && controller.desiredSize <= 0) stream.pause();
      });
      stream.on("end", () => { if (!done) { done = true; controller.close(); } });
      stream.on("error", (error) => { if (!done) { done = true; controller.error(error); } });
    },
    pull() { stream.resume(); },
    cancel(reason) { done = true; stream.destroy(reason instanceof Error ? reason : undefined); },
  });
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Build a fetch that reads the proxy URL from `getProxy` on every call (settings can change).
 *
 * Certificates: the first attempt uses Node's defaults. When a certificate error shows that the
 * chain is signed by a root only the operating system trusts (an inspecting firewall), the request
 * is repeated once with the system store added, and that set is used from then on. Verification
 * stays on in both cases.
 */
export function createNodeFetch(getProxy: () => string = () => "", options: NodeFetchOptions = {}): NodeFetch {
  const trust: Trust = { ca: undefined, load: options.systemCertificates ?? systemCertificates };
  return async function nodeFetch(input, init) {
    const request = new Request(input, init);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    // Use the caller's own signal: `request.signal` follows it through a WeakRef to the Request's
    // controller, so once `request` is garbage collected an abort would silently never arrive.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null) ?? request.signal;
    return send(request.url, request.method, new Headers(request.headers), body, signal, getProxy().trim(), request.redirect, 0, trust);
  };
}

function send(urlText: string, method: string, headers: Headers, body: Buffer | undefined, signal: AbortSignal,
  proxy: string, redirect: RequestRedirect, depth: number, trust: Trust): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const url = new URL(urlText);
    if (url.protocol !== "https:" && url.protocol !== "http:") return reject(new TypeError("Unsupported protocol: " + url.protocol));
    const out: Record<string, string> = {};
    headers.forEach((value, key) => { out[key] = value; });
    if (!headers.has("accept-encoding")) out["accept-encoding"] = "gzip, deflate, br";
    if (body && !headers.has("content-length")) out["content-length"] = String(body.length);

    const transport = url.protocol === "https:" ? https : http;
    let agent: ProxyAgent | null = null;
    try { agent = proxyFor(proxy, url); } catch (error) { return reject(error instanceof Error ? error : new Error(String(error))); }
    const requestOptions: https.RequestOptions = {
      method,
      headers: out,
      ...(agent ? { agent } : {}),
      ...(url.protocol === "https:" && trust.ca ? { ca: trust.ca } : {}),
    };
    const req = transport.request(url, requestOptions, (res) => {
      signal.removeEventListener("abort", onAbort);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (location && [301, 302, 303, 307, 308].includes(status) && redirect !== "manual") {
        res.resume();
        if (redirect === "error") return reject(new TypeError("Unexpected redirect."));
        if (depth >= MAX_REDIRECTS) return reject(new TypeError("Too many redirects."));
        const next = new URL(location, url).toString();
        const toGet = status === 303 || ((status === 301 || status === 302) && method === "POST");
        const nextHeaders = new Headers(headers);
        if (new URL(next).origin !== url.origin) { nextHeaders.delete("authorization"); nextHeaders.delete("cookie"); }
        if (toGet) { nextHeaders.delete("content-length"); nextHeaders.delete("content-type"); }
        void send(next, toGet ? "GET" : method, nextHeaders, toGet ? undefined : body, signal, proxy, redirect, depth + 1, trust).then(resolve, reject);
        return;
      }
      let stream: Readable = res;
      const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
      const decoded = encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip()
        : encoding === "br" ? zlib.createBrotliDecompress()
        : encoding === "deflate" ? zlib.createInflate() : null;
      if (decoded) stream = res.pipe(decoded);
      res.on("error", (e) => stream.destroy(e));
      signal.addEventListener("abort", () => stream.destroy(abortError(signal)), { once: true });

      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        if (decoded && (key === "content-encoding" || key === "content-length")) continue;
        for (const v of Array.isArray(value) ? value : [value]) responseHeaders.append(key, v);
      }
      const empty = method === "HEAD" || status === 204 || status === 205 || status === 304;
      const response = new Response(empty ? null : toWebStream(stream), {
        status: status >= 200 && status <= 599 ? status : 502,
        statusText: res.statusMessage ?? "",
        headers: responseHeaders,
      });
      Object.defineProperty(response, "url", { value: url.toString() });
      if (empty) stream.resume();
      resolve(response);
    });
    const onAbort = () => { req.destroy(abortError(signal)); reject(abortError(signal)); };
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) return reject(abortError(signal));
      if (trust.ca === undefined && isCertificateError(error)) {
        // The handshake failed before any request was sent, so repeating this hop is safe (even for POST).
        void trust.load().then((ca) => {
          if (!ca) return reject(error);
          trust.ca = ca;
          return send(urlText, method, headers, body, signal, proxy, redirect, depth, trust).then(resolve, reject);
        }, () => reject(error));
        return;
      }
      reject(error);
    });
    if (body) req.write(body);
    req.end();
  });
}
