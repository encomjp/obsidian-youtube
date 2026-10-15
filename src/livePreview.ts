// Live Preview: an embed line `![caption](youtube-url)` becomes the player card while the caret is
// elsewhere, and turns back into Markdown when the caret enters the line.

import { Prec, RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { renderCard, type PlayerHost } from "./player.ts";
import { parseEmbedLine, type NoteVideo } from "./youtube.ts";

class YouTubeWidget extends WidgetType {
  private release: (() => void) | null = null;

  constructor(
    readonly host: PlayerHost,
    readonly video: NoteVideo,
    readonly embed: string,
    readonly sourcePath: string,
    readonly lineFrom: number,
  ) {
    super();
  }

  override eq(other: YouTubeWidget): boolean {
    // Unchanged players are reused while other blocks are edited.
    return other.embed === this.embed && other.sourcePath === this.sourcePath;
  }

  override toDOM(view: EditorView): HTMLElement {
    const dom = createDiv({ cls: "ytn-embed ytn-live" });
    this.release = renderCard(this.host, dom, {
      video: this.video,
      sourcePath: this.sourcePath,
      embed: this.embed,
      onEditSource: () => {
        const pos = this.findLine(view);
        if (pos !== null) view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        view.focus();
      },
    });
    return dom;
  }

  /** The line may have moved since the widget was built; find it again by its text. */
  private findLine(view: EditorView): number | null {
    const doc = view.state.doc;
    if (this.lineFrom <= doc.length) {
      const line = doc.lineAt(this.lineFrom);
      if (line.text.includes(this.embed)) return line.from + line.text.indexOf(this.embed);
    }
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const at = line.text.indexOf(this.embed);
      if (at >= 0) return line.from + at;
    }
    return null;
  }

  override destroy(): void {
    this.release?.();
    this.release = null;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  override get estimatedHeight(): number {
    return 360;
  }
}

function build(host: PlayerHost, state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let livePreview = false;
  try {
    livePreview = state.field(editorLivePreviewField);
  } catch {
    return builder.finish();
  }
  if (!livePreview) return builder.finish();
  const sourcePath = state.field(editorInfoField, false)?.file?.path ?? "";
  const selection = state.selection;
  const doc = state.doc;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (!line.text.includes("](") || !/youtu/i.test(line.text)) continue;
    const parsed = parseEmbedLine(line.text);
    if (!parsed) continue;
    if (selection.ranges.some((r) => r.from <= line.to && r.to >= line.from)) continue;
    const embed = line.text.slice(parsed.start, parsed.start + parsed.length);
    builder.add(line.from, line.to, Decoration.replace({
      widget: new YouTubeWidget(host, parsed.video, embed, sourcePath, line.from),
      block: true,
    }));
  }
  return builder.finish();
}

export function livePreviewExtension(host: PlayerHost): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => build(host, state),
    update(value, tr) {
      if (tr.docChanged || tr.selection || tr.startState.field(editorLivePreviewField, false) !== tr.state.field(editorLivePreviewField, false))
        return build(host, tr.state);
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  // Highest precedence so the card replaces Obsidian's own YouTube iframe on the same line.
  return Prec.highest(field);
}
