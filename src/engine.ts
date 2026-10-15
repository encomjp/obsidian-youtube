// What the plugin needs from a stream resolver. Two implementations: the built-in JavaScript engine
// (src/jsengine.ts, no external program) and the user's own yt-dlp (src/ytdlp.ts).

import type { DownloadProgress, Playback, StreamFormat } from "./formats.ts";

export interface SearchResult {
  id: string;
  title: string;
  channel: string;
  duration: number | null;
  views: number | null;
}

export interface VideoFormats {
  title: string | null;
  formats: StreamFormat[];
  duration: number | null;
}

export interface Engine {
  readonly id: "js" | "yt-dlp";
  /** Short human description for the settings page, e.g. "Built-in engine" or "yt-dlp 2026.10.01 at /usr/bin/yt-dlp". */
  describe(): Promise<string>;
  /** Direct stream URLs for in-note playback, capped at `maxHeight` (0 = 720). */
  playback(id: string, maxHeight: number): Promise<Playback>;
  /** Every format, for the offline-save picker. */
  formats(id: string): Promise<VideoFormats>;
  /** One page of search results; `sort: "date"` lists the newest uploads first. */
  search(query: string, options?: { page?: number; pageSize?: number; sort?: "relevance" | "date" }): Promise<SearchResult[]>;
  /** The videos of a playlist or channel URL, a page at a time. */
  listUrl(url: string, options?: { page?: number; pageSize?: number }): Promise<SearchResult[]>;
  /**
   * Download the given format ids into a fresh temporary folder and return the written files in the
   * same order (video first, then audio). Files are named `<id>.f<formatId>.<ext>`. The caller copies
   * them into the vault and removes the folder.
   */
  download(id: string, formatIds: string[], onProgress: (p: DownloadProgress) => void, signal: AbortSignal): Promise<{ files: string[]; folder: string }>;
}
