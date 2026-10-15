// The YouTube panel, after Starnote's media hub: Search · Downloads · Library tabs, with a
// preview player at the top. Opened from the ribbon icon or the "Open YouTube panel" command.

import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { renderCard, renderOfflineCard, type PlayerHost } from "./player.ts";
import type { DownloadItem, DownloadQueue } from "./queue.ts";
import type { SearchResult } from "./engine.ts";
import {
  formatDuration, offlineBlock, parseYouTube, videoMarkdown, watchUrl, type NoteVideo,
} from "./youtube.ts";

export const HUB_VIEW = "youtube-native-hub";
export const YOUTUBE_ICON = "ytn-youtube";

export interface LibraryEntry {
  id: string;
  videoId: string;
  title: string;
  /** Vault paths. */
  video: string | null;
  audio: string | null;
  source: string;
  savedAt: number;
}

export interface HubHost extends PlayerHost {
  queue: DownloadQueue;
  library(): LibraryEntry[];
  /** Insert Markdown into the note last edited; false when no note is open. */
  insertIntoNote(markdown: string): boolean;
  /** Ask for a quality, then queue the download; `insertIntoNote` adds the embed first. */
  queueOffline(video: NoteVideo, options: { insertIntoNote: boolean }): void;
  resourceUrl(vaultPath: string | null): string | null;
  deleteLibraryEntry(id: string): Promise<void>;
  revealInVault(vaultPath: string): void;
  openNote(path: string): void;
  onLibraryChange(listener: () => void): () => void;
}

type Tab = "search" | "downloads" | "library";
type Duration = "any" | "short" | "medium" | "long";

export class HubView extends ItemView {
  private tab: Tab = "search";
  private query = "";
  private sort: "relevance" | "date" = "relevance";
  private duration: Duration = "any";
  private results: SearchResult[] = [];
  private page = 0;
  private mode: "search" | "list" | "single" = "search";
  private searching = false;
  private exhausted = false;
  private searchError: string | null = null;
  private generation = 0;
  private libraryFilter = "";
  private releasePreview: (() => void) | null = null;
  private previewEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private readonly disposers: (() => void)[] = [];

  constructor(leaf: WorkspaceLeaf, private readonly host: HubHost) {
    super(leaf);
  }

  override getViewType() { return HUB_VIEW; }
  override getDisplayText() { return "YouTube"; }
  override getIcon() { return YOUTUBE_ICON; }

  override async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("ytn-hub");
    this.tabsEl = root.createDiv({ cls: "ytn-hub-tabs" });
    this.previewEl = root.createDiv({ cls: "ytn-hub-preview" });
    this.bodyEl = root.createDiv({ cls: "ytn-hub-body" });
    this.disposers.push(this.host.queue.onChange(() => {
      this.renderTabs();
      if (this.tab === "downloads") this.renderBody();
    }));
    this.disposers.push(this.host.onLibraryChange(() => {
      this.renderTabs();
      if (this.tab === "library") this.renderBody();
    }));
    this.render();
  }

  override async onClose() {
    this.closePreview();
    for (const dispose of this.disposers.splice(0)) dispose();
  }

  showTab(tab: Tab) {
    this.tab = tab;
    this.render();
  }

  private render() {
    this.renderTabs();
    this.renderBody();
  }

  private renderTabs() {
    this.tabsEl.empty();
    const active = this.host.queue.activeCount;
    const tabs: [Tab, string, string, number | null][] = [
      ["search", "search", "Search", null],
      ["downloads", "download", "Downloads", active > 0 ? active : null],
      ["library", "library", "Library", this.host.library().length || null],
    ];
    for (const [id, icon, label, count] of tabs) {
      const button = this.tabsEl.createEl("button", { cls: "ytn-hub-tab" + (this.tab === id ? " is-active" : ""), attr: { "aria-label": label } });
      setIcon(button.createSpan({ cls: "ytn-hub-tab-icon" }), icon);
      button.createSpan({ cls: "ytn-hub-tab-label", text: label });
      if (count !== null) button.createSpan({ cls: "ytn-hub-tab-count", text: String(count) });
      button.addEventListener("click", () => this.showTab(id));
    }
  }

  private renderBody() {
    this.bodyEl.empty();
    if (this.tab === "search") this.renderSearch();
    else if (this.tab === "downloads") this.renderDownloads();
    else this.renderLibrary();
  }

  // ---- Preview ----------------------------------------------------------------------------

  private closePreview() {
    this.releasePreview?.();
    this.releasePreview = null;
    this.previewEl?.empty();
  }

  private previewVideo(video: NoteVideo) {
    this.closePreview();
    const bar = this.previewEl.createDiv({ cls: "ytn-hub-preview-bar" });
    const close = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Close preview" } });
    setIcon(close, "x");
    close.addEventListener("click", () => this.closePreview());
    const holder = this.previewEl.createDiv();
    this.releasePreview = renderCard(this.host, holder, { video, sourcePath: "", embed: null, autoplay: true });
    const actions = this.previewEl.createDiv({ cls: "ytn-hub-actions" });
    this.button(actions, "plus", "Insert", () => this.insert(video));
    this.button(actions, "download", "Insert + save offline", () => this.host.queueOffline(video, { insertIntoNote: true }));
    this.button(actions, "hard-drive-download", "Save to library", () => this.host.queueOffline(video, { insertIntoNote: false }));
  }

  private previewEntry(entry: LibraryEntry) {
    this.closePreview();
    const bar = this.previewEl.createDiv({ cls: "ytn-hub-preview-bar" });
    const close = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Close preview" } });
    setIcon(close, "x");
    close.addEventListener("click", () => this.closePreview());
    const holder = this.previewEl.createDiv();
    const videoUrl = this.host.resourceUrl(entry.video), audioUrl = this.host.resourceUrl(entry.audio);
    this.releasePreview = renderOfflineCard(holder, {
      title: entry.title, videoUrl, audioUrl, source: entry.source, label: "in vault",
      problem: !videoUrl && !audioUrl ? "The saved files are no longer in the vault." : undefined,
      autoplay: true,
    });
  }

  private insert(video: NoteVideo) {
    if (this.host.insertIntoNote(videoMarkdown(video))) new Notice(`Inserted “${video.title}”`);
    else new Notice("Open a note to insert into first.");
  }

  // ---- Search -----------------------------------------------------------------------------

  private renderSearch() {
    const form = this.bodyEl.createDiv({ cls: "ytn-hub-search" });
    const input = form.createEl("input", {
      cls: "ytn-hub-input",
      attr: { type: "search", placeholder: "Search YouTube or paste a link", spellcheck: "false" },
    });
    input.value = this.query;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void this.runSearch(input.value, 0); });
    const go = form.createEl("button", { cls: "mod-cta", attr: { "aria-label": "Search" } });
    setIcon(go, "search");
    go.addEventListener("click", () => void this.runSearch(input.value, 0));

    const filters = this.bodyEl.createDiv({ cls: "ytn-hub-filters" });
    const sort = filters.createEl("select", { cls: "dropdown", attr: { "aria-label": "Sort" } });
    for (const [value, label] of [["relevance", "Relevance"], ["date", "Newest"]] as const)
      sort.createEl("option", { value, text: label }).selected = this.sort === value;
    sort.addEventListener("change", () => {
      this.sort = sort.value as "relevance" | "date";
      if (this.query && this.mode === "search") void this.runSearch(this.query, 0);
    });
    const duration = filters.createEl("select", { cls: "dropdown", attr: { "aria-label": "Duration" } });
    for (const [value, label] of [["any", "Any length"], ["short", "Under 4 min"], ["medium", "4–20 min"], ["long", "Over 20 min"]] as const)
      duration.createEl("option", { value, text: label }).selected = this.duration === value;
    duration.addEventListener("change", () => {
      this.duration = duration.value as Duration;
      this.renderBody();
    });

    const list = this.bodyEl.createDiv({ cls: "ytn-hub-results" });
    const shown = this.results.filter((r) => this.matchesDuration(r));
    for (const result of shown) this.renderResult(list, result);
    if (this.searchError) list.createDiv({ cls: "ytn-error ytn-hub-note", text: this.searchError });
    if (this.searching) list.createDiv({ cls: "ytn-loading ytn-hub-note", text: this.page === 0 ? "Searching…" : "Loading more…" });
    else if (this.query && this.results.length > 0 && shown.length === 0)
      list.createDiv({ cls: "ytn-empty ytn-hub-note", text: "No results match the length filter on this page." });
    else if (this.query && this.results.length === 0 && !this.searchError)
      list.createDiv({ cls: "ytn-empty ytn-hub-note", text: "No videos found." });
    else if (!this.query)
      list.createDiv({ cls: "ytn-empty ytn-hub-note", text: "Search YouTube, or paste a video, playlist, or channel link. Drag a result into a note to insert it." });

    if (!this.searching && !this.exhausted && this.results.length > 0 && this.mode !== "single") {
      const more = list.createEl("button", { cls: "ytn-hub-more", text: "Load more" });
      more.addEventListener("click", () => void this.runSearch(this.query, this.page + 1));
    }
    if (this.page === 0 && !this.searching) window.setTimeout(() => { if (!this.query) input.focus(); }, 0);
  }

  private matchesDuration(r: SearchResult): boolean {
    if (this.duration === "any") return true;
    if (r.duration === null) return false;
    if (this.duration === "short") return r.duration < 240;
    if (this.duration === "medium") return r.duration >= 240 && r.duration <= 1200;
    return r.duration > 1200;
  }

  private async runSearch(text: string, page: number) {
    const query = text.trim();
    if (!query) return;
    const mine = ++this.generation;
    this.query = query;
    this.page = page;
    this.searching = true;
    this.searchError = null;
    if (page === 0) {
      this.results = [];
      this.exhausted = false;
    }
    this.renderBody();
    try {
      let found: SearchResult[];
      const single = parseYouTube(query);
      const isUrl = /^https?:\/\//i.test(query) || /^(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(query);
      if (single) {
        this.mode = "single";
        const title = (await this.host.fetchTitle(single.id)) ?? single.id;
        found = [{ id: single.id, title, channel: "", duration: null, views: null }];
      } else if (isUrl) {
        const url = /^https?:\/\//i.test(query) ? query : "https://" + query;
        if (!/^https:\/\/((www|m|music)\.)?youtube\.com\//i.test(url))
          throw new Error("Only YouTube video, playlist, and channel links can be listed here.");
        this.mode = "list";
        found = await this.host.ytdlp.listUrl(url, { page });
      } else {
        this.mode = "search";
        found = await this.host.ytdlp.search(query, { page, sort: this.sort });
      }
      if (mine !== this.generation) return;
      const known = new Set(this.results.map((r) => r.id));
      this.results.push(...found.filter((r) => !known.has(r.id)));
      if (found.length === 0) this.exhausted = true;
    } catch (error) {
      if (mine !== this.generation) return;
      this.searchError = (error as Error).message;
    } finally {
      if (mine === this.generation) {
        this.searching = false;
        if (this.tab === "search") this.renderBody();
      }
    }
  }

  private renderResult(parent: HTMLElement, result: SearchResult) {
    const video = { ...(parseYouTube(watchUrl(result.id)) as NoteVideo), title: result.title };
    const row = parent.createDiv({ cls: "ytn-hub-result", attr: { draggable: "true" } });
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", videoMarkdown(video));
    });
    const thumb = row.createDiv({ cls: "ytn-hub-thumb" });
    thumb.createEl("img", { attr: { src: `https://i.ytimg.com/vi/${result.id}/mqdefault.jpg`, alt: "", loading: "lazy" } });
    if (result.duration !== null) thumb.createSpan({ cls: "ytn-hub-badge", text: formatDuration(result.duration) });
    setIcon(thumb.createDiv({ cls: "ytn-hub-thumb-play" }), "play");
    thumb.addEventListener("click", () => this.previewVideo(video));

    const text = row.createDiv({ cls: "ytn-hub-result-text" });
    text.createDiv({ cls: "ytn-hub-result-title", text: result.title, attr: { title: result.title } });
    const meta = [result.channel, result.views !== null ? `${compact(result.views)} views` : ""].filter(Boolean).join(" · ");
    if (meta) text.createDiv({ cls: "ytn-hub-result-meta", text: meta });
    const actions = text.createDiv({ cls: "ytn-hub-actions" });
    this.iconButton(actions, "play", "Preview", () => this.previewVideo(video));
    this.iconButton(actions, "plus", "Insert into note", () => this.insert(video));
    this.iconButton(actions, "download", "Insert and save offline", () => this.host.queueOffline(video, { insertIntoNote: true }));
    this.iconButton(actions, "more-horizontal", "More", (event) => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Save to library only").setIcon("hard-drive-download")
        .onClick(() => this.host.queueOffline(video, { insertIntoNote: false })));
      menu.addItem((i) => i.setTitle("Open on YouTube").setIcon("external-link").onClick(() => window.open(video.source)));
      menu.addItem((i) => i.setTitle("Copy link").setIcon("link").onClick(() => void navigator.clipboard.writeText(video.source)));
      menu.addItem((i) => i.setTitle("Copy embed Markdown").setIcon("copy")
        .onClick(() => void navigator.clipboard.writeText(videoMarkdown(video))));
      if (event instanceof MouseEvent) menu.showAtMouseEvent(event);
    });
  }

  // ---- Downloads --------------------------------------------------------------------------

  private renderDownloads() {
    const items = this.host.queue.items;
    const head = this.bodyEl.createDiv({ cls: "ytn-hub-head" });
    head.createSpan({ text: items.length === 0 ? "No downloads yet." : `${this.host.queue.activeCount} active` });
    if (items.some((i) => ["done", "failed", "cancelled"].includes(i.status)))
      this.button(head, "trash", "Clear finished", () => this.host.queue.clearFinished());
    if (items.length === 0) {
      this.bodyEl.createDiv({ cls: "ytn-empty ytn-hub-note", text: "Save a video offline from a search result or a note card, and it shows here with its progress." });
      return;
    }
    const list = this.bodyEl.createDiv({ cls: "ytn-hub-downloads" });
    for (const item of items) this.renderDownload(list, item);
  }

  private renderDownload(parent: HTMLElement, item: DownloadItem) {
    const row = parent.createDiv({ cls: `ytn-hub-download is-${item.status}` });
    row.createDiv({ cls: "ytn-hub-result-title", text: item.title });
    const status = {
      queued: "Waiting", downloading: "Downloading", saving: "Copying into the vault", done: "Saved",
      failed: "Failed", cancelled: "Cancelled",
    }[item.status];
    const progress = item.progress;
    const detail = item.status === "downloading" && progress
      ? [progress.percent !== null ? `${progress.percent.toFixed(0)}%` : "", progress.total && !/N\/?A/.test(progress.total) ? `of ${progress.total}` : "",
        progress.speed && !/N\/?A/.test(progress.speed) ? progress.speed : "", progress.eta && !/N\/?A/.test(progress.eta) ? `ETA ${progress.eta}` : ""]
        .filter(Boolean).join(" · ")
      : item.error ?? "";
    row.createDiv({ cls: "ytn-hub-result-meta", text: [item.label, status, detail].filter(Boolean).join(" · ") });
    if (item.status === "downloading" || item.status === "queued") {
      const bar = row.createEl("progress", { cls: "ytn-download-progress", attr: { max: "100" } });
      if (progress?.percent != null) bar.value = progress.percent;
      else bar.removeAttribute("value");
    }
    const actions = row.createDiv({ cls: "ytn-hub-actions" });
    if (item.status === "queued" || item.status === "downloading") this.iconButton(actions, "x", "Cancel", () => this.host.queue.cancel(item.id));
    if (item.status === "failed" || item.status === "cancelled") this.iconButton(actions, "rotate-ccw", "Retry", () => this.host.queue.retry(item.id));
    if (item.status === "done" && item.saved[0]) this.iconButton(actions, "folder-open", "Show in vault", () => this.host.revealInVault(item.saved[0] ?? ""));
    if (item.notePath) this.iconButton(actions, "file-text", "Open note", () => this.host.openNote(item.notePath ?? ""));
  }

  // ---- Library ----------------------------------------------------------------------------

  private renderLibrary() {
    const entries = this.host.library();
    const filter = this.bodyEl.createEl("input", { cls: "ytn-hub-input ytn-hub-filter", attr: { type: "search", placeholder: "Filter saved videos" } });
    filter.value = this.libraryFilter;
    const list = this.bodyEl.createDiv({ cls: "ytn-hub-results" });
    const draw = () => {
      list.empty();
      const needle = this.libraryFilter.toLowerCase();
      const shown = entries.filter((e) => e.title.toLowerCase().includes(needle)).sort((a, b) => b.savedAt - a.savedAt);
      if (entries.length === 0) list.createDiv({ cls: "ytn-empty ytn-hub-note", text: "Offline copies you save appear here." });
      else if (shown.length === 0) list.createDiv({ cls: "ytn-empty ytn-hub-note", text: "Nothing matches." });
      for (const entry of shown) this.renderEntry(list, entry);
    };
    filter.addEventListener("input", () => { this.libraryFilter = filter.value; draw(); });
    draw();
  }

  private renderEntry(parent: HTMLElement, entry: LibraryEntry) {
    const missing = !this.host.resourceUrl(entry.video) && !this.host.resourceUrl(entry.audio);
    const block = offlineBlock({ title: entry.title, video: entry.video, audio: entry.audio, source: entry.source });
    const row = parent.createDiv({ cls: "ytn-hub-result" + (missing ? " is-missing" : ""), attr: { draggable: "true" } });
    row.addEventListener("dragstart", (event) => event.dataTransfer?.setData("text/plain", block));
    const thumb = row.createDiv({ cls: "ytn-hub-thumb" });
    thumb.createEl("img", { attr: { src: `https://i.ytimg.com/vi/${entry.videoId}/mqdefault.jpg`, alt: "", loading: "lazy" } });
    thumb.createSpan({ cls: "ytn-hub-badge", text: entry.video ? "offline" : "audio" });
    setIcon(thumb.createDiv({ cls: "ytn-hub-thumb-play" }), "play");
    thumb.addEventListener("click", () => this.previewEntry(entry));

    const text = row.createDiv({ cls: "ytn-hub-result-text" });
    text.createDiv({ cls: "ytn-hub-result-title", text: entry.title, attr: { title: entry.title } });
    text.createDiv({ cls: "ytn-hub-result-meta", text: missing ? "Files missing from the vault" : new Date(entry.savedAt).toLocaleDateString() });
    const actions = text.createDiv({ cls: "ytn-hub-actions" });
    this.iconButton(actions, "play", "Play", () => this.previewEntry(entry));
    this.iconButton(actions, "plus", "Insert into note", () => {
      if (this.host.insertIntoNote(block)) new Notice(`Inserted “${entry.title}”`);
      else new Notice("Open a note to insert into first.");
    });
    this.iconButton(actions, "external-link", "Open on YouTube", () => window.open(entry.source));
    this.iconButton(actions, "trash-2", "Delete", () => {
      const menu = new Menu();
      menu.addItem((i) => i.setTitle("Delete the saved files").setIcon("trash-2").setWarning(true)
        .onClick(() => void this.host.deleteLibraryEntry(entry.id)));
      menu.showAtPosition({ x: row.getBoundingClientRect().right - 40, y: row.getBoundingClientRect().top + 30 });
    });
  }

  // ---- Helpers ----------------------------------------------------------------------------

  private button(parent: HTMLElement, icon: string, label: string, run: () => void) {
    const button = parent.createEl("button", { cls: "ytn-hub-button" });
    setIcon(button.createSpan({ cls: "ytn-hub-tab-icon" }), icon);
    button.createSpan({ text: label });
    button.addEventListener("click", (e) => { e.stopPropagation(); run(); });
  }

  private iconButton(parent: HTMLElement, icon: string, label: string, run: (event: Event) => void) {
    const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
    setIcon(button, icon);
    button.addEventListener("click", (e) => { e.stopPropagation(); run(e); });
  }
}

function compact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
