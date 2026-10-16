import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNodeFetch } from "../src/nodefetch.ts";
import { isCertificateError } from "../src/certs.ts";
import { CERT, KEY } from "./helpers/cert.ts";

const nodeFetch = createNodeFetch();

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; raw: string[]; body: Buffer }
interface Srv { url: string; port: number; seen: Seen[]; close(): Promise<void> }

async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void): Promise<Srv> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, raw: req.rawHeaders, body: Buffer.concat(chunks) };
      seen.push(s);
      handler(req, res, s);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, port, seen,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

async function withServer(handler: Parameters<typeof serve>[0], run: (s: Srv) => Promise<void>): Promise<void> {
  const s = await serve(handler);
  try { await run(s); } finally { await s.close(); }
}

const echo = (_q: http.IncomingMessage, res: http.ServerResponse, s: Seen) => { res.end(JSON.stringify({ method: s.method, body: s.body.toString() })); };

// ---------- basics ----------

test("GET returns status, body, url and Response semantics", async () => {
  await withServer((_q, res) => { res.setHeader("x-one", "1"); res.end("hello"); }, async (s) => {
    const r = await nodeFetch(s.url + "/a?b=1");
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.equal(r.statusText, "OK");
    assert.equal(r.url, s.url + "/a?b=1");
    assert.equal(r.headers.get("x-one"), "1");
    assert.equal(await r.text(), "hello");
    assert.equal(r.bodyUsed, true);
    assert.equal(s.seen[0]!.method, "GET");
    assert.equal(s.seen[0]!.url, "/a?b=1");
  });
});

test("GET sends the default accept-encoding and no content-length", async () => {
  await withServer((_q, res) => res.end("x"), async (s) => {
    await (await nodeFetch(s.url)).text();
    const h = s.seen[0]!.headers;
    assert.equal(h["accept-encoding"], "gzip, deflate, br");
    assert.equal(h["content-length"], undefined);
    assert.equal(h.host, `127.0.0.1:${s.port}`);
  });
});

test("a caller's accept-encoding is kept as given", async () => {
  await withServer((_q, res) => res.end("x"), async (s) => {
    await (await nodeFetch(s.url, { headers: { "Accept-Encoding": "identity" } })).text();
    assert.equal(s.seen[0]!.headers["accept-encoding"], "identity");
  });
});

test("custom headers are forwarded (names arrive lower-cased)", async () => {
  await withServer((_q, res) => res.end("x"), async (s) => {
    await (await nodeFetch(s.url, { headers: { "X-Custom-Thing": "Value", Range: "bytes=0-1" } })).text();
    assert.equal(s.seen[0]!.headers["x-custom-thing"], "Value");
    assert.ok(s.seen[0]!.raw.includes("x-custom-thing"), "Headers normalises names to lower case on the wire");
    assert.equal(s.seen[0]!.headers.range, "bytes=0-1");
  });
});

test("POST with a string body sets content-length and text/plain", async () => {
  await withServer(echo, async (s) => {
    const r = await nodeFetch(s.url, { method: "POST", body: "héllo" });
    assert.deepEqual(await r.json(), { method: "POST", body: "héllo" });
    assert.equal(s.seen[0]!.headers["content-length"], String(Buffer.byteLength("héllo")));
    assert.match(String(s.seen[0]!.headers["content-type"]), /^text\/plain/);
  });
});

test("POST JSON keeps the explicit content-type", async () => {
  await withServer(echo, async (s) => {
    const payload = JSON.stringify({ a: [1, 2, 3] });
    await (await nodeFetch(s.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload })).text();
    assert.equal(s.seen[0]!.headers["content-type"], "application/json");
    assert.equal(s.seen[0]!.body.toString(), payload);
  });
});

test("binary bodies arrive byte for byte", async () => {
  await withServer((_q, res, s) => res.end(s.body), async (s) => {
    const bytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7) & 0xff);
    const r = await nodeFetch(s.url, { method: "POST", body: bytes });
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes);
    assert.equal(s.seen[0]!.headers["content-length"], "4096");
  });
});

test("URLSearchParams bodies are form encoded", async () => {
  await withServer(echo, async (s) => {
    await (await nodeFetch(s.url, { method: "POST", body: new URLSearchParams({ q: "a b", n: "1" }) })).text();
    assert.match(String(s.seen[0]!.headers["content-type"]), /application\/x-www-form-urlencoded/);
    assert.equal(s.seen[0]!.body.toString(), "q=a+b&n=1");
  });
});

test("PUT, PATCH and DELETE keep their method and body", async () => {
  await withServer(echo, async (s) => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const r = await nodeFetch(s.url, { method, body: method + "!" });
      assert.deepEqual(await r.json(), { method, body: method + "!" });
    }
  });
});

test("error statuses are not rejections; ok is false and the body is readable", async () => {
  await withServer((q, res) => { res.statusCode = q.url === "/nf" ? 404 : 503; res.statusMessage = "Custom Msg"; res.end("nope"); }, async (s) => {
    const a = await nodeFetch(s.url + "/nf");
    assert.equal(a.status, 404); assert.equal(a.ok, false);
    assert.equal(await a.text(), "nope");
    const b = await nodeFetch(s.url + "/x");
    assert.equal(b.status, 503); assert.equal(b.statusText, "Custom Msg");
  });
});

test("json() and arrayBuffer() decode the body", async () => {
  await withServer((_q, res) => { res.setHeader("content-type", "application/json"); res.end('{"k":[1,2]}'); }, async (s) => {
    assert.deepEqual(await (await nodeFetch(s.url)).json(), { k: [1, 2] });
    const buf = await (await nodeFetch(s.url)).arrayBuffer();
    assert.equal(new TextDecoder().decode(buf), '{"k":[1,2]}');
  });
});

test("HEAD returns headers and no body", async () => {
  await withServer((_q, res) => { res.setHeader("content-length", "123"); res.end(); }, async (s) => {
    const r = await nodeFetch(s.url, { method: "HEAD" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-length"), "123");
    assert.equal(r.body, null);
    assert.equal(await r.text(), "");
    assert.equal(s.seen[0]!.method, "HEAD");
  });
});

test("204 and 304 produce a null body", async () => {
  await withServer((q, res) => { res.statusCode = q.url === "/204" ? 204 : 304; res.end(); }, async (s) => {
    for (const p of ["/204", "/304"]) {
      const r = await nodeFetch(s.url + p);
      assert.equal(r.body, null);
      assert.equal(await r.text(), "");
    }
  });
});

test("an empty 200 body reads as an empty string", async () => {
  await withServer((_q, res) => res.end(), async (s) => {
    const r = await nodeFetch(s.url);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "");
  });
});

test("duplicate response headers: set-cookie stays separate, others are joined", async () => {
  await withServer((_q, res) => {
    res.setHeader("Set-Cookie", ["a=1", "b=2"]);
    res.setHeader("X-Multi", ["one", "two"]);
    res.end("x");
  }, async (s) => {
    const r = await nodeFetch(s.url);
    assert.deepEqual(r.headers.getSetCookie(), ["a=1", "b=2"]);
    assert.equal(r.headers.get("x-multi"), "one, two");
    await r.text();
  });
});

test("duplicate request headers via Headers are sent combined", async () => {
  await withServer((_q, res) => res.end("x"), async (s) => {
    const h = new Headers(); h.append("X-Dup", "a"); h.append("X-Dup", "b");
    await (await nodeFetch(s.url, { headers: h })).text();
    assert.equal(s.seen[0]!.headers["x-dup"], "a, b");
  });
});

test("input forms: URL object, Request object, Request plus init override", async () => {
  await withServer(echo, async (s) => {
    assert.equal((await (await nodeFetch(new URL(s.url + "/u"))).json() as any).method, "GET");
    const req = new Request(s.url + "/r", { method: "POST", body: "from-request", headers: { "x-from": "req" } });
    assert.deepEqual(await (await nodeFetch(req)).json(), { method: "POST", body: "from-request" });
    assert.equal(s.seen[1]!.headers["x-from"], "req");
    const over = await nodeFetch(new Request(s.url, { method: "POST", body: "old" }), { method: "PUT", body: "new" });
    assert.deepEqual(await over.json(), { method: "PUT", body: "new" });
  });
});

test("unsupported protocols and bad URLs reject", async () => {
  await assert.rejects(nodeFetch("ftp://example.com/x"), /Unsupported protocol/);
  await assert.rejects(nodeFetch("file:///etc/passwd"), /Unsupported protocol/);
  await assert.rejects(nodeFetch("not a url"));
});

// ---------- streaming and size ----------

test("the body streams: the first chunk is readable before the response ends", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await withServer((_q, res) => { res.write("first"); void gate.then(() => res.end("second")); }, async (s) => {
    const r = await nodeFetch(s.url);
    const reader = r.body!.getReader();
    const a = await reader.read();
    assert.equal(new TextDecoder().decode(a.value), "first");
    release();
    let rest = "";
    for (;;) { const n = await reader.read(); if (n.done) break; rest += new TextDecoder().decode(n.value); }
    assert.equal(rest, "second");
  });
});

test("a 20 MiB body streams in many small chunks", async () => {
  const total = 20 * 1024 * 1024, piece = Buffer.alloc(64 * 1024, 7);
  await withServer((_q, res) => {
    let sent = 0;
    res.setHeader("content-length", String(total));
    const pump = () => {
      while (sent < total) {
        sent += piece.length;
        if (!res.write(piece)) { res.once("drain", pump); return; }
      }
      res.end();
    };
    pump();
  }, async (s) => {
    const r = await nodeFetch(s.url);
    assert.equal(r.headers.get("content-length"), String(total));
    let bytes = 0, chunks = 0, maxChunk = 0;
    for await (const c of r.body as any as AsyncIterable<Uint8Array>) {
      bytes += c.length; chunks++; maxChunk = Math.max(maxChunk, c.length);
    }
    assert.equal(bytes, total);
    assert.ok(chunks >= 20, `only ${chunks} chunks`);
    assert.ok(maxChunk <= 1024 * 1024, `chunk of ${maxChunk} bytes`);
  });
});

test("backpressure: a paused reader stops the server long before 20 MiB are sent", async () => {
  const total = 20 * 1024 * 1024, piece = Buffer.alloc(64 * 1024, 1);
  let sent = 0;
  await withServer((_q, res) => {
    const pump = () => {
      while (sent < total) { sent += piece.length; if (!res.write(piece)) { res.once("drain", pump); return; } }
      res.end();
    };
    pump();
  }, async (s) => {
    const r = await nodeFetch(s.url);
    const reader = r.body!.getReader();
    await reader.read();
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(sent < 16 * 1024 * 1024, `server already sent ${sent} bytes to a paused reader`);
    await reader.cancel();
  });
});

// ---------- range ----------

test("Range requests: 206 with Content-Range, then 416 past the end", async () => {
  const data = Buffer.from("0123456789abcdefghij");
  await withServer((q, res) => {
    const m = /bytes=(\d+)-(\d+)/.exec(String(q.headers.range));
    if (!m || Number(m[1]) >= data.length) { res.statusCode = 416; res.setHeader("content-range", `bytes */${data.length}`); return res.end(); }
    const a = Number(m[1]), b = Math.min(Number(m[2]), data.length - 1);
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${a}-${b}/${data.length}`);
    res.end(data.subarray(a, b + 1));
  }, async (s) => {
    const r = await nodeFetch(s.url, { headers: { Range: "bytes=5-9" } });
    assert.equal(r.status, 206);
    assert.equal(r.ok, true);
    assert.equal(r.headers.get("content-range"), "bytes 5-9/20");
    assert.equal(await r.text(), "56789");
    const past = await nodeFetch(s.url, { headers: { Range: "bytes=50-60" } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), "bytes */20");
    await past.text();
  });
});

// ---------- redirects ----------

function redirector(status: number, to: string) {
  return (q: http.IncomingMessage, res: http.ServerResponse, s: Seen) => {
    if (q.url === "/start") { res.statusCode = status; res.setHeader("location", to); return res.end(); }
    echo(q, res, s);
  };
}

test("301/302 turn POST into GET and drop the body and its headers", async () => {
  for (const status of [301, 302]) {
    await withServer(redirector(status, "/end"), async (s) => {
      const r = await nodeFetch(s.url + "/start", { method: "POST", body: "payload", headers: { "content-type": "text/x" } });
      assert.deepEqual(await r.json(), { method: "GET", body: "" });
      assert.equal(r.url, s.url + "/end");
      const second = s.seen[1]!;
      assert.equal(second.headers["content-length"], undefined);
      assert.equal(second.headers["content-type"], undefined);
    });
  }
});

test("301/302 keep GET and HEAD methods", async () => {
  await withServer(redirector(301, "/end"), async (s) => {
    await (await nodeFetch(s.url + "/start", { method: "HEAD" })).text();
    assert.deepEqual(s.seen.map((x) => x.method), ["HEAD", "HEAD"]);
  });
});

test("303 turns every method into GET", async () => {
  await withServer(redirector(303, "/end"), async (s) => {
    const r = await nodeFetch(s.url + "/start", { method: "PUT", body: "x" });
    assert.deepEqual(await r.json(), { method: "GET", body: "" });
  });
});

test("307 and 308 keep the method and resend the body", async () => {
  for (const status of [307, 308]) {
    await withServer(redirector(status, "/end"), async (s) => {
      const r = await nodeFetch(s.url + "/start", { method: "POST", body: "again" });
      assert.deepEqual(await r.json(), { method: "POST", body: "again" });
      assert.equal(s.seen[1]!.headers["content-length"], "5");
    });
  }
});

test("relative Location values resolve against the current URL", async () => {
  await withServer((q, res, s) => {
    if (q.url === "/a/b/start") { res.statusCode = 302; res.setHeader("location", "../c?x=1"); return res.end(); }
    echo(q, res, s);
  }, async (s) => {
    const r = await nodeFetch(s.url + "/a/b/start");
    assert.equal(r.url, s.url + "/a/c?x=1");
    await r.text();
  });
});

test("a chain of redirects is followed to the end", async () => {
  await withServer((q, res, s) => {
    const n = Number(/\/hop(\d+)/.exec(q.url ?? "")?.[1] ?? -1);
    if (n >= 0 && n < 5) { res.statusCode = 302; res.setHeader("location", `/hop${n + 1}`); return res.end(); }
    echo(q, res, s);
  }, async (s) => {
    const r = await nodeFetch(s.url + "/hop0");
    assert.equal(r.url, s.url + "/hop5");
    assert.equal(s.seen.length, 6);
    await r.text();
  });
});

test("a redirect loop stops after 10 hops with a TypeError", async () => {
  await withServer((_q, res) => { res.statusCode = 302; res.setHeader("location", "/loop"); res.end(); }, async (s) => {
    await assert.rejects(nodeFetch(s.url + "/loop"), (e: Error) => e instanceof TypeError && /Too many redirects/.test(e.message));
    assert.equal(s.seen.length, 11);
  });
});

test("redirect: manual returns the 3xx response itself", async () => {
  await withServer(redirector(302, "/end"), async (s) => {
    const r = await nodeFetch(s.url + "/start", { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/end");
    assert.equal(s.seen.length, 1);
    await r.text();
  });
});

test("redirect: error rejects on a redirect", async () => {
  await withServer(redirector(302, "/end"), async (s) => {
    await assert.rejects(nodeFetch(s.url + "/start", { redirect: "error" }), /Unexpected redirect/);
  });
});

test("a 3xx without Location is returned as is", async () => {
  await withServer((_q, res) => { res.statusCode = 302; res.end("body"); }, async (s) => {
    const r = await nodeFetch(s.url);
    assert.equal(r.status, 302);
    assert.equal(await r.text(), "body");
  });
});

test("cross-origin redirects strip authorization and cookie; same-origin ones keep them", async () => {
  const target = await serve(echo);
  try {
    await withServer(redirector(302, target.url + "/end"), async (s) => {
      const h = { authorization: "Bearer t", cookie: "a=1", "x-keep": "y" };
      await (await nodeFetch(s.url + "/start", { headers: h })).text();
      assert.equal(s.seen[0]!.headers.authorization, "Bearer t");
      const hop = target.seen[0]!.headers;
      assert.equal(hop.authorization, undefined);
      assert.equal(hop.cookie, undefined);
      assert.equal(hop["x-keep"], "y");
    });
    await withServer(redirector(302, "/end"), async (s) => {
      await (await nodeFetch(s.url + "/start", { headers: { authorization: "Bearer t", cookie: "a=1" } })).text();
      assert.equal(s.seen[1]!.headers.authorization, "Bearer t");
      assert.equal(s.seen[1]!.headers.cookie, "a=1");
    });
  } finally { await target.close(); }
});

// ---------- compression ----------

const compress = (name: string, enc: (b: Buffer) => Buffer) => test(`${name} responses are decoded and their encoding headers removed`, async () => {
  const text = "compress me ".repeat(500);
  await withServer((_q, res) => { const b = enc(Buffer.from(text)); res.setHeader("content-encoding", name); res.setHeader("content-length", String(b.length)); res.end(b); }, async (s) => {
    const r = await nodeFetch(s.url);
    assert.equal(r.headers.get("content-encoding"), null);
    assert.equal(r.headers.get("content-length"), null);
    assert.equal(await r.text(), text);
  });
});
compress("gzip", zlib.gzipSync);
compress("x-gzip", zlib.gzipSync);
compress("deflate", zlib.deflateSync);
compress("br", zlib.brotliCompressSync);

test("an identity response keeps its content-length", async () => {
  await withServer((_q, res) => { res.setHeader("content-length", "3"); res.end("abc"); }, async (s) => {
    const r = await nodeFetch(s.url);
    assert.equal(r.headers.get("content-length"), "3");
    assert.equal(await r.text(), "abc");
  });
});

test("a corrupt gzip body rejects while reading", async () => {
  await withServer((_q, res) => { res.setHeader("content-encoding", "gzip"); res.end(Buffer.from("this is not gzip data at all")); }, async (s) => {
    const r = await nodeFetch(s.url);
    await assert.rejects(r.text());
  });
});

test("a large gzip body decodes completely", async () => {
  const text = "line of text\n".repeat(200_000);
  await withServer((_q, res) => { res.setHeader("content-encoding", "gzip"); res.end(zlib.gzipSync(text)); }, async (s) => {
    assert.equal((await (await nodeFetch(s.url)).text()).length, text.length);
  });
});

// ---------- aborting and failures ----------

test("an already-aborted signal rejects with AbortError and sends nothing", async () => {
  await withServer((_q, res) => res.end("x"), async (s) => {
    const ctl = new AbortController(); ctl.abort();
    await assert.rejects(nodeFetch(s.url, { signal: ctl.signal }), (e: Error) => e.name === "AbortError");
    assert.equal(s.seen.length, 0);
  });
});

test("aborting while waiting for headers rejects", async () => {
  await withServer(() => { /* never answers */ }, async (s) => {
    const ctl = new AbortController();
    const p = nodeFetch(s.url, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(p, (e: Error) => e.name === "AbortError");
  });
});

test("aborting during the body makes the reader reject", async () => {
  await withServer((_q, res) => { res.write("partial"); }, async (s) => {
    const ctl = new AbortController();
    const r = await nodeFetch(s.url, { signal: ctl.signal });
    const reader = r.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "partial");
    ctl.abort();
    await assert.rejects(reader.read(), (e: Error) => e.name === "AbortError");
  });
});

test("an abort reason that is an Error is surfaced as is", async () => {
  await withServer(() => { /* never answers */ }, async (s) => {
    const ctl = new AbortController();
    const p = nodeFetch(s.url, { signal: ctl.signal });
    const reason = new Error("custom reason");
    setTimeout(() => ctl.abort(reason), 20);
    await assert.rejects(p, (e: Error) => e === reason);
  });
});

test("AbortSignal.timeout acts as a request timeout", async () => {
  await withServer(() => { /* never answers */ }, async (s) => {
    await assert.rejects(nodeFetch(s.url, { signal: AbortSignal.timeout(80) }), (e: Error) => e.name === "TimeoutError");
  });
});

test("a refused connection rejects", async () => {
  const s = await serve(echo); const url = s.url; await s.close();
  await assert.rejects(nodeFetch(url), (e: any) => { const x: any = e; return x.code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(x.cause?.code ?? x.message)); });
});

test("a connection reset before any response rejects", async () => {
  await withServer((q) => { q.socket.destroy(); }, async (s) => {
    await assert.rejects(nodeFetch(s.url));
  });
});

test("a connection that dies mid-body rejects the reader", async () => {
  await withServer((q, res) => { res.setHeader("content-length", "1000"); res.write("some"); setTimeout(() => q.socket.destroy(), 30); }, async (s) => {
    const r = await nodeFetch(s.url);
    await assert.rejects(r.text());
  });
});

test("an unresolvable host rejects", async () => {
  await assert.rejects(nodeFetch("http://nonexistent-host.invalid/"));
});

// ---------- proxy ----------

test("an invalid proxy URL for an https target is a TypeError", async () => {
  const f = createNodeFetch(() => "http://");
  await assert.rejects(f("https://127.0.0.1:9/"), (e: Error) => e instanceof TypeError && /proxy URL is not valid/.test(e.message));
});

test("http targets never use the proxy", async () => {
  let proxied = 0;
  const proxy = net.createServer((sock) => { proxied++; sock.destroy(); });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const pport = (proxy.address() as net.AddressInfo).port;
  try {
    await withServer((_q, res) => res.end("direct"), async (s) => {
      const f = createNodeFetch(() => `http://127.0.0.1:${pport}`);
      assert.equal(await (await f(s.url)).text(), "direct");
      assert.equal(proxied, 0);
    });
  } finally { proxy.close(); }
});

test("the proxy getter is read on every call and trimmed", async () => {
  let calls = 0;
  const f = createNodeFetch(() => { calls++; return "   "; });
  await withServer((_q, res) => res.end("ok"), async (s) => {
    await (await f(s.url)).text(); await (await f(s.url)).text();
    assert.equal(calls, 2);
  });
});

interface ProxyLog { head: string[]; }

/** A CONNECT proxy on a plain or TLS socket. `answer` decides the reply line; on 200 it tunnels. */
async function connectProxy(opts: { secure?: boolean; status?: number } = {}): Promise<{ url: string; port: number; log: ProxyLog[]; close(): void }> {
  const log: ProxyLog[] = [];
  const onSocket = (client: net.Socket) => {
    let buf = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onData);
      const head = buf.subarray(0, end).toString("latin1").split("\r\n");
      log.push({ head });
      const m = /^CONNECT ([^ :]+):(\d+) HTTP/.exec(head[0] ?? "");
      const status = opts.status ?? 200;
      if (!m || status !== 200) { client.end(`HTTP/1.1 ${status} Nope\r\ncontent-length: 0\r\n\r\n`); return; }
      const upstream = net.connect(Number(m[2]), m[1]!, () => {
        client.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = buf.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    };
    client.on("data", onData);
    client.on("error", () => undefined);
  };
  const server = opts.secure ? tls.createServer({ key: KEY, cert: CERT }, onSocket) : net.createServer(onSocket);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  const sockets = new Set<net.Socket>();
  server.on(opts.secure ? "secureConnection" : "connection", (s: net.Socket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  return { url: `${opts.secure ? "https" : "http"}://127.0.0.1:${port}`, port, log, close: () => { sockets.forEach((s) => s.destroy()); server.close(); } };
}

async function tlsTarget(): Promise<{ url: string; port: number; hosts: string[]; close(): void }> {
  const hosts: string[] = [];
  const server = https.createServer({ key: KEY, cert: CERT }, (q, res) => { hosts.push(String(q.headers.host)); res.end("secure-ok"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `https://127.0.0.1:${port}/p`, port, hosts, close: () => { server.closeAllConnections(); server.close(); } };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const caFile = path.join(os.tmpdir(), `obsidian-youtube-test-ca-${process.pid}.pem`);
fs.writeFileSync(caFile, CERT);
process.on("exit", () => { try { fs.unlinkSync(caFile); } catch { /* already gone */ } });

/**
 * Runs createNodeFetch in a child process. By default the child trusts the test certificate through
 * NODE_EXTRA_CA_CERTS; with `trustByEnv` false that variable is removed, so only the "system" mode can trust it.
 */
function viaChild(proxy: string, target: string, mode = "", trustByEnv = true): Promise<any> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
  delete env.NODE_EXTRA_CA_CERTS;
  if (trustByEnv) env.NODE_EXTRA_CA_CERTS = caFile;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, "helpers", "proxychild.ts"), proxy, target, mode], { env });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", reject);
    child.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").pop() ?? "")); } catch { reject(new Error("child output: " + out)); } });
  });
}

test("https through an HTTP CONNECT proxy: handshake line, Host header, TLS inside the tunnel", async () => {
  const proxy = await connectProxy(), target = await tlsTarget();
  try {
    const r = await viaChild(proxy.url, target.url);
    assert.deepEqual({ status: r.status, body: r.body }, { status: 200, body: "secure-ok" });
    assert.equal(proxy.log.length, 1);
    assert.equal(proxy.log[0]!.head[0], `CONNECT 127.0.0.1:${target.port} HTTP/1.1`);
    assert.ok(proxy.log[0]!.head.includes(`Host: 127.0.0.1:${target.port}`));
    assert.ok(!proxy.log[0]!.head.some((l) => /^proxy-authorization/i.test(l)));
    assert.equal(target.hosts[0], `127.0.0.1:${target.port}`);
  } finally { proxy.close(); target.close(); }
});

test("proxy credentials are percent-decoded and sent as Basic auth", async () => {
  const proxy = await connectProxy(), target = await tlsTarget();
  try {
    const url = proxy.url.replace("http://", "http://us%40er:p%3Ass@");
    const r = await viaChild(url, target.url);
    assert.equal(r.body, "secure-ok");
    const auth = proxy.log[0]!.head.find((l) => /^Proxy-Authorization:/i.test(l));
    assert.equal(auth, "Proxy-Authorization: Basic " + Buffer.from("us@er:p:ss").toString("base64"));
  } finally { proxy.close(); target.close(); }
});

test("a proxy given without a scheme is treated as http://", async () => {
  const proxy = await connectProxy(), target = await tlsTarget();
  try {
    const r = await viaChild(`127.0.0.1:${proxy.port}`, target.url);
    assert.equal(r.body, "secure-ok");
    assert.equal(proxy.log.length, 1);
  } finally { proxy.close(); target.close(); }
});

test("an https:// proxy is reached over TLS before the CONNECT", async () => {
  const proxy = await connectProxy({ secure: true }), target = await tlsTarget();
  try {
    const r = await viaChild(proxy.url, target.url);
    assert.equal(r.body, "secure-ok");
    assert.equal(proxy.log[0]!.head[0], `CONNECT 127.0.0.1:${target.port} HTTP/1.1`);
  } finally { proxy.close(); target.close(); }
});

test("a proxy that refuses (407) fails with a clear message", async () => {
  const proxy = await connectProxy({ status: 407 }), target = await tlsTarget();
  try {
    const r = await viaChild(proxy.url, target.url);
    assert.match(r.error, /Proxy refused the connection \(407\)/);
    assert.deepEqual(target.hosts, []);
  } finally { proxy.close(); target.close(); }
});

test("an unreachable proxy rejects", async () => {
  const dead = await connectProxy(); const url = dead.url; dead.close();
  await new Promise((r) => setTimeout(r, 30));
  const r = await viaChild(url, "https://127.0.0.1:9/");
  assert.ok(r.error, "expected an error");
});

test("repeated requests through the same proxy reuse one agent and both succeed", async () => {
  const proxy = await connectProxy(), target = await tlsTarget();
  try {
    const r = await viaChild(proxy.url, target.url, "twice");
    assert.equal(r.body, "secure-ok");
    assert.equal(r.second, "secure-ok");
    assert.ok(proxy.log.length >= 1 && proxy.log.length <= 2);
  } finally { proxy.close(); target.close(); }
});

// ---------- the operating system's certificate store ----------

// These tests need a process that does not already trust the test certificate through the environment.
const untrustedByEnv = { skip: Boolean(process.env.NODE_EXTRA_CA_CERTS) && "NODE_EXTRA_CA_CERTS already trusts the test certificate" };

test("a certificate that Node's roots reject is retried with the system store, loaded once", untrustedByEnv, async () => {
  const target = await tlsTarget();
  let loads = 0;
  const f = createNodeFetch(() => "", { systemCertificates: async () => { loads++; return [CERT]; } });
  try {
    assert.equal(await (await f(target.url)).text(), "secure-ok");
    assert.equal(await (await f(target.url)).text(), "secure-ok");
    assert.equal(loads, 1, "the second request goes straight to the trusted set");
  } finally { target.close(); }
});

test("with no system store the certificate error surfaces and verification stays on", untrustedByEnv, async () => {
  const target = await tlsTarget();
  const f = createNodeFetch(() => "", { systemCertificates: async () => null });
  try {
    await assert.rejects(f(target.url), (e: unknown) => isCertificateError(e));
    assert.deepEqual(target.hosts, [], "the request is never answered without verification");
  } finally { target.close(); }
});

test("a POST is retried intact after a certificate error and reaches the server once", untrustedByEnv, async () => {
  const target = await tlsTarget();
  const f = createNodeFetch(() => "", { systemCertificates: async () => [CERT] });
  try {
    const r = await f(target.url, { method: "POST", body: "payload" });
    assert.equal(await r.text(), "secure-ok");
    assert.equal(target.hosts.length, 1);
  } finally { target.close(); }
});

test("through a proxy, a certificate error is retried with the system store", untrustedByEnv, async () => {
  const proxy = await connectProxy(), target = await tlsTarget();
  try {
    const r = await viaChild(proxy.url, target.url, "system,twice", false);
    assert.equal(r.body, "secure-ok");
    assert.equal(r.second, "secure-ok");
  } finally { proxy.close(); target.close(); }
});
