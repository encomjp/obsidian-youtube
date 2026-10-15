import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  addIcon, App, Editor, FileSystemAdapter, MarkdownRenderChild, MarkdownView, Notice, Plugin, PluginSettingTab,
  requestUrl, Setting, TFile, type WorkspaceLeaf, type MarkdownFileInfo, type MarkdownPostProcessorContext,
} from "obsidian";
import { livePreviewExtension } from "./livePreview.ts";
import { HUB_VIEW, HubView, YOUTUBE_ICON, type HubHost, type LibraryEntry } from "./hub.ts";
import { renderCard, renderOfflineCard } from "./player.ts";
import { DownloadQueue, type DownloadItem } from "./queue.ts";
import { FormatPickerModal, InsertVideoModal } from "./ui.ts";
import { removeFolder, YtDlp } from "./ytdlp.ts";
import {
  captionTitle, insertBlock, isGenericTitle, OFFLINE_BLOCK, offlineBlock, parseEmbedLine, parseOfflineBlock, parseYouTube,
  safeFileName, videoFromEmbedSrc, videoMarkdown, watchUrl, type NoteVideo,
} from "./youtube.ts";

interface Settings {
  ytDlpPath: string;
  maxHeight: number;
  thumbnails: boolean;
  autoFillTitles: boolean;
  autoUpdate: boolean;
  proxy: string;
  ribbonAtBottom: boolean;
  library: LibraryEntry[];
}

const DEFAULTS: Settings = {
  ytDlpPath: "",
  maxHeight: 720,
  thumbnails: true,
  autoFillTitles: true,
  autoUpdate: true,
  proxy: "",
  ribbonAtBottom: true,
  library: [],
};

export default class YouTubeNativePlugin extends Plugin implements HubHost {
  override settings: Settings = { ...DEFAULTS };
  ytdlp!: YtDlp;
  private readonly titles = new Map<string, Promise<string | null>>();
  private readonly filling = new Set<string>();
  queue!: DownloadQueue;
  private readonly libraryListeners = new Set<() => void>();

  override async onload() {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
    this.ytdlp = new YtDlp(() => this.settings);
    let installNotice: Notice | null = null;
    this.ytdlp.onInstall = (installing) => {
      if (installing) installNotice = new Notice("Setting up YouTube playback: downloading yt-dlp (first use only)…", 0);
      else installNotice?.hide();
    };

    // Obsidian's Lucide set has no YouTube glyph, so register one (100×100 viewBox).
    addIcon(YOUTUBE_ICON, '<path fill="none" stroke="currentColor" stroke-width="8" stroke-linejoin="round" d="M12 30c1-9 7-14 16-15 15-1 29-1 44 0 9 1 15 6 16 15 1 13 1 27 0 40-1 9-7 14-16 15-15 1-29 1-44 0-9-1-15-6-16-15-1-13-1-27 0-40z"/><path fill="currentColor" d="M41 35v30l26-15z"/>');
    this.queue = new DownloadQueue((item, signal, report) => this.runDownload(item, signal, report), 2);
    this.registerView(HUB_VIEW, (leaf) => new HubView(leaf, this));
    const ribbon = this.addRibbonIcon(YOUTUBE_ICON, "Open YouTube panel", () => void this.openHub());
    ribbon.addClass("ytn-ribbon");
    // A count badge on the ribbon icon while downloads run, as on Starnote's rail.
    this.register(this.queue.onChange(() => {
      const active = this.queue.activeCount;
      if (active > 0) ribbon.setAttr("data-ytn-count", String(active));
      else ribbon.removeAttribute("data-ytn-count");
    }));
    this.app.workspace.onLayoutReady(() => this.placeRibbonIcon(ribbon));

    this.addCommand({ id: "open-panel", name: "Open YouTube panel", callback: () => void this.openHub() });
    this.addCommand({ id: "open-downloads", name: "Show YouTube downloads", callback: () => void this.openHub("downloads") });
    this.addCommand({ id: "open-library", name: "Show saved YouTube videos", callback: () => void this.openHub("library") });

    this.registerEditorExtension(livePreviewExtension(this));
    this.registerMarkdownPostProcessor((el, ctx) => this.processReadingView(el, ctx));
    this.registerMarkdownCodeBlockProcessor(OFFLINE_BLOCK, (source, el, ctx) => this.renderOffline(source, el, ctx));
    this.addSettingTab(new YouTubeSettingTab(this.app, this));

    this.addCommand({
      id: "insert-video",
      name: "Insert YouTube video",
      editorCallback: (editor, view) => {
        new InsertVideoModal(this.app, (video, title) => void this.insertVideo(editor, view, video, title)).open();
      },
    });
    this.addCommand({ id: "search", name: "Search YouTube", callback: () => void this.openHub("search") });
    this.addCommand({
      id: "save-offline",
      name: "Save the YouTube video on this line offline",
      editorCheckCallback: (checking, editor, view) => {
        const line = editor.getLine(editor.getCursor().line);
        const parsed = parseEmbedLine(line);
        if (!parsed) return false;
        if (!checking) {
          const embed = line.slice(parsed.start, parsed.start + parsed.length);
          this.saveOffline(parsed.video, view.file?.path ?? "", embed);
        }
        return true;
      },
    });
    this.addCommand({
      id: "fill-titles",
      name: "Fill in YouTube titles in this note",
      editorCallback: (editor, view) => void this.fillAllTitles(editor, view),
    });
    this.addCommand({
      id: "update-ytdlp",
      name: "Update the managed yt-dlp",
      callback: () => void this.updateYtDlp(),
    });
  }

  override onunload() {
    this.queue.cancelAll();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- PlayerHost -------------------------------------------------------------------------

  fetchTitle(id: string): Promise<string | null> {
    let pending = this.titles.get(id);
    if (!pending) {
      pending = requestUrl({ url: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl(id))}` })
        .then((response) => {
          const title = (response.json as { title?: unknown })?.title;
          return typeof title === "string" && title.trim() ? title.trim() : null;
        })
        .catch(() => null);
      this.titles.set(id, pending);
      void pending.then((title) => { if (title === null) this.titles.delete(id); });
    }
    return pending;
  }

  async fillCaption(sourcePath: string, embed: string, title: string): Promise<void> {
    const file = this.app.vault.getFileByPath(sourcePath);
    const parsed = parseEmbedLine(embed);
    if (!file || !parsed || !isGenericTitle(parsed.caption || "video") || this.filling.has(sourcePath + embed)) return;
    // A pasted nested link (`[youtube.com](…)`) is tidied to the plain URL at the same time.
    const destination = parsed.destination.startsWith("[") ? parsed.video.source : parsed.destination;
    const replacement = `![${captionTitle({ title, id: parsed.video.id })}](${destination})`;
    if (replacement === embed) return;
    this.filling.add(sourcePath + embed);
    try {
      await this.app.vault.process(file, (data) => (data.includes(embed) ? data.replace(embed, replacement) : data));
    } finally {
      this.filling.delete(sourcePath + embed);
    }
  }

  saveOffline(video: NoteVideo, sourcePath: string, embed: string | null): void {
    void this.pickAndQueue(video, sourcePath || null, embed);
  }

  /**
   * Put the ribbon icon in the empty bottom section of the left toolbar, away from Obsidian's own
   * icons at the top. Obsidian rebuilds its icon list when the toolbar changes, so watch for that and
   * move the icon back; if the user hides it from the toolbar menu, take it out of the bottom too.
   */
  private placeRibbonIcon(icon: HTMLElement) {
    const ribbon = icon.closest(".workspace-ribbon");
    const top = ribbon?.querySelector<HTMLElement>(".side-dock-actions");
    const bottom = ribbon?.querySelector<HTMLElement>(".side-dock-settings");
    if (!top || !bottom) return;
    const items = (this.app.workspace as unknown as { leftRibbon?: { items?: { buttonEl?: HTMLElement; hidden?: boolean }[] } })
      .leftRibbon?.items;
    const place = () => {
      const hidden = items?.find((item) => item.buttonEl === icon)?.hidden ?? false;
      if (!this.settings.ribbonAtBottom) {
        if (icon.parentElement === bottom) top.appendChild(icon);
        return;
      }
      if (hidden) {
        if (icon.parentElement === bottom) icon.detach();
      } else if (icon.parentElement !== bottom) {
        bottom.appendChild(icon);
      }
    };
    place();
    const observer = new MutationObserver(() => place());
    observer.observe(top, { childList: true });
    this.register(() => observer.disconnect());
    this.placeRibbon = place;
  }

  /** Re-applies the ribbon position after the setting changes. */
  placeRibbon: (() => void) | null = null;

  // ---- HubHost ----------------------------------------------------------------------------

  library(): LibraryEntry[] {
    return this.settings.library;
  }

  onLibraryChange(listener: () => void): () => void {
    this.libraryListeners.add(listener);
    return () => this.libraryListeners.delete(listener);
  }

  insertIntoNote(markdown: string): boolean {
    const editor = this.lastEditor();
    if (!editor) return false;
    insertIntoEditor(editor.editor, markdown);
    return true;
  }

  queueOffline(video: NoteVideo, options: { insertIntoNote: boolean }): void {
    if (!options.insertIntoNote) {
      void this.pickAndQueue(video, null, null);
      return;
    }
    const target = this.lastEditor();
    if (!target) {
      new Notice("Open a note to insert into first, or use “Save to library”.");
      return;
    }
    // Insert the online embed now; it becomes the offline block when the download finishes.
    const embed = videoMarkdown(video);
    insertIntoEditor(target.editor, embed);
    void this.pickAndQueue(video, target.path, embed);
  }

  resourceUrl(vaultPath: string | null): string | null {
    if (!vaultPath) return null;
    const file = this.app.vault.getFileByPath(vaultPath);
    return file ? this.app.vault.getResourcePath(file) : null;
  }

  async deleteLibraryEntry(id: string): Promise<void> {
    const entry = this.settings.library.find((e) => e.id === id);
    if (!entry) return;
    for (const p of [entry.video, entry.audio]) {
      const file = p ? this.app.vault.getFileByPath(p) : null;
      if (file) await this.app.fileManager.trashFile(file);
    }
    this.settings.library = this.settings.library.filter((e) => e.id !== id);
    await this.saveSettings();
    this.libraryChanged();
    new Notice(`Deleted “${entry.title}”`);
  }

  revealInVault(vaultPath: string): void {
    const file = this.app.vault.getFileByPath(vaultPath);
    if (!file) return;
    const explorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (explorer) {
      void this.app.workspace.revealLeaf(explorer);
      (explorer.view as unknown as { revealInFolder?: (f: TFile) => void }).revealInFolder?.(file);
    }
  }

  openNote(notePath: string): void {
    void this.app.workspace.openLinkText(notePath, "", false);
  }

  private libraryChanged() {
    for (const listener of this.libraryListeners) listener();
  }

  /** The note editor used last, even when the panel has focus. */
  private lastEditor(): { editor: Editor; path: string } | null {
    const leaf = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
    const view = leaf?.view;
    if (view instanceof MarkdownView && view.file) {
      if (view.getMode() === "preview") return null;
      return { editor: view.editor, path: view.file.path };
    }
    return null;
  }

  async openHub(tab?: "search" | "downloads" | "library"): Promise<void> {
    let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(HUB_VIEW)[0] ?? null;
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: HUB_VIEW, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (tab && leaf.view instanceof HubView) leaf.view.showTab(tab);
  }

  // ---- Reading view -----------------------------------------------------------------------

  private processReadingView(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const candidates = Array.from(el.querySelectorAll<HTMLElement>("iframe, img"))
      .filter((node) => videoFromEmbedSrc(node.getAttribute("src")) !== null);
    if (candidates.length === 0) return;

    // The section's Markdown keeps the caption and end time that the rendered iframe loses.
    const section = ctx.getSectionInfo(el);
    const lines = section ? section.text.split("\n").slice(section.lineStart, section.lineEnd + 1) : [];
    const embeds = lines.flatMap((line) => {
      const parsed = parseEmbedLine(line);
      return parsed ? [{ parsed, embed: line.slice(parsed.start, parsed.start + parsed.length) }] : [];
    });

    for (const node of candidates) {
      const fromSrc = videoFromEmbedSrc(node.getAttribute("src"));
      if (!fromSrc) continue;
      const index = embeds.findIndex((e) => e.parsed.video.id === fromSrc.id);
      const match = index >= 0 ? embeds.splice(index, 1)[0] : undefined;
      const video = match?.parsed.video ?? { ...fromSrc, title: node.getAttribute("alt") ?? "" };
      const container = createDiv({ cls: "ytn-embed" });
      const target = node.closest<HTMLElement>(".external-embed, .internal-embed") ?? node;
      target.replaceWith(container);
      const release = renderCard(this, container, { video, sourcePath: ctx.sourcePath, embed: match?.embed ?? null });
      ctx.addChild(new CardChild(container, release));
    }
  }

  private renderOffline(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const block = parseOfflineBlock(source);
    const resolve = (link: string | null) => {
      if (!link) return { url: null, missing: null as string | null };
      const file = this.app.metadataCache.getFirstLinkpathDest(link, ctx.sourcePath) ?? this.app.vault.getFileByPath(link);
      return file ? { url: this.app.vault.getResourcePath(file), missing: null } : { url: null, missing: link };
    };
    const video = resolve(block.video), audio = resolve(block.audio);
    const missing = [video.missing, audio.missing].filter(Boolean);
    const container = el.createDiv({ cls: "ytn-embed" });
    const release = renderOfflineCard(container, {
      title: block.title || "Offline video",
      videoUrl: video.url,
      audioUrl: audio.url,
      source: block.source,
      label: [block.video && "video", block.audio && "audio"].filter(Boolean).join(" + ") + " · in vault",
      problem: missing.length > 0 ? `Missing in the vault: ${missing.join(", ")}`
        : !video.url && !audio.url ? "This block names no video or audio file." : undefined,
    });
    ctx.addChild(new CardChild(container, release));
  }

  // ---- Commands ---------------------------------------------------------------------------

  private async insertVideo(editor: Editor, view: MarkdownView | MarkdownFileInfo, video: NoteVideo, title: string) {
    let finalTitle = title;
    if (!finalTitle) {
      const notice = new Notice("Fetching the video title…", 0);
      finalTitle = (await this.fetchTitle(video.id)) ?? "";
      notice.hide();
    }
    // The title lookup is async; insert only if the same note's editor is still active.
    if (this.app.workspace.activeEditor?.file !== view.file) return;
    insertIntoEditor(editor, videoMarkdown({ ...video, title: finalTitle }));
  }

  private async fillAllTitles(editor: Editor, view: MarkdownView | MarkdownFileInfo) {
    const sourcePath = view.file?.path;
    if (!sourcePath) return;
    const embeds: string[] = [];
    for (let i = 0; i < editor.lineCount(); i++) {
      const line = editor.getLine(i);
      const parsed = parseEmbedLine(line);
      if (parsed && (!parsed.caption || isGenericTitle(parsed.caption))) embeds.push(line.slice(parsed.start, parsed.start + parsed.length));
    }
    if (embeds.length === 0) {
      new Notice("Every YouTube video in this note already has a title.");
      return;
    }
    let filled = 0;
    for (const embed of embeds) {
      const parsed = parseEmbedLine(embed);
      const title = parsed ? await this.fetchTitle(parsed.video.id) : null;
      if (title) {
        await this.fillCaption(sourcePath, embed, title);
        filled++;
      }
    }
    new Notice(`Filled ${filled} of ${embeds.length} YouTube title${embeds.length === 1 ? "" : "s"}.`);
  }

  private async updateYtDlp() {
    const notice = new Notice("Updating yt-dlp…", 0);
    try {
      const managed = await this.ytdlp.managedExecutable(true);
      const active = await this.ytdlp.executable();
      notice.setMessage(active === managed
        ? `yt-dlp ${await this.ytdlp.version()} is installed.`
        : `The managed yt-dlp was updated, but ${active} is used because it comes first. Clear the setting or PATH copy to use the managed one.`);
    } catch (error) {
      notice.setMessage(`yt-dlp update failed: ${(error as Error).message}`);
    }
    window.setTimeout(() => notice.hide(), 6000);
  }

  /** Ask for a quality, then add the download to the queue and point the user at it. */
  private async pickAndQueue(video: NoteVideo, notePath: string | null, embed: string | null) {
    const title = video.title && !isGenericTitle(video.title) ? video.title : (await this.fetchTitle(video.id)) ?? video.id;
    new FormatPickerModal(this.app, this.ytdlp, video, title, (choice, finalTitle) => {
      this.queue.add({
        videoId: video.id, title: captionTitle({ title: finalTitle, id: video.id }), formatIds: choice.formatIds,
        audioOnly: choice.audioOnly, label: choice.label, notePath, embed,
      });
      new Notice(`Downloading “${finalTitle}”. Progress is in the YouTube panel.`);
    }).open();
  }

  /** The queue's runner: download, copy into the vault, record it, and swap the note's embed. */
  private async runDownload(item: DownloadItem, signal: AbortSignal,
    report: (progress: import("./formats.ts").DownloadProgress | null, saving?: boolean) => void): Promise<string[]> {
    const { files, folder } = await this.ytdlp.download(item.videoId, item.formatIds, (p) => report(p), signal);
    try {
      if (signal.aborted) throw new Error("cancelled");
      report(null, true);
      const sourcePath = item.notePath ?? this.app.workspace.getActiveFile()?.path ?? "";
      const saved: TFile[] = [];
      for (const file of files) saved.push(await this.copyIntoVault(file, item.title, item.videoId, sourcePath));
      const videoFile = item.audioOnly ? null : saved[0] ?? null;
      const audioFile = item.audioOnly ? saved[0] ?? null : saved[1] ?? null;
      const source = watchUrl(item.videoId);
      const entry: LibraryEntry = {
        id: `${item.videoId}-${Date.now()}`, videoId: item.videoId, title: item.title,
        video: videoFile?.path ?? null, audio: audioFile?.path ?? null, source, savedAt: Date.now(),
      };
      this.settings.library.push(entry);
      await this.saveSettings();
      this.libraryChanged();

      const note = item.notePath ? this.app.vault.getFileByPath(item.notePath) : null;
      const embed = item.embed;
      if (note && embed) {
        const block = offlineBlock({ title: entry.title, video: entry.video, audio: entry.audio, source });
        await this.app.vault.process(note, (data) => (data.includes(embed) ? data.replace(embed, block) : data));
      }
      new Notice(`Saved “${item.title}” offline.`);
      return saved.map((f) => f.path);
    } finally {
      await removeFolder(folder);
    }
  }

  /** Copy a downloaded file into the attachment folder and wait for the vault to index it. */
  private async copyIntoVault(file: string, title: string, id: string, sourcePath: string): Promise<TFile> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("Offline copies need a vault on the local file system.");
    const format = /\.(f[A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/.exec(path.basename(file))?.[1];
    const name = safeFileName(title, id) + (format ? "." + format : "") + path.extname(file).toLowerCase();
    const vaultPath = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
    const absolute = adapter.getFullPath(vaultPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });

    const indexed = new Promise<TFile | null>((resolve) => {
      const ref = this.app.vault.on("create", (created) => {
        if (created.path === vaultPath && created instanceof TFile) {
          this.app.vault.offref(ref);
          resolve(created);
        }
      });
      window.setTimeout(() => { this.app.vault.offref(ref); resolve(null); }, 15_000);
    });
    await fs.copyFile(file, absolute);
    const found = this.app.vault.getFileByPath(vaultPath) ?? (await indexed);
    if (!found) throw new Error(`Saved ${vaultPath}, but Obsidian has not indexed it yet. Embed it manually.`);
    return found;
  }

}

class CardChild extends MarkdownRenderChild {
  constructor(container: HTMLElement, private readonly release: () => void) {
    super(container);
  }

  override onunload() {
    this.release();
  }
}

/** Insert Markdown as its own block at the selection, as Starnote's InsertBlock does. */
function insertIntoEditor(editor: Editor, markdown: string) {
  const text = editor.getValue();
  const from = editor.posToOffset(editor.getCursor("from"));
  const to = editor.posToOffset(editor.getCursor("to"));
  const edit = insertBlock(text, from, to - from, markdown);
  editor.replaceRange(edit.insert, editor.offsetToPos(edit.from), editor.offsetToPos(edit.to));
  editor.setCursor(editor.offsetToPos(edit.caret));
}

class YouTubeSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: YouTubeNativePlugin) {
    super(app, plugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();

    new Setting(containerEl).setName("Playback").setHeading();
    new Setting(containerEl).setName("Default quality")
      .setDesc("The highest resolution a note player starts with. You can change it on each player.")
      .addDropdown((d) => {
        for (const h of [360, 480, 720, 1080, 1440, 2160]) d.addOption(String(h), `${h}p`);
        d.setValue(String(s.maxHeight)).onChange((v) => { s.maxHeight = Number(v); save(); });
      });
    new Setting(containerEl).setName("Show thumbnails")
      .setDesc("Load the video's thumbnail from YouTube before you press play.")
      .addToggle((t) => t.setValue(s.thumbnails).onChange((v) => { s.thumbnails = v; save(); }));
    new Setting(containerEl).setName("Fill in placeholder titles")
      .setDesc("Replace captions such as \"video\" or \"YouTube video\" with the real title when a player is shown.")
      .addToggle((t) => t.setValue(s.autoFillTitles).onChange((v) => { s.autoFillTitles = v; save(); }));

    new Setting(containerEl).setName("Toolbar icon at the bottom")
      .setDesc("Show the YouTube icon at the bottom of the left toolbar instead of among the icons at the top.")
      .addToggle((t) => t.setValue(s.ribbonAtBottom).onChange((v) => { s.ribbonAtBottom = v; save(); this.plugin.placeRibbon?.(); }));

    new Setting(containerEl).setName("Tools").setHeading();
    new Setting(containerEl).setName("yt-dlp path")
      .setDesc("Optional. Leave blank to let the plugin download and update its own copy from the official release (verified with SHA-256).")
      .addText((t) => t.setPlaceholder("/usr/bin/yt-dlp").setValue(s.ytDlpPath).onChange((v) => { s.ytDlpPath = v.trim(); save(); }));
    new Setting(containerEl).setName("Proxy")
      .setDesc("Optional. Only if your network requires a proxy for programs, e.g. http://proxy.company.local:8080. " +
        "HTTPS inspection by a work firewall is handled automatically through the system certificate store.")
      .addText((t) => t.setPlaceholder("http://host:port").setValue(s.proxy).onChange((v) => { s.proxy = v.trim(); save(); }));
    new Setting(containerEl).setName("Keep yt-dlp updated")
      .setDesc("Check for a newer official release every 14 days.")
      .addToggle((t) => t.setValue(s.autoUpdate).onChange((v) => { s.autoUpdate = v; save(); }));

    const status = new Setting(containerEl).setName("yt-dlp status").setDesc("Not checked.");
    status.addButton((b) => b.setButtonText("Check").onClick(async () => {
      status.setDesc("Checking…");
      try {
        const exe = await this.plugin.ytdlp.executable();
        status.setDesc(`${await this.plugin.ytdlp.version()} at ${exe}`);
      } catch (error) {
        status.setDesc((error as Error).message);
      }
    }));
  }
}
