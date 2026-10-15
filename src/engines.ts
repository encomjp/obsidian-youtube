// Picks which engine answers: the built-in one by default, the user's own yt-dlp as an optional
// fallback (or on request). The plugin never installs anything.

import type { Engine, SearchResult, VideoFormats } from "./engine.ts";
import type { DownloadProgress, Playback } from "./formats.ts";

export type EngineChoice = "auto" | "builtin" | "ytdlp";

/** Optional second engine: only used when it is installed. */
export interface Fallback extends Engine {
  available(): Promise<boolean>;
}

export class EngineChain implements Engine {
  readonly id = "js" as const;
  private readonly choice: () => EngineChoice;
  private readonly builtin: Engine;
  private readonly external: Fallback;
  /** Which engine described a video's formats, so its format ids are downloaded by the same engine. */
  private readonly formatOwner = new Map<string, Engine>();

  constructor(choice: () => EngineChoice, builtin: Engine, external: Fallback) {
    this.choice = choice;
    this.builtin = builtin;
    this.external = external;
  }

  async describe(): Promise<string> {
    const c = this.choice();
    if (c === "builtin") return `Built-in engine. ${await this.builtin.describe()}`;
    if (c === "ytdlp") return await this.external.describe();
    const ext = (await this.external.available()) ? ` Fallback: ${await this.external.describe()}` : " No yt-dlp fallback installed.";
    return `Built-in engine.${ext}`;
  }

  /** Engines to try, in order, for the current setting. */
  private async order(): Promise<Engine[]> {
    const c = this.choice();
    if (c === "builtin") return [this.builtin];
    if (c === "ytdlp") return [this.external];
    return (await this.external.available()) ? [this.builtin, this.external] : [this.builtin];
  }

  private async attempt<T>(run: (e: Engine) => Promise<T>, first?: Engine, signal?: AbortSignal): Promise<T> {
    const engines = await this.order();
    if (first) engines.sort((a, b) => Number(b === first) - Number(a === first));
    let error: unknown = null;
    for (const engine of engines) {
      try {
        return await run(engine);
      } catch (e) {
        if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) throw e;
        error ??= e; // report the first engine's explanation, which is the most relevant one
      }
    }
    throw error instanceof Error ? error : new Error("No engine could handle that request.");
  }

  playback(id: string, maxHeight: number): Promise<Playback> {
    return this.attempt((e) => e.playback(id, maxHeight));
  }

  async formats(id: string): Promise<VideoFormats> {
    let owner: Engine | null = null;
    const result = await this.attempt(async (e) => { const r = await e.formats(id); owner = e; return r; });
    if (owner) this.formatOwner.set(id, owner);
    return result;
  }

  search(query: string, options?: { page?: number; pageSize?: number; sort?: "relevance" | "date" }): Promise<SearchResult[]> {
    return this.attempt((e) => e.search(query, options));
  }

  listUrl(url: string, options?: { page?: number; pageSize?: number }): Promise<SearchResult[]> {
    return this.attempt((e) => e.listUrl(url, options));
  }

  download(id: string, formatIds: string[], onProgress: (p: DownloadProgress) => void, signal: AbortSignal): Promise<{ files: string[]; folder: string }> {
    return this.attempt((e) => e.download(id, formatIds, onProgress, signal), this.formatOwner.get(id), signal);
  }
}
