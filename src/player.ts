// The in-note player. Like Starnote, it loads on click and plays the direct streams yt-dlp resolves
// (no YouTube iframe, so no ads or embed error 153), with its own controls: a seek bar with buffered
// progress and the note's start/end range, volume, speed, quality, picture-in-picture, fullscreen,
// and Starnote's keyboard shortcuts. The same player plays offline copies from the vault.

import { setIcon } from "obsidian";
import type { YtDlp } from "./ytdlp.ts";
import { captionTitle, formatDuration, isGenericTitle, watchUrl, type NoteVideo } from "./youtube.ts";

export interface PlayerHost {
  ytdlp: YtDlp;
  settings: { maxHeight: number; thumbnails: boolean; autoFillTitles: boolean };
  /** The real title from YouTube's oEmbed endpoint, or null. */
  fetchTitle(id: string): Promise<string | null>;
  /** Replace a generic caption in the note with the real title. */
  fillCaption(sourcePath: string, embed: string, title: string): Promise<void>;
  saveOffline(video: NoteVideo, sourcePath: string, embed: string | null): void;
}

export interface CardOptions {
  video: NoteVideo;
  sourcePath: string;
  /** The exact `![caption](destination)` text in the note, when known. */
  embed: string | null;
  /** Live Preview: move the caret onto the Markdown so it can be edited. */
  onEditSource?: () => void;
  /** Start playing at once (the panel's preview). */
  autoplay?: boolean;
}

/** What the player plays: one muxed stream, or video plus separate audio. */
interface Streams {
  videoUrl: string | null;
  audioUrl: string | null;
  /** Quality menu; empty for offline copies. */
  heights: number[];
  height: number | null;
}

interface Range {
  start: number;
  end: number | null;
}

/** Render a YouTube player into `container`; the returned function releases playback resources. */
export function renderCard(host: PlayerHost, container: HTMLElement, options: CardOptions): () => void {
  const { video } = options;
  const watch = watchUrl(video.id, video.startSeconds, video.endSeconds);
  const shell = new Shell(container, captionTitle(video), rangeLabel(video));
  shell.action("external-link", "Open on YouTube", () => window.open(watch));
  shell.action("download", "Save offline copy", () => host.saveOffline(video, options.sourcePath, options.embed));
  if (options.onEditSource) shell.action("code", "Edit Markdown", options.onEditSource);
  if (host.settings.thumbnails) shell.thumbnail(video.id);

  let player: Player | null = null;
  let disposed = false;
  const range = { start: video.startSeconds, end: video.endSeconds };

  // Name placeholder captions, as Starnote does, so older notes fix themselves.
  if (!video.title || isGenericTitle(video.title)) {
    void host.fetchTitle(video.id).then((title) => {
      if (!title || disposed) return;
      shell.setTitle(title);
      if (host.settings.autoFillTitles && options.embed) void host.fillCaption(options.sourcePath, options.embed, title);
    });
  }

  const resolve = async (maxHeight: number): Promise<Streams | null> => {
    try {
      const playback = await host.ytdlp.playback(video.id, maxHeight);
      if (disposed) return null;
      if (playback.title && (!video.title || isGenericTitle(video.title))) shell.setTitle(playback.title);
      return { videoUrl: playback.video.url, audioUrl: playback.audio?.url ?? null, heights: playback.heights, height: playback.height };
    } catch (error) {
      if (!disposed) shell.showError(`Could not play this video in the note. ${(error as Error).message}`, () => void start(), watch);
      return null;
    }
  };

  const start = async () => {
    player?.dispose();
    player = null;
    shell.setState("loading");
    const streams = await resolve(host.settings.maxHeight);
    if (!streams || disposed) return;
    player = new Player(shell, range, streams, {
      onQuality: async (height) => {
        const next = await resolve(height);
        if (next && player) player.swap(next);
      },
      onError: () => shell.showError("The stream stopped loading. Stream links expire after a few hours; retry to get fresh ones.",
        () => void start(), watch),
    });
  };

  shell.onPlay(() => void start());
  if (options.autoplay) void start();
  return () => {
    disposed = true;
    player?.dispose();
    player = null;
    shell.dispose();
  };
}

export interface OfflineCardOptions {
  title: string;
  videoUrl: string | null;
  audioUrl: string | null;
  /** Watch URL the copy was saved from. */
  source: string | null;
  label: string;
  /** Message shown instead of the player, such as a missing file. */
  problem?: string;
  autoplay?: boolean;
}

/** Render an offline copy: local video and audio files played together. */
export function renderOfflineCard(container: HTMLElement, options: OfflineCardOptions): () => void {
  const shell = new Shell(container, options.title, "offline");
  if (options.source) {
    const source = options.source;
    shell.action("external-link", "Open on YouTube", () => window.open(source));
    const id = /[?&]v=([A-Za-z0-9_-]{11})/.exec(source)?.[1];
    if (id) shell.thumbnail(id);
  }
  if (options.problem) {
    shell.showError(options.problem, null, options.source);
    return () => shell.dispose();
  }
  let player: Player | null = null;
  const start = () => {
    player?.dispose();
    player = new Player(shell, { start: 0, end: null },
      { videoUrl: options.videoUrl, audioUrl: options.audioUrl, heights: [], height: null }, {
        onQuality: async () => undefined,
        onError: () => shell.showError("This offline copy could not be played.", null, options.source),
      });
  };
  shell.onPlay(start);
  if (options.autoplay) start();
  return () => {
    player?.dispose();
    shell.dispose();
  };
}

function rangeLabel(video: NoteVideo): string {
  if (video.startSeconds <= 0 && video.endSeconds === null) return "";
  const start = formatDuration(video.startSeconds);
  return video.endSeconds !== null ? `${start}–${formatDuration(video.endSeconds)}` : `from ${start}`;
}

type State = "idle" | "loading" | "playing" | "paused" | "error";

const swallow = (event: Event) => { event.preventDefault(); event.stopPropagation(); };

function iconButton(parent: HTMLElement, cls: string, icon: string, label: string, run: (event: MouseEvent) => void) {
  const button = parent.createEl("button", { cls: `ytn-btn ${cls}`, attr: { "aria-label": label, type: "button" } });
  setIcon(button, icon);
  button.addEventListener("click", (event) => { swallow(event); run(event); });
  return button;
}

/** The card's frame: poster, title overlay, big play button, spinner, error panel. */
class Shell {
  readonly card: HTMLElement;
  readonly stage: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly poster: HTMLElement;
  private readonly message: HTMLElement;
  private playHandler: (() => void) | null = null;

  constructor(container: HTMLElement, title: string, badge: string) {
    this.card = container.createDiv({ cls: "ytn-card is-idle", attr: { tabindex: "0" } });
    this.stage = this.card.createDiv({ cls: "ytn-stage" });
    this.poster = this.stage.createDiv({ cls: "ytn-poster" });
    const top = this.stage.createDiv({ cls: "ytn-top" });
    const heading = top.createDiv({ cls: "ytn-heading" });
    this.titleEl = heading.createDiv({ cls: "ytn-title", text: title, attr: { title } });
    if (badge) heading.createSpan({ cls: "ytn-range", text: badge });
    this.actions = top.createDiv({ cls: "ytn-actions" });

    const big = this.stage.createEl("button", { cls: "ytn-bigplay", attr: { "aria-label": "Play video", type: "button" } });
    setIcon(big, "play");
    this.stage.createDiv({ cls: "ytn-spinner" });
    this.message = this.stage.createDiv({ cls: "ytn-message" });

    const play = (event: Event) => {
      if (!this.card.hasClass("is-idle") && !this.card.hasClass("is-error")) return;
      swallow(event);
      this.playHandler?.();
    };
    big.addEventListener("click", play);
    this.poster.addEventListener("click", play);
  }

  onPlay(handler: () => void) {
    this.playHandler = handler;
  }

  setTitle(title: string) {
    this.titleEl.setText(title);
    this.titleEl.setAttr("title", title);
  }

  action(icon: string, label: string, run: () => void) {
    iconButton(this.actions, "ytn-action", icon, label, run);
  }

  thumbnail(id: string) {
    // maxresdefault is sharp and 16:9 but missing for some videos (YouTube then serves a 120×90
    // placeholder), so fall back to hqdefault, cropped to 16:9.
    const img = this.poster.createEl("img", { attr: { alt: "", loading: "lazy", decoding: "async" } });
    img.addEventListener("load", () => {
      if (img.naturalWidth <= 120 && !img.src.includes("hqdefault")) img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    });
    img.addEventListener("error", () => {
      if (!img.src.includes("hqdefault")) img.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    });
    img.src = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  }

  setState(state: State) {
    for (const s of ["idle", "loading", "playing", "paused", "error"]) this.card.toggleClass(`is-${s}`, s === state);
    if (state !== "error") this.message.empty();
  }

  showError(text: string, retry: (() => void) | null, watch: string | null) {
    this.stage.querySelectorAll("video, audio, .ytn-controls, .ytn-menu").forEach((el) => el.remove());
    this.setState("error");
    this.message.empty();
    this.message.createDiv({ cls: "ytn-message-text", text });
    const buttons = this.message.createDiv({ cls: "ytn-message-buttons" });
    if (retry) buttons.createEl("button", { text: "Retry" }).addEventListener("click", (e) => { swallow(e); retry(); });
    if (watch) buttons.createEl("button", { text: "Open on YouTube", cls: "mod-cta" })
      .addEventListener("click", (e) => { swallow(e); window.open(watch); });
  }

  dispose() {
    this.playHandler = null;
  }
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function loadNumber(key: string, fallback: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return window.localStorage.getItem(key) !== null && Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveValue(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable; the setting just isn't remembered
  }
}

/**
 * The playing state: a `<video>` (or `<audio>` for audio-only copies), a separate `<audio>` kept in
 * step when the streams are split, and the overlay controls.
 */
class Player {
  private main!: HTMLMediaElement;
  private companion: HTMLAudioElement | null = null;
  private readonly controls: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly bufferBar: HTMLElement;
  private readonly playedBar: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly playBtn: HTMLElement;
  private readonly muteBtn: HTMLElement;
  private readonly volume: HTMLInputElement;
  private readonly fullBtn: HTMLElement;
  private menu: HTMLElement | null = null;
  private hideTimer = 0;
  private scrubbing = false;
  private streams: Streams;
  private readonly cleanups: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly shell: Shell, private readonly range: Range, streams: Streams,
    private readonly events: { onQuality: (height: number) => Promise<void>; onError: () => void }) {
    this.streams = streams;
    const stage = shell.stage;
    shell.setState("loading");
    this.mountMedia(streams, range.start, true);

    // ---- Controls ----
    this.controls = stage.createDiv({ cls: "ytn-controls" });
    this.progress = this.controls.createDiv({ cls: "ytn-progress", attr: { role: "slider", "aria-label": "Seek", tabindex: "-1" } });
    const track = this.progress.createDiv({ cls: "ytn-track" });
    if (range.start > 0 || range.end !== null) track.createDiv({ cls: "ytn-track-range" });
    this.bufferBar = track.createDiv({ cls: "ytn-track-buffer" });
    this.playedBar = track.createDiv({ cls: "ytn-track-played" });
    this.handle = this.progress.createDiv({ cls: "ytn-handle" });
    this.tip = this.progress.createDiv({ cls: "ytn-tip" });

    const row = this.controls.createDiv({ cls: "ytn-row" });
    this.playBtn = iconButton(row, "", "play", "Play (k)", () => this.toggle());
    const volumeBox = row.createDiv({ cls: "ytn-volume" });
    this.muteBtn = iconButton(volumeBox, "", "volume-2", "Mute (m)", () => this.toggleMute());
    this.volume = volumeBox.createEl("input", { cls: "ytn-volume-slider", attr: { type: "range", min: "0", max: "1", step: "0.05", "aria-label": "Volume" } });
    this.timeEl = row.createSpan({ cls: "ytn-time" });
    row.createDiv({ cls: "ytn-spacer" });
    iconButton(row, "ytn-settings", "settings", "Speed and quality", () => this.toggleMenu());
    if (document.pictureInPictureEnabled && streams.videoUrl)
      iconButton(row, "", "picture-in-picture-2", "Picture in picture (p)", () => void this.togglePip());
    this.fullBtn = iconButton(row, "", "maximize", "Fullscreen (f)", () => void this.toggleFullscreen());

    this.wireControls();
    this.applyVolume(loadNumber("ytn-volume", 1), loadNumber("ytn-muted", 0) === 1);
    this.updateTime();
  }

  /** Create the media elements for `streams`, starting at `time`. */
  private mountMedia(streams: Streams, time: number, play: boolean) {
    const stage = this.shell.stage;
    const before = stage.querySelector(".ytn-spinner");
    if (streams.videoUrl) {
      this.main = createEl("video", { cls: "ytn-video", attr: { playsinline: "", preload: "auto" } });
      this.main.src = streams.videoUrl;
      if (streams.audioUrl) {
        this.companion = createEl("audio", { attr: { preload: "auto" } });
        this.companion.src = streams.audioUrl;
      } else {
        this.companion = null;
      }
    } else {
      this.main = createEl("audio", { cls: "ytn-video ytn-audio-only", attr: { preload: "auto" } });
      this.main.src = streams.audioUrl ?? "";
      this.companion = null;
      this.shell.card.addClass("is-audio-only");
    }
    stage.insertBefore(this.main, before);
    if (this.companion) stage.insertBefore(this.companion, before);
    this.wireMedia(time, play);
  }

  /** Change quality: new streams, same position, same play state, same fullscreen. */
  swap(streams: Streams) {
    const time = this.main.currentTime, playing = !this.main.paused;
    const old = [this.main, this.companion];
    this.streams = streams;
    this.mountMedia(streams, time, playing);
    for (const el of old) if (el) { el.pause(); el.removeAttribute("src"); el.load(); el.remove(); }
    this.closeMenu();
  }

  private wireMedia(startAt: number, autoplay: boolean) {
    const v = this.main, a = this.companion;
    v.addEventListener("loadedmetadata", () => {
      v.currentTime = startAt;
      this.sync(true);
      this.updateTime();
      if (autoplay) void v.play().catch(() => this.shell.setState("paused"));
      else this.shell.setState("paused");
    }, { once: true });
    v.addEventListener("play", () => {
      this.shell.setState("playing");
      setIcon(this.playBtn, "pause");
      this.playBtn.setAttr("aria-label", "Pause (k)");
      this.sync(true);
      if (a) void a.play().catch(() => undefined);
      this.scheduleHide();
    });
    v.addEventListener("pause", () => {
      if (!this.shell.card.hasClass("is-error")) this.shell.setState("paused");
      setIcon(this.playBtn, "play");
      this.playBtn.setAttr("aria-label", "Play (k)");
      a?.pause();
      this.showControls();
    });
    v.addEventListener("waiting", () => { this.shell.card.addClass("is-buffering"); a?.pause(); });
    v.addEventListener("playing", () => {
      this.shell.card.removeClass("is-buffering");
      this.sync(true);
      if (a && !v.paused) void a.play().catch(() => undefined);
    });
    v.addEventListener("canplay", () => this.shell.card.removeClass("is-buffering"));
    v.addEventListener("timeupdate", () => {
      if (this.range.end !== null && v.currentTime >= this.range.end && !v.paused) v.pause();
      this.sync(false);
      this.updateTime();
    });
    v.addEventListener("progress", () => this.updateTime());
    v.addEventListener("seeked", () => this.sync(true));
    v.addEventListener("ended", () => { a?.pause(); this.showControls(); });
    v.addEventListener("ratechange", () => { if (a) a.playbackRate = v.playbackRate; });
    v.addEventListener("error", () => { if (!this.disposed) this.events.onError(); });
    a?.addEventListener("error", () => { if (!this.disposed) this.events.onError(); });
    v.addEventListener("click", (e) => { swallow(e); if (this.menu) this.closeMenu(); else this.toggle(); });
    v.addEventListener("dblclick", (e) => { swallow(e); void this.toggleFullscreen(); });
  }

  private wireControls() {
    const card = this.shell.card;
    const listen = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Document, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      el.addEventListener(type, fn as EventListener);
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener));
    };

    listen(card, "mousemove", () => this.showControls());
    listen(card, "mouseleave", () => { if (!this.main.paused) this.hideControls(); });
    listen(card, "keydown", (e) => this.onKey(e));
    this.controls.addEventListener("click", (e) => e.stopPropagation());

    this.volume.addEventListener("input", () => this.applyVolume(Number(this.volume.value), false));

    // Seek bar: hover shows the time, drag scrubs.
    const timeAt = (clientX: number) => {
      const rect = this.progress.getBoundingClientRect();
      const fraction = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
      return { fraction, time: fraction * (this.duration() || 0) };
    };
    this.progress.addEventListener("mousemove", (e) => {
      const { fraction, time } = timeAt(e.clientX);
      this.tip.setText(formatDuration(time));
      this.tip.style.left = `${fraction * 100}%`;
    });
    this.progress.addEventListener("pointerdown", (e) => {
      swallow(e);
      this.scrubbing = true;
      this.progress.setPointerCapture(e.pointerId);
      this.progress.addClass("is-scrubbing");
      this.seekTo(timeAt(e.clientX).time);
    });
    this.progress.addEventListener("pointermove", (e) => { if (this.scrubbing) this.seekTo(timeAt(e.clientX).time); });
    const endScrub = (e: PointerEvent) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      this.progress.removeClass("is-scrubbing");
      this.progress.releasePointerCapture(e.pointerId);
    };
    this.progress.addEventListener("pointerup", endScrub);
    this.progress.addEventListener("pointercancel", endScrub);

    listen(document, "fullscreenchange", () => {
      const full = document.fullscreenElement === card;
      card.toggleClass("is-fullscreen", full);
      setIcon(this.fullBtn, full ? "minimize" : "maximize");
      this.fullBtn.setAttr("aria-label", full ? "Exit fullscreen (f)" : "Fullscreen (f)");
    });
  }

  /** Starnote's player keys. */
  private onKey(e: KeyboardEvent) {
    if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.tagName === "INPUT") return;
    const v = this.main;
    const handled = () => { swallow(e); this.showControls(); };
    switch (e.key) {
      case " ": case "k": case "K": this.toggle(); handled(); break;
      case "ArrowLeft": this.seekBy(-5); handled(); break;
      case "ArrowRight": this.seekBy(5); handled(); break;
      case "j": case "J": this.seekBy(-10); handled(); break;
      case "l": case "L": this.seekBy(10); handled(); break;
      case "ArrowUp": this.applyVolume(Math.min(this.currentVolume() + 0.05, 1), false); handled(); break;
      case "ArrowDown": this.applyVolume(Math.max(this.currentVolume() - 0.05, 0), false); handled(); break;
      case "m": case "M": this.toggleMute(); handled(); break;
      case "f": case "F": void this.toggleFullscreen(); handled(); break;
      case "p": case "P": void this.togglePip(); handled(); break;
      case "<": this.setSpeed(Math.max(v.playbackRate - 0.25, 0.25)); handled(); break;
      case ">": this.setSpeed(Math.min(v.playbackRate + 0.25, 3)); handled(); break;
      case ",": if (v.paused) { this.seekBy(-1 / 30); handled(); } break;
      case ".": if (v.paused) { this.seekBy(1 / 30); handled(); } break;
      default:
        if (/^[0-9]$/.test(e.key)) { this.seekTo((Number(e.key) / 10) * this.duration()); handled(); }
    }
  }

  private duration(): number {
    const d = this.main.duration;
    return Number.isFinite(d) ? d : 0;
  }

  private toggle() {
    const v = this.main;
    if (v.paused) {
      if (this.range.end !== null && v.currentTime >= this.range.end - 0.25) v.currentTime = this.range.start;
      void v.play().catch(() => undefined);
    } else {
      v.pause();
    }
  }

  private seekTo(time: number) {
    const d = this.duration();
    this.main.currentTime = Math.min(Math.max(time, 0), d > 0 ? d : time);
    this.sync(true);
    this.updateTime();
  }

  private seekBy(delta: number) {
    this.seekTo(this.main.currentTime + delta);
  }

  private setSpeed(rate: number) {
    this.main.playbackRate = rate;
    if (this.companion) this.companion.playbackRate = rate;
    if (this.menu) this.renderMenu();
  }

  private currentVolume(): number {
    return (this.companion ?? this.main).volume;
  }

  /** Volume lives on whichever element carries the sound. */
  private applyVolume(volume: number, muted: boolean) {
    const sound = this.companion ?? this.main;
    sound.volume = volume;
    sound.muted = muted || volume === 0;
    if (this.companion) this.main.muted = true;
    this.volume.value = String(sound.muted ? 0 : volume);
    setIcon(this.muteBtn, sound.muted ? "volume-x" : volume < 0.5 ? "volume-1" : "volume-2");
    this.muteBtn.setAttr("aria-label", sound.muted ? "Unmute (m)" : "Mute (m)");
    saveValue("ytn-volume", String(volume || loadNumber("ytn-volume", 1)));
    saveValue("ytn-muted", sound.muted ? "1" : "0");
  }

  private toggleMute() {
    const sound = this.companion ?? this.main;
    const volume = sound.volume || loadNumber("ytn-volume", 1) || 1;
    this.applyVolume(volume, !sound.muted);
  }

  private async toggleFullscreen() {
    try {
      if (document.fullscreenElement === this.shell.card) await document.exitFullscreen();
      else await this.shell.card.requestFullscreen();
    } catch {
      // fullscreen refused (e.g. not from a user gesture)
    }
  }

  private async togglePip() {
    if (!(this.main instanceof HTMLVideoElement)) return;
    try {
      if (document.pictureInPictureElement === this.main) await document.exitPictureInPicture();
      else await this.main.requestPictureInPicture();
    } catch {
      // picture-in-picture unavailable
    }
  }

  // ---- Speed and quality menu ----

  private toggleMenu() {
    if (this.menu) this.closeMenu();
    else {
      this.menu = this.shell.stage.createDiv({ cls: "ytn-menu" });
      this.menu.addEventListener("click", (e) => e.stopPropagation());
      this.renderMenu();
    }
  }

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  private renderMenu() {
    const menu = this.menu;
    if (!menu) return;
    menu.empty();
    const section = (label: string) => {
      menu.createDiv({ cls: "ytn-menu-label", text: label });
      return menu.createDiv({ cls: "ytn-menu-options" });
    };
    const speeds = section("Speed");
    for (const rate of SPEEDS) {
      const option = speeds.createEl("button", { cls: "ytn-chip", text: rate === 1 ? "Normal" : `${rate}×`, attr: { type: "button" } });
      option.toggleClass("is-selected", Math.abs(this.main.playbackRate - rate) < 0.01);
      option.addEventListener("click", () => this.setSpeed(rate));
    }
    if (this.streams.heights.length > 0) {
      const qualities = section("Quality");
      for (const height of [...this.streams.heights].reverse()) {
        const option = qualities.createEl("button", { cls: "ytn-chip", text: height >= 2160 ? `${height}p 4K` : height >= 1440 ? `${height}p HD` : `${height}p`, attr: { type: "button" } });
        option.toggleClass("is-selected", height === this.streams.height);
        option.addEventListener("click", () => {
          option.addClass("is-loading");
          void this.events.onQuality(height);
        });
      }
    }
  }

  // ---- Display ----

  private updateTime() {
    const v = this.main, d = this.duration(), t = v.currentTime;
    this.timeEl.setText(d > 0 ? `${formatDuration(t)} / ${formatDuration(d)}` : formatDuration(t));
    const pct = d > 0 ? (t / d) * 100 : 0;
    this.playedBar.style.width = `${pct}%`;
    this.handle.style.left = `${pct}%`;
    let buffered = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.5) buffered = Math.max(buffered, v.buffered.end(i));
    this.bufferBar.style.width = d > 0 ? `${(buffered / d) * 100}%` : "0";
    const rangeEl = this.progress.querySelector<HTMLElement>(".ytn-track-range");
    if (rangeEl && d > 0) {
      const end = this.range.end ?? d;
      rangeEl.style.left = `${(this.range.start / d) * 100}%`;
      rangeEl.style.width = `${((end - this.range.start) / d) * 100}%`;
    }
  }

  private showControls() {
    this.shell.card.removeClass("controls-hidden");
    this.scheduleHide();
  }

  private hideControls() {
    if (this.menu || this.scrubbing) return;
    this.shell.card.addClass("controls-hidden");
  }

  private scheduleHide() {
    window.clearTimeout(this.hideTimer);
    if (this.main.paused) return;
    this.hideTimer = window.setTimeout(() => { if (!this.main.paused) this.hideControls(); }, 2500);
  }

  /** Keep separate audio within a fraction of a second of the picture. */
  private sync(force: boolean) {
    const a = this.companion;
    if (!a) return;
    if (force || Math.abs(a.currentTime - this.main.currentTime) > 0.3) a.currentTime = this.main.currentTime;
  }

  dispose() {
    this.disposed = true;
    window.clearTimeout(this.hideTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    if (document.fullscreenElement === this.shell.card) void document.exitFullscreen().catch(() => undefined);
    for (const el of [this.main, this.companion]) {
      if (!el) continue;
      el.pause();
      el.removeAttribute("src");
      el.load();
      el.remove();
    }
    this.controls.remove();
    this.closeMenu();
    this.shell.card.removeClass("is-audio-only");
    this.shell.card.removeClass("controls-hidden");
    this.shell.card.removeClass("is-buffering");
  }
}
