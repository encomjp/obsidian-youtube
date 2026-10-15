// Modals: insert a YouTube link, and pick the quality of an offline copy.

import { App, Modal, Notice, Setting, TextComponent } from "obsidian";
import { offlineChoices, type OfflineChoice } from "./formats.ts";
import type { Engine } from "./engine.ts";
import { formatBytes, parseYouTube, type NoteVideo } from "./youtube.ts";

export class InsertVideoModal extends Modal {
  constructor(app: App, private readonly onSubmit: (video: NoteVideo, title: string) => void) {
    super(app);
  }

  override onOpen() {
    this.setTitle("Insert YouTube video");
    let url = "", title = "";
    let urlInput: TextComponent | null = null;
    const submit = () => {
      const video = parseYouTube(url);
      if (!video) {
        new Notice("That is not a YouTube watch, share, Shorts, live, or embed link.");
        urlInput?.inputEl.focus();
        return;
      }
      this.close();
      this.onSubmit(video, title.trim());
    };
    new Setting(this.contentEl).setName("YouTube link")
      .setDesc("Start (t=) and end (end=) timestamps are kept.")
      .addText((text) => {
        urlInput = text;
        text.setPlaceholder("https://www.youtube.com/watch?v=…").onChange((value) => { url = value; });
        text.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
        text.inputEl.setCssProps({ width: "100%" });
      });
    new Setting(this.contentEl).setName("Title")
      .setDesc("Leave blank to use the video's real title from YouTube.")
      .addText((text) => {
        text.onChange((value) => { title = value; });
        text.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("Insert").setCta().onClick(submit));
    window.setTimeout(() => urlInput?.inputEl.focus(), 0);
  }

  override onClose() {
    this.contentEl.empty();
  }
}

/** Pick an offline quality; the download itself runs in the panel's queue. */
export class FormatPickerModal extends Modal {
  constructor(app: App, private readonly ytdlp: Engine, private readonly video: NoteVideo, private readonly title: string,
    private readonly onPick: (choice: OfflineChoice, title: string) => void) {
    super(app);
  }

  override onOpen() {
    this.setTitle("Save offline copy");
    this.contentEl.createDiv({ cls: "ytn-offline-title", text: this.title });
    const body = this.contentEl.createDiv();
    body.createDiv({ cls: "ytn-loading", text: "Reading available formats…" });
    void this.load(body);
  }

  private async load(body: HTMLElement) {
    try {
      const info = await this.ytdlp.formats(this.video.id);
      const choices = offlineChoices(info.formats, info.duration);
      body.empty();
      if (choices.length === 0) {
        body.createDiv({ cls: "ytn-error", text: "yt-dlp reported no downloadable formats for this video." });
        return;
      }
      body.createDiv({ cls: "setting-item-description", text: "Video and audio are saved as separate files next to each other and play together in the note. ≈ marks sizes yt-dlp estimates." });
      const list = body.createDiv({ cls: "ytn-choices" });
      for (const choice of choices) {
        const size = choice.size ? `${choice.estimated ? "≈" : ""}${formatBytes(choice.size)}` : "size unknown";
        new Setting(list).setName(choice.label).setDesc(size).addButton((b) => b.setButtonText("Download").onClick(() => {
          this.close();
          this.onPick(choice, info.title ?? this.title);
        }));
      }
    } catch (error) {
      body.empty();
      body.createDiv({ cls: "ytn-error", text: (error as Error).message });
    }
  }

  override onClose() {
    this.contentEl.empty();
  }
}
