// Pure YouTube link and Markdown rules, ported from Starnote.Core/NoteMedia.cs and
// WebEmbedEngine.ParseTimeSeconds. No Obsidian or Node imports, so tests run without the app.

export interface NoteVideo {
  /** Canonical watch URL, including the kept start/end range. */
  source: string;
  title: string;
  id: string;
  startSeconds: number;
  endSeconds: number | null;
}

const ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_SECONDS = 7 * 24 * 3600;
const HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be", "www.youtu.be",
]);

export function isVideoId(id: string | null | undefined): id is string {
  return typeof id === "string" && ID.test(id);
}

/** Seconds from `90`, `90s`, `1m30s`, or `1h2m3s`; null when unreadable. */
export function parseTimeSeconds(input: string | null | undefined): number | null {
  if (input == null || input.trim() === "") return null;
  const text = input.trim().toLowerCase();
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d+s$/.test(text)) return Number.parseInt(text.slice(0, -1), 10);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return null;
  const total = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return Number.isSafeInteger(total) ? total : null;
}

/** A YouTube watch, share, Shorts, live, or embed link; null for anything else. */
export function parseYouTube(text: string | null | undefined): NoteVideo | null {
  if (text == null || text.trim() === "") return null;
  let candidate = text.trim();
  if (!candidate.includes("://")) candidate = "https://" + candidate;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;

  // A malformed % escape in user-written text stays as written: an undecodable timestamp is
  // treated as absent, never as a lost video id.
  const query = new Map<string, string>();
  for (const pair of url.search.replace(/^\?/, "").split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = safeDecode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    query.set(key, eq < 0 ? "" : safeDecode(pair.slice(eq + 1)));
  }

  const path = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  let id: string | undefined;
  if (host.endsWith("youtu.be")) id = path[0];
  else if (path.length === 2 && ["embed", "shorts", "live", "v"].includes(path[0] ?? "")) id = path[1];
  else if (path.length === 1 && path[0] === "watch") id = query.get("v");
  if (!isVideoId(id)) return null;

  let start = parseTimeSeconds(query.get("t") ?? query.get("start")) ?? 0;
  start = Math.min(Math.max(start, 0), MAX_SECONDS);
  let end = parseTimeSeconds(query.get("end"));
  if (end !== null && (end <= start || end > MAX_SECONDS)) end = null;

  return { source: watchUrl(id, start, end), title: "YouTube video", id, startSeconds: start, endSeconds: end };
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/**
 * The video in an iframe Obsidian rendered for a YouTube embed. Obsidian 1.14 points it at its
 * own wrapper page (`releases.obsidian.md/youtube?v=…&start=…`) rather than youtube.com/embed.
 */
export function videoFromEmbedSrc(src: string | null | undefined): NoteVideo | null {
  if (!src) return null;
  const direct = parseYouTube(src);
  if (direct) return direct;
  // A broken image Obsidian drew for a nested link carries the URL inside an encoded src.
  let decoded = src;
  try { decoded = decodeURIComponent(src); } catch { /* keep as is */ }
  const inner = /https?:\/\/(?:www\.|m\.|music\.)?(?:youtube(?:-nocookie)?\.com|youtu\.be)\/[^\s)\]"'<>]+/i.exec(decoded)?.[0];
  if (inner) {
    const nested = parseYouTube(inner);
    if (nested) return nested;
  }
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/(^|\.)obsidian\.md$/i.test(url.hostname) || !/\/youtube\/?$/.test(url.pathname)) return null;
  const id = url.searchParams.get("v");
  if (!isVideoId(id)) return null;
  const start = url.searchParams.get("start") ?? url.searchParams.get("t");
  const end = url.searchParams.get("end");
  return parseYouTube(watchUrl(id) + (start ? "&t=" + encodeURIComponent(start) : "") + (end ? "&end=" + encodeURIComponent(end) : ""));
}

export function watchUrl(id: string, start = 0, end: number | null = null): string {
  let address = "https://www.youtube.com/watch?v=" + id;
  if (start > 0) address += "&t=" + start;
  if (end !== null && end > start) address += "&end=" + end;
  return address;
}

/** True for the placeholder captions older notes already contain. */
export function isGenericTitle(title: string | null | undefined): boolean {
  const text = (title ?? "").trim().toLowerCase();
  return text === "video" || text === "embed" || text === "youtube video";
}

/** A caption safe inside `![…]`: brackets would close the alt text and newlines break the paragraph. */
export function captionTitle(video: Pick<NoteVideo, "title" | "id">): string {
  const title = (video.title ?? "").replace(/[[\]]/g, "").replace(/[\r\n]/g, " ").trim();
  if (title.length > 0 && !isGenericTitle(title)) return title;
  return video.id ? "YouTube video" : "video";
}

/** CommonMark's angle-bracket destination when a path has spaces or parentheses. */
export function destination(source: string | null | undefined): string {
  const text = source ?? "";
  if (text.length === 0 || text.startsWith("<")) return text;
  return /[ \t()<>]/.test(text) ? "<" + text.replace(/>/g, "%3E") + ">" : text;
}

export function unwrap(dest: string | null | undefined): string {
  const text = (dest ?? "").trim();
  return text.length >= 2 && text.startsWith("<") && text.endsWith(">") ? text.slice(1, -1) : text;
}

export function videoMarkdown(video: NoteVideo): string {
  return `![${captionTitle(video)}](${destination(video.source)})`;
}

/** A Markdown image embed alone on its line: `![caption](destination)`. */
export interface EmbedLine {
  caption: string;
  destination: string;
  video: NoteVideo;
  /** Offset of `!` within the line, and the length of the embed. */
  start: number;
  length: number;
}

// The destination may also be a whole Markdown link, `![title]([youtube.com](https://…))`, which
// Obsidian produces when a URL is pasted inside the parentheses with "auto link" behaviour.
const EMBED_LINE = /^(\s*)!\[([^\]\r\n]*)\]\((<[^>\r\n]*>|\[[^\]\r\n]*\]\([^\s()]+\)|[^\s()]+)(?:\s+"[^"\r\n]*")?\)\s*$/;
const NESTED_LINK = /^\[[^\]\r\n]*\]\(([^\s()]+)\)$/;

export function parseEmbedLine(line: string): EmbedLine | null {
  const m = EMBED_LINE.exec(line);
  if (!m) return null;
  const lead = m[1] ?? "";
  const dest = m[3] ?? "";
  const video = parseYouTube(NESTED_LINK.exec(dest)?.[1] ?? unwrap(dest));
  if (!video) return null;
  const caption = m[2] ?? "";
  video.title = caption;
  const embed = line.trimEnd().slice(lead.length);
  return { caption, destination: dest, video, start: lead.length, length: embed.length };
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  /** Caret position after the edit. */
  caret: number;
}

/** Insert Markdown as its own block, adding only the blank lines that are missing around it. */
export function insertBlock(source: string, start: number, length: number, markdown: string): TextEdit {
  start = Math.min(Math.max(start, 0), source.length);
  length = Math.min(Math.max(length, 0), source.length - start);
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const before = source.slice(0, start);
  const after = source.slice(start + length);
  const lead = before.length === 0 || before.endsWith(nl + nl) ? "" : before.endsWith(nl) ? nl : nl + nl;
  const tail = after.startsWith(nl + nl) ? "" : after.startsWith(nl) ? nl : nl + nl;
  const insert = lead + markdown + tail;
  return { from: start, to: start + length, insert, caret: start + insert.length };
}

/**
 * An offline copy in a note: a ```youtube-offline block naming vault files, because a video
 * saved without ffmpeg is two files (video and audio) that one Markdown embed cannot pair.
 */
export interface OfflineBlock {
  title: string;
  video: string | null;
  audio: string | null;
  source: string | null;
}

export const OFFLINE_BLOCK = "youtube-offline";

export function offlineBlock(block: OfflineBlock): string {
  const line = (key: string, value: string | null) => (value ? `${key}: ${value.replace(/[\r\n]/g, " ")}\n` : "");
  return "```" + OFFLINE_BLOCK + "\n" + line("title", block.title) + line("video", block.video) +
    line("audio", block.audio) + line("source", block.source) + "```";
}

export function parseOfflineBlock(text: string): OfflineBlock {
  const block: OfflineBlock = { title: "", video: null, audio: null, source: null };
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(title|video|audio|source)\s*:\s*(.*?)\s*$/i.exec(raw);
    if (!m || !m[2]) continue;
    const key = (m[1] ?? "").toLowerCase() as keyof OfflineBlock;
    // Accept [[wikilinks]] too, in case a block is written by hand.
    block[key] = key === "title" ? m[2] : m[2].replace(/^\[\[(.*?)(\|.*)?\]\]$/, "$1");
  }
  if (block.source && !parseYouTube(block.source)) block.source = null;
  return block;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.floor(seconds % 60), m = Math.floor((seconds / 60) % 60), h = Math.floor(seconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/** A file name safe on Windows, macOS, and Linux, from a video title. */
export function safeFileName(title: string, fallback: string): string {
  // Characters Windows, macOS, Linux, or Obsidian links reject; then a length that keeps the full
  // vault path under Windows' 260-character limit; then no trailing dots or spaces (Windows strips them).
  const clean = (text: string) => text.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
    .slice(0, 80).replace(/[. ]+$/, "").trim();
  let name = clean(title) || clean(fallback) || "video";
  // CON, PRN, AUX, NUL, COM1–9, and LPT1–9 are reserved on Windows even with an extension.
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i.test(name)) name = "_" + name;
  return name;
}
