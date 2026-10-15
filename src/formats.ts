// Pure parsing of yt-dlp output and release metadata, separate from the process and network code
// so it can be tested without Obsidian.

export interface StreamFormat {
  url: string;
  formatId: string;
  ext: string;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
  filesize: number | null;
  filesizeApprox: number | null;
  vcodec: string;
  acodec: string;
  /** yt-dlp's download protocol, e.g. "https" (direct) or "m3u8_native" (HLS). */
  protocol: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface Playback {
  title: string | null;
  video: StreamFormat;
  /** Separate audio stream when the video stream has none. */
  audio: StreamFormat | null;
  height: number;
  /** Every resolution YouTube offers for this video, ascending. */
  heights: number[];
}

export interface DownloadProgress {
  percent: number | null;
  total: string;
  speed: string;
  eta: string;
}

export class YtDlpError extends Error {}

export function parsePlayback(root: Record<string, unknown>): Playback {
  const available = readFormats(root, "formats");
  let selected = readFormats(root, "requested_formats");
  if (selected.length === 0) selected = readFormats(root, "requested_downloads");

  const byHeight = (a: StreamFormat, b: StreamFormat) => (b.height ?? 0) - (a.height ?? 0) || (b.fps ?? 0) - (a.fps ?? 0);
  const byBitrate = (a: StreamFormat, b: StreamFormat) => (b.bitrate ?? 0) - (a.bitrate ?? 0);

  // yt-dlp selects either one muxed format or a video-only and audio-only pair.
  const muxed = selected.filter((f) => f.hasVideo && f.hasAudio).sort(byHeight)[0];
  let video = muxed ?? selected.filter((f) => f.hasVideo).sort(byHeight)[0];
  if (!video) {
    const rootFormat = readFormat(root);
    if (rootFormat?.hasVideo) video = rootFormat;
  }
  if (!video) throw new YtDlpError("No playable video stream was returned by yt-dlp.");

  let audio: StreamFormat | null = null;
  if (!video.hasAudio) {
    audio = selected.filter((f) => !f.hasVideo && f.hasAudio).sort(byBitrate)[0]
      ?? available.filter((f) => !f.hasVideo && f.hasAudio).sort(byBitrate)[0]
      ?? null;
  }

  const height = video.height ?? (typeof root.height === "number" ? root.height : 0);
  if (height <= 0) throw new YtDlpError("yt-dlp returned a video stream without a resolution.");
  const heights = [...new Set([
    ...available.filter((f) => f.hasVideo && (f.height ?? 0) > 0).map((f) => f.height as number),
    height,
  ])].sort((a, b) => a - b);

  return { title: typeof root.title === "string" ? root.title : null, video, audio, height, heights };
}

export function readFormats(root: Record<string, unknown>, property: string): StreamFormat[] {
  const list = root[property];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    const format = readFormat(item);
    return format ? [format] : [];
  });
}

function readFormat(item: unknown): StreamFormat | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if (typeof o.url !== "string") return null;
  try {
    const protocol = new URL(o.url).protocol;
    if (protocol !== "http:" && protocol !== "https:") return null;
  } catch {
    return null;
  }
  const str = (k: string) => (typeof o[k] === "string" ? o[k] : "");
  const num = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k]) ? o[k] : null);
  const vcodec = str("vcodec"), acodec = str("acodec");
  return {
    url: o.url,
    formatId: str("format_id"),
    ext: str("ext"),
    height: num("height"),
    fps: num("fps"),
    bitrate: num("abr") ?? num("tbr"),
    filesize: num("filesize"),
    filesizeApprox: num("filesize_approx"),
    vcodec,
    acodec,
    protocol: str("protocol"),
    hasVideo: vcodec !== "" && vcodec.toLowerCase() !== "none",
    hasAudio: acodec !== "" && acodec.toLowerCase() !== "none",
  };
}

export function parseProgress(text: string): DownloadProgress {
  const [percent = "", total = "", speed = "", eta = ""] = text.split("|").map((part) => part.trim());
  const value = Number.parseFloat(percent.replace("%", ""));
  return { percent: Number.isFinite(value) ? value : null, total, speed, eta };
}

/** One offline-save choice: a video height (with the best separate audio when needed) or audio only. */
export interface OfflineChoice {
  label: string;
  /** Video first, then audio when the video stream has none. */
  formatIds: string[];
  audioOnly: boolean;
  size: number | null;
  estimated: boolean;
}

/**
 * Offline choices from a format list: the best stream per height, paired with the best audio when
 * the stream has none. Pairs are saved as two files and played together, so no ffmpeg is needed.
 */
export function offlineChoices(formats: StreamFormat[], duration: number | null): OfflineChoice[] {
  const sizeOf = (f: StreamFormat) => {
    if (f.filesize) return { size: f.filesize, estimated: false };
    if (f.filesizeApprox) return { size: f.filesizeApprox, estimated: true };
    if (f.bitrate && duration) return { size: (f.bitrate * 1000 / 8) * duration, estimated: true };
    return { size: null, estimated: true };
  };
  const safeId = (f: StreamFormat) => /^[A-Za-z0-9._-]{1,64}$/.test(f.formatId);
  // Chromium plays MP4 (H.264/AV1) and WebM (VP9/Opus); prefer MP4/M4A for wider compatibility.
  const preferMp4 = (f: StreamFormat) => (f.ext === "mp4" || f.ext === "m4a" ? 1 : 0);
  const playable = (f: StreamFormat) => ["mp4", "webm", "m4a"].includes(f.ext) && safeId(f) && !/^(dash|hls|mhtml)/i.test(f.ext);
  const direct = (f: StreamFormat) => f.protocol === "" || /^https?$/.test(f.protocol);
  const audio = formats.filter((f) => f.hasAudio && !f.hasVideo && playable(f))
    .sort((a, b) => Number(direct(b)) - Number(direct(a)) || preferMp4(b) - preferMp4(a) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];

  const bestPerHeight = new Map<number, StreamFormat>();
  for (const f of formats) {
    if (!f.hasVideo || !f.height || !playable(f)) continue;
    if (!f.hasAudio && !audio) continue;
    const current = bestPerHeight.get(f.height);
    // Direct (non-HLS) streams report their size, so they rank above HLS at the same height.
    const score = (x: StreamFormat) => (x.hasAudio ? 0 : 2) + preferMp4(x) + (direct(x) ? 0.5 : 0) + (x.fps ?? 0) / 1000;
    if (!current || score(f) > score(current)) bestPerHeight.set(f.height, f);
  }

  const choices: OfflineChoice[] = [...bestPerHeight.entries()].sort((a, b) => b[0] - a[0]).map(([height, f]) => {
    const separate = !f.hasAudio && audio;
    const v = sizeOf(f);
    const a = separate ? sizeOf(audio) : { size: 0, estimated: false };
    const size = v.size !== null && a.size !== null ? v.size + a.size : null;
    const fps = f.fps && f.fps > 30 ? ` ${Math.round(f.fps)}fps` : "";
    return {
      label: `${height}p${fps} · ${f.ext}${separate ? ` + ${audio.ext} audio` : ""}`,
      formatIds: separate ? [f.formatId, audio.formatId] : [f.formatId],
      audioOnly: false,
      size,
      estimated: v.estimated || a.estimated,
    };
  });
  if (audio) {
    const s = sizeOf(audio);
    choices.push({ label: `Audio only · ${audio.ext}`, formatIds: [audio.formatId], audioOnly: true, size: s.size, estimated: s.estimated });
  }
  return choices;
}
