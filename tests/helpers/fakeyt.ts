// Test doubles for the built-in engine: a fake Innertube and a local "googlevideo" server that
// serves deterministic bytes and honours Range requests.

import http from "node:http";
import net from "node:net";

export const VID = "jNQXAC9IVRw";
export const MIB = 1024 * 1024;

/** Deterministic content: the byte at offset i of file `seed`. */
export function bytesOf(seed: number, start: number, endExclusive: number): Buffer {
  const out = Buffer.alloc(Math.max(0, endExclusive - start));
  for (let i = 0; i < out.length; i++) out[i] = ((start + i) * 31 + seed * 17 + ((start + i) >> 8)) & 0xff;
  return out;
}

export interface FileMode {
  size: number;
  seed?: number;
  /** 403 for any range longer than this many bytes (the IOS client's behaviour). */
  maxRange?: number;
  /** 403 for everything. */
  forbid?: boolean;
  /** 403 only for ranges reaching past this offset (an adaptive stream without PO token). */
  forbidPast?: number;
  /** HTTP status for everything, e.g. 500. */
  status?: number;
  /** HTTP status for ranges longer than the 1 KiB probe only. */
  dataStatus?: number;
  /** Ignore Range and answer 200 with the whole file. */
  ignoreRange?: boolean;
  /** Leave out the /total part of Content-Range. */
  noTotal?: boolean;
  /** Destroy the socket after sending this many bytes, for the first `times` data requests. */
  dropAfter?: number;
  dropTimes?: number;
  /** Always destroy the socket after dropAfter bytes. */
  dropAlways?: boolean;
  /** Send pieces of 64 KiB with this delay (ms) between them. */
  delay?: number;
}

export interface Media {
  url(key: string): string;
  add(key: string, mode: FileMode): void;
  hits: Array<{ key: string; range: string }>;
  rangesFor(key: string): string[];
  close(): Promise<void>;
}

export async function mediaServer(): Promise<Media> {
  const files = new Map<string, FileMode>();
  const hits: Media["hits"] = [];
  const drops = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const key = (req.url ?? "").replace(/^\/m\//, "").split("?")[0] ?? "";
    const mode = files.get(key);
    const range = String(req.headers.range ?? "");
    hits.push({ key, range });
    if (!mode) { res.statusCode = 404; return res.end(); }
    if (mode.status) { res.statusCode = mode.status; return res.end("err"); }
    if (mode.forbid) { res.statusCode = 403; return res.end(); }
    const size = mode.size, seed = mode.seed ?? 1;
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m || mode.ignoreRange) {
      res.statusCode = 200;
      res.setHeader("content-length", String(size));
      return void send(0, size);
    }
    const a = Number(m[1]);
    const b = Math.min(m[2] ? Number(m[2]) : size - 1, size - 1);
    if (a >= size) { res.statusCode = 416; res.setHeader("content-range", `bytes */${size}`); return res.end(); }
    if (mode.dataStatus && b - a + 1 > 1024) { res.statusCode = mode.dataStatus; return res.end("err"); }
    if ((mode.maxRange && b - a + 1 > mode.maxRange) || (mode.forbidPast !== undefined && b >= mode.forbidPast)) { res.statusCode = 403; return res.end(); }
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${a}-${b}/${mode.noTotal ? "*" : size}`);
    res.setHeader("content-length", String(b - a + 1));
    void send(a, b + 1);

    async function send(from: number, to: number): Promise<void> {
      const attempts = (drops.get(key) ?? 0);
      const dropping = mode!.dropAfter !== undefined && (mode!.dropAlways || attempts < (mode!.dropTimes ?? 1));
      if (dropping && from === a) drops.set(key, attempts + 1);
      let sent = 0;
      for (let at = from; at < to; at += 65536) {
        const piece = bytesOf(seed, at, Math.min(at + 65536, to));
        if (dropping && mode!.dropAfter !== undefined && sent + piece.length > mode!.dropAfter) {
          res.write(piece.subarray(0, Math.max(0, mode!.dropAfter - sent)));
          setTimeout(() => req.socket.destroy(), 10);
          return;
        }
        sent += piece.length;
        if (!res.write(piece)) await new Promise<void>((r) => res.once("drain", () => r()));
        if (mode!.delay) await new Promise((r) => setTimeout(r, mode!.delay));
        if (res.destroyed) return;
      }
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: (key) => `http://127.0.0.1:${port}/m/${key}`,
    add: (key, mode) => { files.set(key, mode); },
    hits,
    rangesFor: (key) => hits.filter((h) => h.key === key).map((h) => h.range),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

// ---- raw youtubei.js-shaped formats ----

export const H264 = 'video/mp4; codecs="avc1.640028"';
export const VP9 = 'video/webm; codecs="vp9"';
export const MUXED = 'video/mp4; codecs="avc1.42001E, mp4a.40.2"';
export const AAC = 'audio/mp4; codecs="mp4a.40.2"';
export const OPUS = 'audio/webm; codecs="opus"';

export function video(itag: number, height: number, url: string, extra: Record<string, unknown> = {}): any {
  return { itag, url, mime_type: H264, has_video: true, has_audio: false, height, fps: 30, bitrate: height * 4000, content_length: String(1000), ...extra };
}
export function audio(itag: number, url: string, extra: Record<string, unknown> = {}): any {
  return { itag, url, mime_type: AAC, has_video: false, has_audio: true, bitrate: 128000, content_length: String(1000), ...extra };
}
export function muxed(itag: number, height: number, url: string, extra: Record<string, unknown> = {}): any {
  return { itag, url, mime_type: MUXED, has_video: true, has_audio: true, height, fps: 30, bitrate: 500000, content_length: String(1000), ...extra };
}

export function info(o: { status?: string; reason?: string; live?: boolean; duration?: number; title?: string; formats?: any[]; adaptive?: any[] } = {}): any {
  return {
    playability_status: { status: o.status ?? "OK", reason: o.reason },
    basic_info: { duration: o.duration ?? 212, title: o.title ?? "Title", is_live: o.live ?? false },
    streaming_data: { formats: o.formats ?? [], adaptive_formats: o.adaptive ?? [] },
  };
}

export class FakeYt {
  session = { player: { fake: true } };
  calls: Array<{ id: string; client: string }> = [];
  searches: Array<{ query: string; options: any }> = [];
  actionsCalls: any[] = [];
  playlists: string[] = [];
  resolved: string[] = [];
  channels: string[] = [];
  clients: Record<string, any>;
  searchImpl: (query: string, options: any) => Promise<any> = async () => { throw new Error("search not set"); };
  playlistImpl: (id: string) => Promise<any> = async () => { throw new Error("playlist not set"); };
  resolveImpl: (url: string) => Promise<any> = async () => ({ payload: { browseId: "UC" + "a".repeat(22) } });
  channelImpl: (id: string) => Promise<any> = async () => { throw new Error("channel not set"); };
  actions = { execute: async (endpoint: string, args: any) => { this.actionsCalls.push({ endpoint, args }); throw new Error("actions.execute sentinel"); } };

  constructor(clients: Record<string, any> = {}) { this.clients = clients; }

  async getBasicInfo(id: string, options: { client: string }): Promise<any> {
    this.calls.push({ id, client: options.client });
    const v = this.clients[options.client];
    if (typeof v === "function") return v();
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error("no info for " + options.client);
    return v;
  }
  async search(query: string, options: any): Promise<any> { this.searches.push({ query, options }); return this.searchImpl(query, options); }
  async getPlaylist(id: string): Promise<any> { this.playlists.push(id); return this.playlistImpl(id); }
  async resolveURL(url: string): Promise<any> { this.resolved.push(url); return this.resolveImpl(url); }
  async getChannel(id: string): Promise<any> { this.channels.push(id); return this.channelImpl(id); }
}

// ---- feed nodes ----

export function vnode(id: string, title: string, o: { channel?: string; seconds?: number; views?: string } = {}): any {
  return {
    type: "Video", video_id: id, title: { text: title },
    author: o.channel === undefined ? undefined : { name: o.channel },
    duration: o.seconds === undefined ? undefined : { seconds: o.seconds },
    view_count: o.views === undefined ? undefined : { text: o.views },
  };
}

/** A paged feed: `pages[0]` is the feed itself, later pages come from getContinuation. */
export function feed(key: "results" | "items" | "videos", pages: any[][], onContinue?: (n: number) => void): any {
  const make = (i: number): any => {
    const f: any = { [key]: pages[i] ?? [], has_continuation: i + 1 < pages.length };
    f.getContinuation = async () => { onContinue?.(i + 1); return make(i + 1); };
    return f;
  };
  return make(0);
}

export const id11 = (n: number) => "v" + String(n).padStart(10, "0");
