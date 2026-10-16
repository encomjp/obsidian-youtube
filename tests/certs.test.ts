// The system certificate store: detection of certificate failures and graceful loading of the store.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isCertificateError, loadSystemCertificates, type CertificateSources } from "../src/certs.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";

/** Sources backed by a map of files; a file missing from the map fails to read, as on a machine without it. */
function sources(files: Record<string, string>, overrides: Partial<CertificateSources> = {}): CertificateSources {
  return {
    rootCertificates: ["ROOT-1", "ROOT-2"],
    bundleFiles: ["/a/missing.crt", "/b/bundle.crt", "/c/other.pem"],
    readFile: async (file) => {
      if (!(file in files)) throw Object.assign(new Error("ENOENT: " + file), { code: "ENOENT" });
      return files[file]!;
    },
    ...overrides,
  };
}

test("certificate chain failures are recognised by code or by message", () => {
  for (const code of ["SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]) {
    assert.equal(isCertificateError(Object.assign(new Error("boom"), { code })), true, code);
  }
  for (const message of [
    "self signed certificate in certificate chain",
    "unable to get local issuer certificate",
    "unable to verify the first certificate",
    "Client network socket disconnected: certificate verify failed",
  ]) {
    assert.equal(isCertificateError(new Error(message)), true, message);
  }
});

test("other failures are not certificate failures", () => {
  assert.equal(isCertificateError(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" })), false);
  assert.equal(isCertificateError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })), false);
  assert.equal(isCertificateError(new Error("Proxy refused the connection (407).")), false);
  assert.equal(isCertificateError("self signed certificate"), false);
  assert.equal(isCertificateError(null), false);
});

test("the operating system store comes from getCACertificates when the runtime has it", async () => {
  const seen: string[] = [];
  const result = await loadSystemCertificates(sources({}, {
    getCACertificates: (type) => { seen.push(type); return ["SYSTEM-1"]; },
  }));
  assert.deepEqual(seen, ["system"]);
  assert.deepEqual(result, ["ROOT-1", "ROOT-2", "SYSTEM-1"]);
});

test("without getCACertificates the first readable bundle file is added to Node's roots", async () => {
  const result = await loadSystemCertificates(sources({ "/b/bundle.crt": PEM, "/c/other.pem": "OTHER" }));
  assert.deepEqual(result, ["ROOT-1", "ROOT-2", PEM]);
});

test("a bundle file without any certificate is skipped", async () => {
  const result = await loadSystemCertificates(sources({ "/b/bundle.crt": "not pem", "/c/other.pem": PEM }));
  assert.deepEqual(result, ["ROOT-1", "ROOT-2", PEM]);
});

test("when no bundle exists the loader returns null and never throws", async () => {
  assert.equal(await loadSystemCertificates(sources({})), null);
});

test("a failing getCACertificates falls back to the bundle files", async () => {
  const result = await loadSystemCertificates(sources({ "/b/bundle.crt": PEM }, {
    getCACertificates: () => { throw new Error("unsupported"); },
  }));
  assert.deepEqual(result, ["ROOT-1", "ROOT-2", PEM]);
});

test("an empty system store with no bundle file falls back to Node's defaults", async () => {
  assert.equal(await loadSystemCertificates(sources({}, { getCACertificates: () => [] })), null);
});

test("NODE_EXTRA_CA_CERTS is kept alongside the system store, and ignored when unreadable", async () => {
  const withExtra = await loadSystemCertificates(sources({ "/b/bundle.crt": PEM, "/x/extra.pem": "EXTRA" }, { extraFile: "/x/extra.pem" }));
  assert.deepEqual(withExtra, ["ROOT-1", "ROOT-2", "EXTRA", PEM]);
  const missingExtra = await loadSystemCertificates(sources({ "/b/bundle.crt": PEM }, { extraFile: "/x/gone.pem" }));
  assert.deepEqual(missingExtra, ["ROOT-1", "ROOT-2", PEM]);
});
