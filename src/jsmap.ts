// Pure mapping for the built-in engine: youtubei.js data -> the plugin's own types. No network, no
// Node or Obsidian imports, so it is unit-tested with hand-made fixtures.

import type { Playback, StreamFormat } from "./formats.ts";
import type { SearchResult } from "./engine.ts";

/** The fields of a youtubei.js `Format` this module reads (all optional; the library is loosely typed). */
export interface RawFormat {
  itag?: number;
  url?: string;
  mime_type?: string;
  has_video?: boolean;
  has_audio?: boolean;
  has_text?: boolean;
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  average_bitrate?: number;
  content_length?: number | string;
  is_drc?: boolean;
  is_type_otf?: boolean;
  is_dubbed?: boolean;
  is_auto_dubbed?: boolean;
  is_descriptive?: boolean;
}

export const CHUNK_BYTES = 8 * 1024 * 1024;

const VIDEO_CODEC = /^(avc1|avc3|vp9|vp09|vp8|av01|hev1|hvc1|h263|theora)/i;
const AUDIO_CODEC = /^(mp4a|opus|vorbis|ac-3|ec-3|flac|mp3)/i;

export interface ParsedMime {
  container: string;
  video: string;
  audio: string;
}

/** `video/mp4; codecs="avc1.4D400C, mp4a.40.2"` -> container and codec per kind ("" when absent). */
export function parseMime(mime: string | undefined): ParsedMime {
  const text = mime ?? "";
  const container = (/^\s*([a-z]+\/[a-z0-9.+-]+)/i.exec(text)?.[1] ?? "").toLowerCase();
  const list = /codecs\s*=\s*"?([^";]*)"?/i.exec(text)?.[1] ?? "";
  let video = "", audio = "";
  for (const raw of list.split(",")) {
    const codec = raw.trim();
    if (!codec) continue;
    if (VIDEO_CODEC.test(codec)) video ||= codec;
    else if (AUDIO_CODEC.test(codec)) audio ||= codec;
  }
  return { container, video, audio };
}

/** File extension for a mime container, the way yt-dlp names them. */
export function extFor(container: string): string {
  switch (container) {
    case "video/mp4": return "mp4";
    case "audio/mp4": return "m4a";
    case "video/webm": case "audio/webm": return "webm";
    case "video/3gpp": return "3gp";
    default: return "";
  }
}

function num(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * One youtubei.js format -> StreamFormat, or null for formats the player cannot use (no direct
 * http(s) URL, text tracks, live OTF segments, DRC/dubbed duplicates are filtered by the caller).
 */
export function mapFormat(raw: RawFormat, duration: number | null): StreamFormat | null {
  if (typeof raw.url !== "string" || !/^https?:\/\//i.test(raw.url)) return null;
  if (raw.itag === undefined || !Number.isInteger(raw.itag) || raw.itag <= 0) return null;
  if (raw.has_text || raw.is_type_otf) return null;
  const mime = parseMime(raw.mime_type);
  const ext = extFor(mime.container);
  if (!ext) return null;
  const hasVideo = raw.has_video ?? mime.container.startsWith("video/");
  const hasAudio = raw.has_audio ?? (mime.audio !== "" || mime.container.startsWith("audio/"));
  if (!hasVideo && !hasAudio) return null;

  const bits = num(raw.average_bitrate) ?? num(raw.bitrate);
  const bitrate = bits === null ? null : Math.round(bits / 100) / 10; // kbit/s, like yt-dlp's tbr/abr
  const filesize = num(raw.content_length);
  const filesizeApprox = filesize === null && bits !== null && duration ? Math.round(bits * duration / 8) : null;
  const height = hasVideo ? num(raw.height) : null;
  return {
    url: raw.url,
    formatId: String(raw.itag),
    ext,
    height: height && height > 0 ? height : null,
    fps: hasVideo ? num(raw.fps) : null,
    bitrate,
    filesize: filesize && filesize > 0 ? filesize : null,
    filesizeApprox,
    vcodec: hasVideo ? (mime.video || "unknown") : "none",
    acodec: hasAudio ? (mime.audio || "unknown") : "none",
    protocol: "https",
    hasVideo,
    hasAudio,
  };
}

/**
 * Map a whole format list: drop unusable entries, DRC and dubbed/descriptive audio duplicates, and
 * repeated itags (the first one wins).
 */
export function mapFormats(raws: RawFormat[], duration: number | null): StreamFormat[] {
  const out: StreamFormat[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    if (raw.is_drc || raw.is_dubbed || raw.is_auto_dubbed || raw.is_descriptive) continue;
    const f = mapFormat(raw, duration);
    if (!f || seen.has(f.formatId)) continue;
    seen.add(f.formatId);
    out.push(f);
  }
  return out;
}

const isH264 = (f: StreamFormat) => /^avc/i.test(f.vcodec);
const isAv1 = (f: StreamFormat) => /^av01/i.test(f.vcodec);
const isVp9 = (f: StreamFormat) => /^vp0?9/i.test(f.vcodec);

/** Chromium (Obsidian) plays H.264, AV1 and VP9 video; AAC and Opus audio. */
export function playableVideo(f: StreamFormat): boolean {
  return f.hasVideo && (f.height ?? 0) > 0 && (isH264(f) || isAv1(f) || isVp9(f));
}

function playableAudio(f: StreamFormat): boolean {
  return f.hasAudio && /^(mp4a|opus)/i.test(f.acodec);
}

/** Higher is better: MP4/H.264 first (widest support), then AV1, then VP9. */
function codecRank(f: StreamFormat): number {
  return isH264(f) ? 3 : isAv1(f) ? 2 : isVp9(f) ? 1 : 0;
}

const byQuality = (a: StreamFormat, b: StreamFormat) =>
  (b.height ?? 0) - (a.height ?? 0) || codecRank(b) - codecRank(a) || (b.fps ?? 0) - (a.fps ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0);

export function bestAudio(formats: StreamFormat[]): StreamFormat | null {
  const list = formats.filter((f) => !f.hasVideo && playableAudio(f));
  // m4a (AAC) first for compatibility, then the highest bitrate.
  const rank = (f: StreamFormat) => (f.ext === "m4a" ? 1 : 0);
  return list.sort((a, b) => rank(b) - rank(a) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] ?? null;
}

/**
 * The stream pair for in-note playback: the best video no taller than the cap (0 = 720) plus the best
 * audio, or a muxed format when that is all there is. Throws when nothing playable exists.
 */
export function selectPlayback(title: string | null, formats: StreamFormat[], maxHeight: number): Playback {
  const cap = maxHeight > 0 ? maxHeight : 720;
  const videos = formats.filter(playableVideo);
  if (videos.length === 0) throw new Error("No playable video stream was returned.");
  const heights = [...new Set(videos.map((f) => f.height as number))].sort((a, b) => a - b);

  // Prefer the tallest stream under the cap; when everything is taller, use the smallest one.
  const under = videos.filter((f) => (f.height as number) <= cap);
  const pool = under.length > 0 ? under : videos.filter((f) => f.height === heights[0]);

  const audio = bestAudio(formats);
  const adaptive = pool.filter((f) => !f.hasAudio).sort(byQuality)[0];
  const muxed = pool.filter((f) => f.hasAudio).sort(byQuality)[0];
  // A separate pair is chosen unless it would be shorter than a muxed stream or has no audio partner.
  const useAdaptive = adaptive && audio && (!muxed || (adaptive.height ?? 0) >= (muxed.height ?? 0));
  const video = useAdaptive ? adaptive : muxed ?? adaptive;
  if (!video) throw new Error("No playable video stream was returned.");
  return {
    title,
    video,
    audio: video.hasAudio ? null : audio,
    height: video.height as number,
    heights,
  };
}

/** Inclusive `[start, end]` byte ranges that cover `total` bytes in `chunk`-sized pieces. */
export function planChunks(total: number, chunk: number = CHUNK_BYTES): Array<[number, number]> {
  if (!Number.isFinite(total) || total <= 0 || chunk <= 0) return [];
  const out: Array<[number, number]> = [];
  for (let start = 0; start < total; start += chunk) out.push([start, Math.min(start + chunk, total) - 1]);
  return out;
}

/** "42.0%" */
export function formatPercent(done: number, total: number | null): string {
  if (!total || total <= 0) return "";
  return (Math.min(100, Math.max(0, done / total * 100))).toFixed(1) + "%";
}

/** "12.34MiB", like yt-dlp's byte strings. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "Unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return value.toFixed(2) + units[i];
}

/** "3.20MiB/s" */
export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "Unknown B/s";
  return formatBytes(bytesPerSecond) + "/s";
}

/** "00:12", "01:02:03", or "Unknown". */
export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "Unknown";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${two(h)}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/** "1:02:03", "3:55", "0:19" -> seconds; null for anything else (e.g. "LIVE"). */
export function parseDuration(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** "444,275,066 views", "768M views", "1.2K views", "No views", "1 view" -> a number; null if unreadable. */
export function parseViews(text: string | null | undefined): number | null {
  if (typeof text !== "string") return null;
  const t = text.trim().toLowerCase();
  if (/^no views?/.test(t)) return 0;
  const m = /^([\d.,]+)\s*([kmb])?\s*views?\b/.exec(t);
  if (!m) return null;
  const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
  const digits = m[1] ?? "";
  const raw = m[2] ? digits.replace(/,/g, "") : digits.replace(/[.,]/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * mult) : null;
}

type Rec = Record<string, unknown>;

const ID = /^[A-Za-z0-9_-]{11}$/;

function asRec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null ? (value as Rec) : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  const inner = asRec(value)?.text;
  return typeof inner === "string" ? inner : "";
}

/**
 * A search/playlist/channel list node -> SearchResult, or null for non-videos (shelves, shorts,
 * channels, playlists). Handles the classic renderers (Video, PlaylistVideo, GridVideo, CompactVideo)
 * and the newer LockupView.
 */
export function resultFromNode(input: unknown): SearchResult | null {
  const node = asRec(input);
  if (!node) return null;
  if (node.type === "LockupView") {
    const id = node.content_id;
    if (node.content_type !== "VIDEO" || typeof id !== "string" || !ID.test(id)) return null;
    const rows = arr(asRec(asRec(node.metadata)?.metadata)?.metadata_rows);
    const parts: string[] = rows.flatMap((r) => arr(asRec(r)?.metadata_parts).map((p) => text(asRec(p)?.text)));
    let views: number | null = null, channel = "";
    for (const part of parts) {
      const v = parseViews(part);
      if (v !== null) views ??= v;
      else if (!channel && !/\bago$/i.test(part)) channel = part;
    }
    let duration: number | null = null;
    for (const overlay of arr(asRec(node.content_image)?.overlays))
      for (const badge of arr(asRec(overlay)?.badges)) {
        const label = asRec(badge)?.text;
        duration ??= parseDuration(typeof label === "string" ? label : undefined);
      }
    return { id, title: text(asRec(node.metadata)?.title) || id, channel, duration, views };
  }
  const id = node.video_id ?? node.id;
  if (typeof id !== "string" || !ID.test(id)) return null;
  if (typeof node.type !== "string" || !["Video", "PlaylistVideo", "GridVideo", "CompactVideo", "ReelItem"].includes(node.type)) return null;
  const durationSeconds = num(asRec(node.duration)?.seconds);
  const viewsText = text(node.view_count) || text(node.short_view_count);
  const authorName = asRec(node.author)?.name;
  return {
    id,
    title: text(node.title) || id,
    channel: text(authorName ? { text: authorName } : node.author) || "",
    duration: durationSeconds ?? parseDuration(text(node.length_text)),
    views: parseViews(viewsText),
  };
}

/** All video results in a node list, in order, without repeats. */
export function resultsFromNodes(nodes: unknown): SearchResult[] {
  if (!Array.isArray(nodes)) return [];
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const node of nodes) {
    const r = resultFromNode(node);
    if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
  }
  return out;
}

/** Where a pasted link points: a playlist id, or something that needs resolving (channel/handle). */
export function classifyListUrl(input: string): { kind: "playlist"; id: string } | { kind: "channel"; url: string; browseId?: string } | null {
  let url: URL;
  try { url = new URL(input.includes("://") ? input : "https://" + input); } catch { return null; }
  const host = url.hostname.toLowerCase();
  if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return null;
  const list = url.searchParams.get("list");
  if (list && /^[A-Za-z0-9_-]{2,}$/.test(list)) return { kind: "playlist", id: list };
  const parts = url.pathname.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  if (first.startsWith("@") && first.length > 1) return { kind: "channel", url: `https://www.youtube.com/${first}` };
  if (first === "channel" && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] ?? "")) {
    return { kind: "channel", url: `https://www.youtube.com/channel/${parts[1]}`, browseId: parts[1] };
  }
  if ((first === "c" || first === "user") && parts[1]) return { kind: "channel", url: `https://www.youtube.com/${first}/${parts[1]}` };
  return null;
}

/** A user-facing message for a non-OK playability status; null when the video can be played. */
export function playabilityMessage(status: string | undefined, reason: string | undefined, isLive: boolean): string | null {
  if (isLive) return "This is a live stream, which the built-in engine cannot play or save.";
  if (!status || status === "OK") return null;
  const why = reason ? ` (${reason})` : "";
  const r = (reason ?? "").toLowerCase();
  if (status === "LOGIN_REQUIRED") {
    if (/private/.test(r)) return `This video is private${why}.`;
    if (/age|confirm your age|inappropriate/.test(r)) return `This video is age-restricted and needs a signed-in account${why}.`;
    return `YouTube asked for a sign-in to play this video${why}.`;
  }
  if (status === "AGE_VERIFICATION_REQUIRED" || status === "CONTENT_CHECK_REQUIRED") return `This video is age-restricted${why}.`;
  if (status === "LIVE_STREAM_OFFLINE") return `This live stream is not available right now${why}.`;
  if (status === "UNPLAYABLE") return `This video is unavailable or blocked${why}.`;
  if (status === "ERROR") return `This video is unavailable${why}.`;
  return `YouTube cannot play this video (${status})${why}.`;
}

export function pageSlice<T>(items: T[], page: number, size: number): T[] {
  const p = Math.max(page, 0);
  return items.slice(p * size, (p + 1) * size);
}
