// Ported from Starnote.Tests/NoteMediaTests.cs, plus the embed-line and caption rules the plugin adds.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captionTitle, destination, offlineBlock, parseOfflineBlock, insertBlock, isGenericTitle, parseEmbedLine, parseTimeSeconds, parseYouTube,
  safeFileName, unwrap, videoFromEmbedSrc, videoMarkdown, watchUrl,
} from "../src/youtube.ts";

test("recognizes YouTube links and keeps their start time", () => {
  const cases: [string, number][] = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s", 90],
    ["https://youtu.be/dQw4w9WgXcQ?t=25", 25],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=12", 12],
    ["https://m.youtube.com/shorts/dQw4w9WgXcQ", 0],
    ["youtube.com/live/dQw4w9WgXcQ", 0],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s", 3723],
  ];
  for (const [url, start] of cases) {
    const video = parseYouTube(url);
    assert.ok(video, url);
    assert.equal(video.id, "dQw4w9WgXcQ", url);
    assert.equal(video.startSeconds, start, url);
  }
});

test("rejects false YouTube links", () => {
  for (const url of [
    "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
    "https://example.test/?url=https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQextra",
    "file://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://person@youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/channel/UC123",
    "",
  ]) assert.equal(parseYouTube(url), null, url);
});

test("huge and backwards timestamps are harmless", () => {
  const video = parseYouTube("https://youtu.be/dQw4w9WgXcQ?t=999999999999999999h&end=-1");
  assert.equal(video?.startSeconds, 0);
  assert.equal(video?.endSeconds, null);
});

test("browser fallback preserves a valid range", () => {
  const video = parseYouTube("https://youtu.be/dQw4w9WgXcQ?t=1m23s&end=110");
  assert.equal(video?.source, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83&end=110");
  assert.equal(watchUrl("dQw4w9WgXcQ", 83, 110), "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83&end=110");
});

test("malformed percent escapes do not break YouTube links", () => {
  const badTimestamp = parseYouTube("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=%ZZ");
  assert.equal(badTimestamp?.id, "dQw4w9WgXcQ");
  assert.equal(badTimestamp?.startSeconds, 0);
  assert.equal(parseYouTube("https://youtu.be/dQw4w9WgXcQ?%ZZ=1")?.id, "dQw4w9WgXcQ");
});

test("inserting media replaces the selection and keeps Windows line endings", () => {
  const source = "Before\r\n\r\nreplace\r\n\r\nAfter";
  const edit = insertBlock(source, 10, 7, "![video](attachments/clip.mp4)");
  assert.equal(source.slice(0, edit.from) + edit.insert + source.slice(edit.to), "Before\r\n\r\n![video](attachments/clip.mp4)\r\n\r\nAfter");
});

test("inserting into running text adds the missing blank lines", () => {
  const source = "One\nTwo";
  const edit = insertBlock(source, 3, 0, "![x](y)");
  assert.equal(source.slice(0, edit.from) + edit.insert + source.slice(edit.to), "One\n\n![x](y)\n\nTwo");
});

test("time parsing matches Starnote", () => {
  assert.equal(parseTimeSeconds("90"), 90);
  assert.equal(parseTimeSeconds("90s"), 90);
  assert.equal(parseTimeSeconds("1m30s"), 90);
  assert.equal(parseTimeSeconds("2h"), 7200);
  assert.equal(parseTimeSeconds("abc"), null);
  assert.equal(parseTimeSeconds(""), null);
});

test("captions drop brackets and placeholders", () => {
  assert.equal(captionTitle({ title: "A [great]\nvideo", id: "dQw4w9WgXcQ" }), "A great video");
  assert.equal(captionTitle({ title: "video", id: "dQw4w9WgXcQ" }), "YouTube video");
  assert.ok(isGenericTitle(" YouTube Video "));
  assert.ok(isGenericTitle("embed"));
  assert.ok(!isGenericTitle("Launch footage"));
  const video = parseYouTube("https://youtu.be/dQw4w9WgXcQ?t=90")!;
  assert.equal(videoMarkdown({ ...video, title: "Launch footage" }), "![Launch footage](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90)");
});

test("angle-bracket destinations round-trip", () => {
  assert.equal(destination("attachments/a b/My (clip).mp4"), "<attachments/a b/My (clip).mp4>");
  assert.equal(destination("plain/path.mp4"), "plain/path.mp4");
  assert.equal(unwrap("<attachments/a b.mp4>"), "attachments/a b.mp4");
});

test("embed lines are found only when alone on their line", () => {
  const parsed = parseEmbedLine("  ![Launch footage](https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90&end=120)  ");
  assert.ok(parsed);
  assert.equal(parsed.caption, "Launch footage");
  assert.equal(parsed.start, 2);
  assert.equal(parsed.video.startSeconds, 90);
  assert.equal(parsed.video.endSeconds, 120);
  assert.equal(parseEmbedLine("![](<https://youtu.be/dQw4w9WgXcQ>)")?.video.id, "dQw4w9WgXcQ");
  assert.equal(parseEmbedLine("text ![x](https://youtu.be/dQw4w9WgXcQ)"), null);
  assert.equal(parseEmbedLine("![x](attachments/clip.mp4)"), null);
  assert.equal(parseEmbedLine("[x](https://youtu.be/dQw4w9WgXcQ)"), null);
});

test("file names are safe on every platform", () => {
  assert.equal(safeFileName('What: is "this"? <clip>/part|2', "id"), "What is this clip part 2");
  assert.equal(safeFileName("...", "dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});

test("offline blocks round-trip and ignore non-YouTube sources", () => {
  const text = offlineBlock({ title: "Clip", video: "attachments/Clip.f137.mp4", audio: "attachments/Clip.f140.m4a", source: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.equal(text, "```youtube-offline\ntitle: Clip\nvideo: attachments/Clip.f137.mp4\naudio: attachments/Clip.f140.m4a\nsource: https://www.youtube.com/watch?v=dQw4w9WgXcQ\n```");
  const inner = text.split("\n").slice(1, -1).join("\n");
  assert.deepEqual(parseOfflineBlock(inner), { title: "Clip", video: "attachments/Clip.f137.mp4", audio: "attachments/Clip.f140.m4a", source: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  assert.equal(parseOfflineBlock("video: [[a.mp4|x]]\nsource: javascript:alert(1)").video, "a.mp4");
  assert.equal(parseOfflineBlock("source: javascript:alert(1)").source, null);
});

test("Obsidian's own YouTube iframe wrapper is recognized", () => {
  const v = videoFromEmbedSrc("https://releases.obsidian.md/youtube?v=jNQXAC9IVRw&start=5");
  assert.equal(v?.id, "jNQXAC9IVRw");
  assert.equal(v?.startSeconds, 5);
  assert.equal(videoFromEmbedSrc("https://www.youtube.com/embed/jNQXAC9IVRw")?.id, "jNQXAC9IVRw");
  assert.equal(videoFromEmbedSrc("https://evil.example/youtube?v=jNQXAC9IVRw"), null);
  assert.equal(videoFromEmbedSrc("https://releases.obsidian.md/other?v=jNQXAC9IVRw"), null);
});

test("a pasted nested link still embeds the video", () => {
  const parsed = parseEmbedLine("![titlde]([youtube.com](https://www.youtube.com/watch?v=wvr7-pDJUOA))");
  assert.equal(parsed?.video.id, "wvr7-pDJUOA");
  assert.equal(parsed?.caption, "titlde");
  assert.equal(videoFromEmbedSrc("app://obsidian.md/%5Byoutube.com%5D(https://www.youtube.com/watch?v=wvr7-pDJUOA)")?.id, "wvr7-pDJUOA");
  assert.equal(parseEmbedLine("![x]([y](https://example.com/watch?v=wvr7-pDJUOA))"), null);
});

test("file names are safe on Windows", () => {
  assert.equal(safeFileName("CON", "id"), "_CON");
  assert.equal(safeFileName("nul.txt", "id"), "_nul.txt");
  assert.equal(safeFileName("Trailing dots... ", "id"), "Trailing dots");
  assert.equal(safeFileName("a".repeat(200), "id").length, 80);
  assert.equal(safeFileName("Über café – 東京", "id"), "Über café – 東京");
  assert.equal(safeFileName("???", "dQw4w9WgXcQ"), "dQw4w9WgXcQ");
});
