// The download queue behind the panel's Downloads tab, after Starnote's DownloadQueue: items move
// through queued → downloading → saving → done / failed / cancelled, at most `parallel` at once,
// with retry. Pure logic: the runner that actually downloads is injected, so it is testable.

import type { DownloadProgress } from "./formats.ts";

export type DownloadStatus = "queued" | "downloading" | "saving" | "done" | "failed" | "cancelled";

export interface DownloadRequest {
  videoId: string;
  title: string;
  /** Video first, then audio; or one id. */
  formatIds: string[];
  audioOnly: boolean;
  label: string;
  /** Note that asked for the copy, and the exact embed text to replace there, if any. */
  notePath: string | null;
  embed: string | null;
}

export interface DownloadItem extends DownloadRequest {
  id: number;
  status: DownloadStatus;
  progress: DownloadProgress | null;
  error: string | null;
  /** Vault paths written, once done. */
  saved: string[];
}

/** Downloads one item; must reject when `signal` aborts. Reports progress, then the "saving" phase. */
export type DownloadRunner = (item: DownloadItem, signal: AbortSignal,
  report: (progress: DownloadProgress | null, saving?: boolean) => void) => Promise<string[]>;

export class DownloadQueue {
  readonly items: DownloadItem[] = [];
  private nextId = 1;
  private readonly running = new Map<number, AbortController>();
  private readonly listeners = new Set<() => void>();

  private readonly runner: DownloadRunner;
  private readonly parallel: number;

  constructor(runner: DownloadRunner, parallel = 2) {
    this.runner = runner;
    this.parallel = parallel;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Items still waiting or running. */
  get activeCount(): number {
    return this.items.filter((i) => i.status === "queued" || i.status === "downloading" || i.status === "saving").length;
  }

  add(request: DownloadRequest): DownloadItem {
    const item: DownloadItem = { ...request, id: this.nextId++, status: "queued", progress: null, error: null, saved: [] };
    this.items.unshift(item);
    this.changed();
    this.pump();
    return item;
  }

  cancel(id: number) {
    const item = this.find(id);
    if (!item) return;
    if (item.status === "queued") {
      item.status = "cancelled";
      this.changed();
    } else {
      this.running.get(id)?.abort();
    }
  }

  retry(id: number) {
    const item = this.find(id);
    if (!item || (item.status !== "failed" && item.status !== "cancelled")) return;
    item.status = "queued";
    item.error = null;
    item.progress = null;
    this.changed();
    this.pump();
  }

  /** Drop finished, failed and cancelled items from the list. */
  clearFinished() {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const status = this.items[i]?.status;
      if (status === "done" || status === "failed" || status === "cancelled") this.items.splice(i, 1);
    }
    this.changed();
  }

  cancelAll() {
    for (const item of this.items) if (item.status === "queued") item.status = "cancelled";
    for (const controller of this.running.values()) controller.abort();
    this.changed();
  }

  private find(id: number) {
    return this.items.find((i) => i.id === id);
  }

  private pump() {
    while (this.running.size < this.parallel) {
      // Oldest queued first; new items are unshifted, so search from the end.
      const next = [...this.items].reverse().find((i) => i.status === "queued");
      if (!next) return;
      void this.start(next);
    }
  }

  private async start(item: DownloadItem) {
    const controller = new AbortController();
    this.running.set(item.id, controller);
    item.status = "downloading";
    this.changed();
    try {
      item.saved = await this.runner(item, controller.signal, (progress, saving) => {
        if (controller.signal.aborted) return;
        item.progress = progress;
        if (saving) item.status = "saving";
        this.changed();
      });
      item.status = controller.signal.aborted ? "cancelled" : "done";
    } catch (error) {
      item.status = controller.signal.aborted ? "cancelled" : "failed";
      item.error = controller.signal.aborted ? null : (error as Error).message;
    } finally {
      this.running.delete(item.id);
      this.changed();
      this.pump();
    }
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }
}
