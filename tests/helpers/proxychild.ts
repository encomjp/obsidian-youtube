// Child process for the HTTPS-through-proxy tests: NODE_EXTRA_CA_CERTS trusts the test certificate,
// unless the mode is "system", which instead supplies the test certificate as the system store.
// Usage: node proxychild.ts <proxyUrl> <targetUrl> [mode, e.g. "twice" or "system,twice"].
// Prints JSON {status, body, url, second} or {error}.
import { createNodeFetch } from "../../src/nodefetch.ts";
import { CERT } from "./cert.ts";

const [proxy, target, mode = ""] = process.argv.slice(2) as [string, string, string | undefined];
try {
  const f = createNodeFetch(() => proxy, mode.includes("system") ? { systemCertificates: async () => [CERT] } : {});
  const r = await f(target);
  const body = await r.text();
  // A second request exercises the keep-alive agent cache.
  const r2 = mode.includes("twice") ? await (await f(target)).text() : null;
  console.log(JSON.stringify({ status: r.status, body, url: r.url, second: r2 }));
} catch (e) {
  console.log(JSON.stringify({ error: (e as Error).message }));
}
process.exit(0);
