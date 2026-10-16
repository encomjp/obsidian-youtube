// Certificates the built-in engine trusts. Node verifies HTTPS against its own bundled list of public
// roots only, but a work firewall or antivirus that inspects HTTPS re-signs traffic with a root that
// IT installs in the operating system's store. Browsers accept that; Node does not, unless the store
// is added. The store is added to the trusted set, never used to switch verification off.

import { promises as fs } from "node:fs";
import tls from "node:tls";

/** Where Linux, macOS and Homebrew keep the system certificate bundle (PEM). */
export const BUNDLE_FILES: readonly string[] = [
  "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem", "/opt/homebrew/etc/openssl@3/cert.pem", "/usr/local/etc/openssl@3/cert.pem",
];

/** The message shown when the certificate of an inspecting network is not trusted by this computer. */
export const CERTIFICATE_HELP = "A firewall or security program on this network intercepts HTTPS (deep packet inspection), and its " +
  "certificate is not trusted by this computer's certificate store. Ask IT to install the company " +
  "root certificate in the system store, or set a proxy in the plugin settings if the network requires one.";

const CERTIFICATE_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_UNTRUSTED",
]);
const CERTIFICATE_MESSAGE = /self[- ]signed certificate|unable to get (local )?issuer certificate|unable to verify the first certificate|certificate verify failed|certificate not trusted/i;

/** True when a failed request failed because its certificate chain did not verify (not expiry, not a refused connection). */
export function isCertificateError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && CERTIFICATE_CODES.has(code)) return true;
  return typeof message === "string" && CERTIFICATE_MESSAGE.test(message);
}

/** The system certificate bundle file for yt-dlp (`SSL_CERT_FILE`), or null when none exists. */
export async function systemCertificateBundle(): Promise<string | null> {
  for (const file of BUNDLE_FILES) {
    try {
      if ((await fs.stat(file)).isFile()) return file;
    } catch {
      // try the next location
    }
  }
  return null;
}

export interface CertificateSources {
  /** `tls.getCACertificates`, present on Node 22.15+ and 23.x+; absent on older runtimes such as Electron's. */
  getCACertificates?: (type: "system") => string[];
  readFile(file: string): Promise<string>;
  rootCertificates: readonly string[];
  bundleFiles: readonly string[];
  extraFile?: string;
}

/**
 * The PEM certificates to trust in addition to Node's defaults: Node's bundled roots, any
 * NODE_EXTRA_CA_CERTS file (which an explicit list would otherwise drop), and the operating system's
 * store. Returns null when the system store cannot be read, so the caller keeps Node's default trust.
 * Never throws.
 */
export async function loadSystemCertificates(sources: CertificateSources = defaultSources()): Promise<string[] | null> {
  let system: string[] = [];
  if (sources.getCACertificates) {
    try { system = sources.getCACertificates("system"); } catch { system = []; }
  }
  if (system.length === 0) {
    for (const file of sources.bundleFiles) {
      try {
        const text = await sources.readFile(file);
        if (text.includes("-----BEGIN CERTIFICATE-----")) { system = [text]; break; }
      } catch {
        // missing or unreadable: try the next location
      }
    }
  }
  if (system.length === 0) return null;
  const extra: string[] = [];
  if (sources.extraFile) {
    try { extra.push(await sources.readFile(sources.extraFile)); } catch { /* not readable: ignore */ }
  }
  return [...sources.rootCertificates, ...extra, ...system];
}

function defaultSources(): CertificateSources {
  return {
    getCACertificates: typeof tls.getCACertificates === "function" ? (type) => tls.getCACertificates(type) : undefined,
    readFile: (file) => fs.readFile(file, "utf8"),
    rootCertificates: tls.rootCertificates,
    bundleFiles: BUNDLE_FILES,
    extraFile: process.env.NODE_EXTRA_CA_CERTS,
  };
}

let loaded: Promise<string[] | null> | null = null;

/** The default sources, read once per process. */
export function systemCertificates(): Promise<string[] | null> {
  loaded ??= loadSystemCertificates();
  return loaded;
}
