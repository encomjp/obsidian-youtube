// The built-in stream engine: YouTube's own player API through youtubei.js, with Node networking so
// no external program (yt-dlp) is needed. Metadata and stream URLs come from the mobile clients
// (IOS, then ANDROID, ...), whose URLs work without a JavaScript signature solver.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Innertube, Log, YT } from "youtubei.js";
import type { Actions, ISearchResponse } from "youtubei.js";
import type { Engine, SearchResult, VideoFormats } from "./engine.ts";
import { YtDlpError } from "./formats.ts";
import type { DownloadProgress, Playback, StreamFormat } from "./formats.ts";
import { isVideoId } from "./youtube.ts";
import { CERTIFICATE_HELP, isCertificateError } from "./certs.ts";
import { createNodeFetch } from "./nodefetch.ts";
import {
  CHUNK_BYTES, classifyListUrl, formatBytes, formatEta, formatSpeed, mapFormats, pageSlice,
  playabilityMessage, resultsFromNodes, selectPlayback,
} from "./jsmap.ts";
import type { RawFormat } from "./jsmap.ts";

const SESSION_TTL_MS = 6 * 3600 * 1000;
const CLIENTS = ["IOS", "ANDROID", "TV", "MWEB"] as const;
const SMALL_CHUNK_BYTES = 1024 * 1024;
const PAGE_SIZE = 15;
const LIST_TTL_MS = 10 * 60 * 1000;
const MAX_LISTS = 8;
/** YouTube's "Sort by upload date, type Video" search parameter. */
const SEARCH_BY_DATE = "CAISAhAB";

interface Streams {
  title: string | null;
  duration: number | null;
  formats: StreamFormat[];
}

/** The parts of a youtubei.js feed (search, playlist, channel videos) this engine reads. */
interface Feed {
  has_continuation?: boolean;
  getContinuation?: () => Promise<Feed>;
  results?: unknown;
  items?: unknown;
  videos?: unknown;
}

/** A string or a youtubei.js Text node (its toString gives the text). */
type Printable = string | { toString(): string };

interface ChannelLike {
  metadata?: { title?: Printable };
  header?: { author?: { name?: Printable } };
  getVideos: () => Promise<Feed>;
}

type FormatLike = RawFormat & { decipher?: (player: unknown) => Promise<string> };

interface InfoLike {
  playability_status?: { status?: string; reason?: string };
  basic_info?: { is_live?: boolean; duration?: unknown; title?: unknown };
  streaming_data?: { formats?: FormatLike[]; adaptive_formats?: FormatLike[] };
}

/** The parts of an `Innertube` session this engine calls. */
export interface InnertubeLike {
  search: (query: string, options: { type: string }) => Promise<Feed>;
  getPlaylist: (id: string) => Promise<Feed>;
  resolveURL: (url: string) => Promise<unknown>;
  getChannel: (browseId: string) => Promise<ChannelLike>;
  getBasicInfo: (id: string, options: { client: string }) => Promise<InfoLike>;
  session: { player?: unknown };
  actions: { execute: (endpoint: string, args: object) => Promise<unknown> };
}

interface Lister {
  items: SearchResult[];
  more: (() => Promise<SearchResult[]>) | null;
  at: number;
}

/** Test seams: replace the Innertube session factory and the by-date search feed. */
export interface JsEngineDeps {
  createInnertube?: (fetchImpl: ReturnType<typeof createNodeFetch>) => Promise<InnertubeLike>;
  dateSearch?: (yt: InnertubeLike, query: string) => Promise<Feed>;
}

export class JsEngine implements Engine {
  readonly id = "js" as const;
  private readonly getSettings: () => { proxy: string };
  private session: Promise<InnertubeLike> | null = null;
  private sessionAt = 0;
  private readonly fetchImpl: ReturnType<typeof createNodeFetch>;
  private readonly lists = new Map<string, Lister>();
  /** Range size per request. 8 MiB where allowed; the IOS client's URLs answer 403 above roughly 1 MiB. */
  private chunkBytes = CHUNK_BYTES;

  private readonly deps: JsEngineDeps;

  constructor(getSettings: () => { proxy: string }, deps: JsEngineDeps = {}) {
    this.getSettings = getSettings;
    this.deps = deps;
    this.fetchImpl = createNodeFetch(() => this.getSettings().proxy ?? "");
  }

  async describe(): Promise<string> {
    return "Built-in engine (youtubei.js, no external program)";
  }

  async playback(id: string, maxHeight: number): Promise<Playback> {
    const streams = await this.streams(id);
    try {
      return selectPlayback(streams.title, streams.formats, maxHeight);
    } catch (error) {
      throw new YtDlpError(error instanceof Error ? error.message : "No playable video stream was returned.");
    }
  }

  async formats(id: string): Promise<VideoFormats> {
    const streams = await this.streams(id);
    return { title: streams.title, formats: streams.formats, duration: streams.duration };
  }

  async search(query: string, options: { page?: number; pageSize?: number; sort?: "relevance" | "date" } = {}): Promise<SearchResult[]> {
    const text = query.replace(/[\r\n]/g, " ").trim();
    if (!text) return [];
    const size = options.pageSize ?? PAGE_SIZE, page = Math.max(options.page ?? 0, 0);
    const sort = options.sort === "date" ? "date" : "relevance";
    return this.page(`search:${sort}:${text}`, page, size, async (yt) => {
      const feed = sort === "date"
        ? await (this.deps.dateSearch ?? defaultDateSearch)(yt, text)
        : await yt.search(text, { type: "video" });
      return feedLister(feed, (f) => f.results);
    }, "YouTube search failed.");
  }

  async listUrl(url: string, options: { page?: number; pageSize?: number } = {}): Promise<SearchResult[]> {
    const size = options.pageSize ?? PAGE_SIZE, page = Math.max(options.page ?? 0, 0);
    const target = classifyListUrl(url.trim());
    if (!target) throw new YtDlpError("That link is not a YouTube playlist or channel.");
    const key = "list:" + (target.kind === "playlist" ? target.id : target.url);
    return this.page(key, page, size, async (yt) => {
      if (target.kind === "playlist") {
        const playlist = await yt.getPlaylist(target.id);
        return feedLister(playlist, (f) => f.items);
      }
      let browseId = target.browseId;
      if (!browseId) {
        const endpoint = await yt.resolveURL(target.url);
        const payload = asRecord(asRecord(endpoint)?.payload);
        browseId = payload?.browseId as string | undefined;
      }
      if (typeof browseId !== "string") throw new YtDlpError("Could not find that channel.");
      const channel = await yt.getChannel(browseId);
      const videos = await channel.getVideos();
      const name = String(channel.metadata?.title ?? channel.header?.author?.name ?? "");
      return feedLister(videos, (f) => f.videos, name);
    }, "Could not list that link.");
  }

  async download(id: string, formatIds: string[], onProgress: (p: DownloadProgress) => void,
    signal: AbortSignal): Promise<{ files: string[]; folder: string }> {
    if (!isVideoId(id)) throw new YtDlpError("Invalid YouTube video id.");
    if (formatIds.length === 0 || formatIds.some((f) => !/^[A-Za-z0-9._-]{1,64}$/.test(f)))
      throw new YtDlpError("Invalid format id.");
    if (signal.aborted) throw new YtDlpError("Download cancelled.");
    const streams = await this.streams(id);
    const chosen = formatIds.map((formatId) => {
      const f = streams.formats.find((x) => x.formatId === formatId);
      if (!f) throw new YtDlpError(`Format ${formatId} is no longer offered for this video.`);
      return f;
    });

    const folder = path.join(os.tmpdir(), "obsidian-youtube-" + randomUUID());
    await fs.mkdir(folder, { recursive: true });
    try {
      const files: string[] = [];
      for (const format of chosen) {
        const file = path.join(folder, `${id}.f${format.formatId}.${format.ext}`);
        await this.downloadFile(format, file, onProgress, signal);
        files.push(file);
      }
      return { files, folder };
    } catch (error) {
      await removeFolder(folder);
      if (signal.aborted) throw new YtDlpError("Download cancelled.");
      throw error instanceof YtDlpError ? error : new YtDlpError(describeError(error, "The download failed."));
    }
  }

  // ---- internals ----

  /**
   * Stream info for a video. Each client's formats are probed with a ranged request near the END of
   * the file: without a PO token YouTube answers 403 for most of an adaptive stream (only a leading
   * part is served), and those URLs would stall playback and downloads. Formats that fail are dropped;
   * the next client may still offer a working (often muxed, lower resolution) stream.
   */
  private async streams(id: string): Promise<Streams> {
    if (!isVideoId(id)) throw new YtDlpError("Invalid YouTube video id.");
    let firstProblem: string | null = null;
    let sawError: unknown = null;
    let title: string | null = null;
    let duration: number | null = null;
    const good: StreamFormat[] = [];
    for (const client of CLIENTS) {
      try {
        const yt = await this.innertube();
        const info = await yt.getBasicInfo(id, { client });
        const status = info.playability_status;
        const message = playabilityMessage(status?.status, status?.reason, Boolean(info.basic_info?.is_live));
        if (message) { firstProblem ??= message; continue; }
        const rawDuration = info.basic_info?.duration;
        const clientDuration = typeof rawDuration === "number" && rawDuration > 0 ? rawDuration : null;
        const raws: RawFormat[] = [];
        for (const f of [...(info.streaming_data?.formats ?? []), ...(info.streaming_data?.adaptive_formats ?? [])]) {
          let url: string | undefined = f.url;
          if (!url) {
            try { url = await decipher(f, yt.session.player); } catch { url = undefined; }
          }
          raws.push({ ...f, url });
        }
        const fresh = mapFormats(raws, clientDuration).filter((f) => !good.some((g) => g.formatId === f.formatId));
        const verdicts = await Promise.all(fresh.map((f) => this.serves(f)));
        title ??= typeof info.basic_info?.title === "string" ? info.basic_info.title : null;
        duration ??= clientDuration;
        fresh.forEach((f, i) => { if (verdicts[i]) good.push(f); });
        // A separate video + audio pair is the best result; otherwise keep looking for more.
        if (good.some((f) => f.hasVideo && !f.hasAudio) && good.some((f) => f.hasAudio && !f.hasVideo)) break;
      } catch (error) {
        sawError = error;
      }
    }
    if (good.some((f) => f.hasVideo)) return { title, duration, formats: good };
    if (firstProblem) throw new YtDlpError(firstProblem);
    this.session = null; // a fresh session next time
    const detail = sawError instanceof Error ? sawError.message : "";
    if (/unavailable|private|sign in|login|age|blocked|not available|live/i.test(detail)) throw new YtDlpError("YouTube cannot play this video: " + detail);
    throw new YtDlpError(describeError(sawError, "YouTube returned no playable streams for this video."));
  }

  /** True when the stream's URL serves bytes from the end of the file (see `streams`). */
  private async serves(format: StreamFormat): Promise<boolean> {
    const size = format.filesize ?? (format.filesizeApprox ? Math.floor(format.filesizeApprox * 0.9) : 0);
    const range = size > 2048 ? `bytes=${size - 1024}-${size - 1}` : "bytes=0-1023";
    try {
      const response = await this.fetchImpl(format.url, { headers: { Range: range } });
      await response.body?.cancel().catch(() => undefined);
      // 416: the guessed size overshot the real file, which still proves the URL is accepted.
      return response.status === 206 || response.status === 200 || response.status === 416;
    } catch {
      return false;
    }
  }

  private async innertube(): Promise<InnertubeLike> {
    if (this.session && Date.now() - this.sessionAt > SESSION_TTL_MS) this.session = null;
    if (!this.session) {
      Log.setLevel(Log.Level.NONE);
      this.sessionAt = Date.now();
      const created: Promise<InnertubeLike> = this.deps.createInnertube
        ? this.deps.createInnertube(this.fetchImpl)
        : Innertube.create({
          retrieve_player: true,
          generate_session_locally: true,
          fetch: this.fetchImpl,
        }) as unknown as Promise<InnertubeLike>;
      this.session = created;
      created.catch(() => { if (this.session === created) this.session = null; });
    }
    try {
      return await this.session;
    } catch (error) {
      this.session = null;
      throw new YtDlpError(describeError(error, "Could not reach YouTube."));
    }
  }

  private async page(key: string, page: number, size: number, open: (yt: InnertubeLike) => Promise<Lister>, failure: string): Promise<SearchResult[]> {
    const need = (page + 1) * size;
    let list = this.lists.get(key);
    if (page === 0 || !list || Date.now() - list.at > LIST_TTL_MS) {
      try {
        const yt = await this.innertube();
        list = await open(yt);
      } catch (error) {
        this.lists.delete(key);
        throw error instanceof YtDlpError ? error : new YtDlpError(describeError(error, failure));
      }
      this.lists.delete(key);
      this.lists.set(key, list);
      while (this.lists.size > MAX_LISTS) this.lists.delete(this.lists.keys().next().value as string);
    }
    try {
      while (list.items.length < need && list.more) {
        const more = list.more;
        const added = await more();
        const known = new Set(list.items.map((r) => r.id));
        for (const r of added) if (!known.has(r.id)) { known.add(r.id); list.items.push(r); }
        if (added.length === 0) list.more = null;
      }
    } catch (error) {
      list.more = null;
      if (list.items.length <= page * size) throw new YtDlpError(describeError(error, failure));
    }
    list.at = Date.now();
    return pageSlice(list.items, page, size);
  }

  private async downloadFile(format: StreamFormat, file: string, onProgress: (p: DownloadProgress) => void,
    signal: AbortSignal): Promise<void> {
    const handle = await fs.open(file, "w");
    let total = format.filesize;
    let done = 0; // bytes of completed chunks plus the bytes of the chunk in flight
    let lastReport = 0;
    const samples: Array<[number, number]> = [[Date.now(), 0]];
    const report = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastReport < 250) return;
      lastReport = now;
      samples.push([now, done]);
      while (samples.length > 2 && now - (samples[0] as [number, number])[0] > 4000) samples.shift();
      const [t0, b0] = samples[0] as [number, number];
      const speed = now > t0 ? (done - b0) / ((now - t0) / 1000) : null;
      onProgress({
        percent: total ? Math.min(100, done / total * 100) : null,
        total: total ? formatBytes(total) : "Unknown",
        speed: formatSpeed(speed),
        eta: formatEta(speed && total ? (total - done) / speed : null),
      });
    };
    try {
      let retries = 0;
      while (total === null || done < total) {
        if (signal.aborted) throw new YtDlpError("Download cancelled.");
        const start = done;
        const last = total === null ? start + this.chunkBytes - 1 : Math.min(start + this.chunkBytes, total) - 1;
        try {
          const response = await this.fetchImpl(format.url, { headers: { Range: `bytes=${start}-${last}` }, signal });
          if (response.status === 403 && this.chunkBytes > SMALL_CHUNK_BYTES) {
            await response.body?.cancel().catch(() => undefined);
            this.chunkBytes = SMALL_CHUNK_BYTES; // this URL only serves small ranges
            continue;
          }
          if (response.status !== 206 && !(response.status === 200 && start === 0)) {
            await response.body?.cancel().catch(() => undefined);
            throw new YtDlpError(`YouTube refused the download (HTTP ${response.status}).`);
          }
          const range = /\/(\d+)\s*$/.exec(response.headers.get("content-range") ?? "");
          if (range) total = Number(range[1]);
          else if (response.status === 200) total = Number(response.headers.get("content-length")) || total;
          if (!response.body) throw new Error("YouTube sent an empty response.");
          let got = 0;
          // A reader works with the renderer's own streams; Node's Readable.fromWeb rejects them.
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { value, done: finished } = await reader.read();
              if (finished) break;
              await handle.write(value, 0, value.length, start + got);
              got += value.length;
              done = start + got;
              report(false);
            }
          } finally {
            reader.releaseLock();
          }
          if (got === 0) throw new Error("YouTube sent no data.");
          done = start + got;
          if (total === null && got < last - start + 1) total = done; // short piece: that was the end
          retries = 0;
        } catch (error) {
          done = start; // redo the chunk
          if (signal.aborted) throw new YtDlpError("Download cancelled.");
          if (error instanceof YtDlpError || ++retries > 3) throw error;
          await new Promise((r) => setTimeout(r, 500 * retries));
        }
      }
      report(true);
      await handle.close();
      const size = (await fs.stat(file)).size;
      if (total !== null && size !== total) throw new YtDlpError(`The download is incomplete (${size} of ${total} bytes).`);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
}

async function defaultDateSearch(yt: InnertubeLike, query: string): Promise<Feed> {
  const response = await yt.actions.execute("/search", { query, params: SEARCH_BY_DATE, parse: true });
  return new YT.Search(yt.actions as Actions, response as ISearchResponse);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

async function decipher(format: FormatLike, player: unknown): Promise<string> {
  if (!format.decipher) throw new TypeError("This format cannot be deciphered.");
  return format.decipher(player);
}

/** A lister over a youtubei.js feed: its first page now, further pages through continuations. */
function feedLister(feed: Feed, nodes: (f: Feed) => unknown, channelName = ""): Lister {
  const read = (f: Feed) => resultsFromNodes(nodes(f)).map((r) => (r.channel || !channelName ? r : { ...r, channel: channelName }));
  const lister: Lister = { items: read(feed), more: null, at: Date.now() };
  let current = feed;
  if (current.has_continuation) {
    lister.more = async () => {
      if (!current.has_continuation || !current.getContinuation) return [];
      current = await current.getContinuation();
      return read(current);
    };
  }
  return lister;
}

function describeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (!message) return fallback;
  if (isCertificateError(error)) return `${fallback} ${CERTIFICATE_HELP} (${message})`;
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|fetch failed|socket hang up|Proxy/i.test(message))
    return `${fallback} Network problem: ${message}`;
  return `${fallback} ${message}`;
}

/** Delete a temporary folder, retrying while Windows still holds a file open (EBUSY/EPERM). */
async function removeFolder(folder: string): Promise<void> {
  try {
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.warn("[youtube-native] could not remove a temporary folder", folder, error);
  }
}
