// Child process for the HTTPS-through-proxy tests: NODE_EXTRA_CA_CERTS trusts the test certificate.
// Usage: node proxychild.ts <proxyUrl> <targetUrl>. Prints JSON {status, body, url} or {error}.
import { createNodeFetch } from "../../src/nodefetch.ts";

const [proxy, target, mode] = process.argv.slice(2) as [string, string, string | undefined];
try {
  const f = createNodeFetch(() => proxy);
  const r = await f(target);
  const body = await r.text();
  // A second request exercises the keep-alive agent cache.
  const r2 = mode === "twice" ? await (await f(target)).text() : null;
  console.log(JSON.stringify({ status: r.status, body, url: r.url, second: r2 }));
} catch (e) {
  console.log(JSON.stringify({ error: (e as Error).message }));
}
process.exit(0);
