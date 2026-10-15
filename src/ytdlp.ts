// yt-dlp executable management and the calls the plugin makes through it, ported from
// Starnote's yt-dlp integration and its offline download runner.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Engine, SearchResult, VideoFormats } from "./engine.ts";
import { parsePlayback, parseProgress, readFormats, YtDlpError, type DownloadProgress, type Playback } from "./formats.ts";
import { isVideoId, watchUrl } from "./youtube.ts";

export { YtDlpError } from "./formats.ts";
export type { DownloadProgress, Playback, StreamFormat } from "./formats.ts";
export type { SearchResult } from "./engine.ts";

const MAX_METADATA_CHARS = 16 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 60_000;

export interface YtDlpSettings {
  /** Optional path to the user's own yt-dlp; blank looks for `yt-dlp` on PATH. */
  ytDlpPath: string;
  /** Optional proxy for yt-dlp, e.g. http://proxy.company.local:8080. */
  proxy: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class YtDlp implements Engine {
  readonly id = "yt-dlp" as const;

  constructor(private readonly settings: () => YtDlpSettings) {}

  /** The configured executable, else `yt-dlp` on PATH. The plugin never downloads or updates it. */
  async executable(): Promise<string> {
    const configured = this.settings().ytDlpPath.trim();
    if (configured) {
      if (await isExecutable(configured)) return configured;
      throw new YtDlpError(`The yt-dlp path in settings is not an executable file: ${configured}`);
    }
    const onPath = await findOnPath(process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    if (onPath) return onPath;
    throw new YtDlpError("yt-dlp was not found. Install it (https://github.com/yt-dlp/yt-dlp#installation) and set its path in settings.");
  }

  async available(): Promise<boolean> {
    try {
      await this.executable();
      return true;
    } catch {
      return false;
    }
  }

  async describe(): Promise<string> {
    try {
      const exe = await this.executable();
      return `yt-dlp ${await this.version()} at ${exe}`;
    } catch (error) {
      return (error as Error).message;
    }
  }

  async version(): Promise<string> {
    const result = await this.exec(["--version"], { maxStdout: 1024, timeoutMs: 20_000 }, false);
    return result.stdout.trim();
  }

  /** Direct stream URLs for in-note playback, capped at `maxHeight` like Starnote's selector. */
  async playback(id: string, maxHeight: number): Promise<Playback> {
    const cap = maxHeight > 0 ? maxHeight : 720;
    const root = await this.info(id, `bestvideo[height<=${cap}]+bestaudio/best[height<=${cap}]/bestvideo+bestaudio/best`);
    return parsePlayback(root);
  }

  /** Every format, for the offline-save picker. */
  async formats(id: string): Promise<VideoFormats> {
    const root = await this.info(id, null);
    return {
      title: typeof root.title === "string" ? root.title : null,
      formats: readFormats(root, "formats"),
      duration: typeof root.duration === "number" ? root.duration : null,
    };
  }

  /** One page of YouTube search results; `sort: "date"` lists the newest uploads first. */
  async search(query: string, options: { page?: number; pageSize?: number; sort?: "relevance" | "date" } = {}): Promise<SearchResult[]> {
    const text = query.replace(/[\r\n]/g, " ").trim();
    if (!text) return [];
    const size = options.pageSize ?? 15, page = Math.max(options.page ?? 0, 0);
    const from = page * size + 1, to = (page + 1) * size;
    const prefix = options.sort === "date" ? "ytsearchdate" : "ytsearch";
    return this.flatList(`${prefix}${to}:${text}`, from, to, "YouTube search failed.");
  }

  /** The videos of a playlist or channel URL, a page at a time. */
  async listUrl(url: string, options: { page?: number; pageSize?: number } = {}): Promise<SearchResult[]> {
    const size = options.pageSize ?? 15, page = Math.max(options.page ?? 0, 0);
    return this.flatList(url, page * size + 1, (page + 1) * size, "yt-dlp could not list that link.");
  }

  private async flatList(target: string, from: number, to: number, failure: string): Promise<SearchResult[]> {
    const result = await this.exec([
      ...BASE_ARGS.filter((a) => a !== "--no-playlist"), "--flat-playlist", "--dump-single-json",
      "--playlist-items", `${from}-${to}`, "--", target,
    ], { maxStdout: MAX_METADATA_CHARS, timeoutMs: METADATA_TIMEOUT_MS });
    if (result.code !== 0) throw new YtDlpError(errorSummary(result, failure));
    const entries = readEntries(parseJson(result.stdout));
    // An empty page with an ERROR line is a failure that yt-dlp reported with exit code 0.
    if (entries.length === 0 && /^ERROR:/m.test(result.stderr)) throw new YtDlpError(errorSummary(result, failure));
    return entries;
  }

  /**
   * Download the comma-separated format ids into a fresh temporary folder and return the written
   * files in the same order. Separate video and audio stay separate files, as in Starnote, so no
   * ffmpeg is needed. The caller copies them into the vault and removes the folder.
   */
  async download(id: string, formatIds: string[], onProgress: (p: DownloadProgress) => void,
    signal: AbortSignal): Promise<{ files: string[]; folder: string }> {
    if (!isVideoId(id)) throw new YtDlpError("Invalid YouTube video id.");
    if (formatIds.length === 0 || formatIds.some((f) => !/^[A-Za-z0-9._-]{1,64}$/.test(f)))
      throw new YtDlpError("Invalid yt-dlp format id.");
    const folder = path.join(os.tmpdir(), "obsidian-youtube-" + randomUUID());
    await fs.mkdir(folder, { recursive: true });
    const args = [
      ...BASE_ARGS, "--newline", "--no-part", "--no-mtime", "--restrict-filenames",
      "--progress-template", "download:YTN %(progress._percent_str)s|%(progress._total_bytes_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
      "-f", formatIds.join(","), "-o", path.join(folder, "%(id)s.f%(format_id)s.%(ext)s"),
      "--", watchUrl(id),
    ];

    try {
      const result = await this.exec(args, {
        maxStdout: 1024 * 1024,
        signal,
        onLine: (line) => {
          if (line.startsWith("YTN ")) onProgress(parseProgress(line.slice(4)));
        },
      });
      if (signal.aborted) throw new YtDlpError("Download cancelled.");
      if (result.code !== 0) throw new YtDlpError(errorSummary(result, "yt-dlp could not download the video."));
      // Order the files like the requested ids (video first, then audio).
      // Find the files by name rather than trusting printed paths, whose encoding varies on Windows.
      const names = await fs.readdir(folder);
      const files = formatIds.map((formatId) => {
        const name = names.find((n) => n.startsWith(`${id}.f${formatId}.`) && !/\.(part|ytdl|temp)$/i.test(n));
        return name ? path.join(folder, name) : undefined;
      });
      if (files.some((f) => !f || path.dirname(path.resolve(f)) !== path.resolve(folder)))
        throw new YtDlpError("yt-dlp did not report every saved file.");
      return { files: files as string[], folder };
    } catch (error) {
      await removeFolder(folder);
      throw error;
    }
  }

  private async info(id: string, selector: string | null): Promise<Record<string, unknown>> {
    if (!isVideoId(id)) throw new YtDlpError("Invalid YouTube video id.");
    const args = [...BASE_ARGS, "--skip-download", "--dump-single-json"];
    if (selector) args.push("--format", selector);
    args.push("--", watchUrl(id));
    const result = await this.exec(args, { maxStdout: MAX_METADATA_CHARS, timeoutMs: METADATA_TIMEOUT_MS });
    if (result.code !== 0) throw new YtDlpError(errorSummary(result, "yt-dlp could not resolve a playable YouTube stream."));
    return parseJson(result.stdout);
  }

  /**
   * Run yt-dlp with the network options every call needs.
   *
   * Certificates: yt-dlp normally trusts only the certificate list bundled inside it. Work networks
   * that inspect HTTPS (DPI firewalls) and antivirus "web shields" re-sign traffic with their own
   * root certificate, which IT installs into the operating system, so browsers accept it but
   * yt-dlp reports CERTIFICATE_VERIFY_FAILED. `--compat-options no-certifi` makes yt-dlp use the
   * system certificate store instead. That is always done on Windows, where the store is the
   * source of truth, and elsewhere as a retry when the bundled list fails. Certificate checking
   * itself is never turned off.
   */
  private async exec(args: string[], options: Parameters<typeof run>[2], network = true): Promise<RunResult> {
    const executable = await this.executable();
    const extra: string[] = [];
    const proxy = this.settings().proxy.trim();
    if (network && proxy) extra.push("--proxy", proxy);
    const systemCerts = ["--compat-options", "no-certifi"];
    const withCerts = (useSystem: boolean) => (network && useSystem ? [...systemCerts, ...extra, ...args] : [...extra, ...args]);

    const first = await run(executable, withCerts(process.platform === "win32"), options);
    if (!network || options.signal?.aborted || !isCertificateFailure(first)) return first;
    if (process.platform === "win32") {
      // Windows may not have fetched a public root yet; fall back to yt-dlp's bundled list.
      const retry = await run(executable, withCerts(false), options);
      if (!isCertificateFailure(retry)) return retry;
    } else {
      // The bundled OpenSSL does not know where Linux/macOS keep their certificates, so name the
      // system bundle explicitly for the retry.
      const bundle = await systemCertificateBundle();
      const env = bundle ? { SSL_CERT_FILE: bundle } : undefined;
      const retry = await run(executable, withCerts(true), { ...options, env });
      if (!isCertificateFailure(retry)) return retry;
    }
    throw new YtDlpError(
      "A firewall or security program on this network intercepts HTTPS (deep packet inspection), and its " +
      "certificate is not trusted by this computer's certificate store. Ask IT to install the company " +
      "root certificate in the system store, or set a proxy in the plugin settings if the network requires one.");
  }
}

// `--encoding utf-8` keeps titles and paths intact on Windows, whose pipes default to the ANSI code page.
const BASE_ARGS = ["--ignore-config", "--no-warnings", "--no-playlist", "--no-cache-dir", "--socket-timeout", "20", "--encoding", "utf-8"];

/** Delete a temporary folder, retrying while Windows still holds a file open (EBUSY/EPERM). */
export async function removeFolder(folder: string): Promise<void> {
  try {
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn("[youtube-native] could not remove a temporary folder", folder, error);
  }
}

/** Video entries from a flat playlist; a channel's tabs (Videos, Shorts, …) are flattened. */
function readEntries(root: Record<string, unknown>): SearchResult[] {
  const entries = Array.isArray(root.entries) ? (root.entries as Record<string, unknown>[]) : [];
  return entries.flatMap((entry) => {
    if (entry && Array.isArray(entry.entries)) return readEntries(entry);
    const id = typeof entry?.id === "string" ? entry.id : null;
    if (!isVideoId(id)) return [];
    return [{
      id,
      title: typeof entry.title === "string" ? entry.title : id,
      channel: typeof entry.channel === "string" ? entry.channel : typeof entry.uploader === "string" ? entry.uploader : "",
      duration: typeof entry.duration === "number" ? entry.duration : null,
      views: typeof entry.view_count === "number" ? entry.view_count : null,
    }];
  });
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new YtDlpError("yt-dlp returned invalid metadata.");
}

/** yt-dlp sometimes reports a failed page with exit code 0, so look at the error text itself. */
export function isCertificateFailure(result: RunResult): boolean {
  return /CERTIFICATE_VERIFY_FAILED|certificate verify failed/i.test(result.stderr);
}

async function systemCertificateBundle(): Promise<string | null> {
  for (const file of [
    "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem",
    "/etc/ssl/cert.pem", "/opt/homebrew/etc/openssl@3/cert.pem", "/usr/local/etc/openssl@3/cert.pem",
  ]) {
    try {
      if ((await fs.stat(file)).isFile()) return file;
    } catch {
      // try the next location
    }
  }
  return null;
}

function errorSummary(result: RunResult, fallback: string): string {
  const line = result.stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("ERROR:")).pop();
  return line ? `${fallback} ${line.replace(/^ERROR:\s*/, "")}` : fallback;
}

/** Run a process with bounded stdout, an optional timeout, cancellation, and per-line callbacks. */
export function run(executable: string, args: string[], options: {
  maxStdout: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
  env?: Record<string, string>;
}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: os.tmpdir(),
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...options.env },
    });
    let stdout = "", stderr = "", pending = "", finished = false, overflow = false;
    const stop = () => { if (!finished) killTree(child.pid, () => child.kill()); };
    const timer = options.timeoutMs ? window.setTimeout(stop, options.timeoutMs) : null;
    options.signal?.addEventListener("abort", stop, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length + chunk.length > options.maxStdout) {
        overflow = true;
        stop();
        return;
      }
      stdout += chunk;
      if (options.onLine) {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) options.onLine(line);
      }
    });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.on("error", (error) => {
      finished = true;
      if (timer) window.clearTimeout(timer);
      reject(new YtDlpError(`Could not start ${path.basename(executable)}: ${error.message}`));
    });
    child.on("close", (code) => {
      finished = true;
      if (timer) window.clearTimeout(timer);
      if (pending && options.onLine) options.onLine(pending);
      if (overflow) reject(new YtDlpError("yt-dlp returned more output than expected."));
      else resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Stop a process and its children. yt-dlp.exe is a PyInstaller build that runs Python in a child
 * process, so on Windows killing only the parent would leave the download running.
 */
function killTree(pid: number | undefined, fallback: () => void) {
  if (process.platform !== "win32" || !pid) {
    fallback();
    return;
  }
  const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  killer.on("error", fallback);
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") await fs.access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  // GUI launches on Linux and macOS often get a minimal PATH; check the usual install places too.
  if (process.platform !== "win32")
    dirs.push("/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", path.join(os.homedir(), ".local", "bin"));
  for (const dir of [...new Set(dirs)]) {
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}
