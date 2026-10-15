import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyListUrl, formatBytes, formatEta, formatPercent, formatSpeed, mapFormat, mapFormats, pageSlice, parseDuration,
  parseMime, parseViews, planChunks, playabilityMessage, resultFromNode, resultsFromNodes, selectPlayback,
} from "../src/jsmap.ts";
import { offlineChoices } from "../src/formats.ts";

const U = "https://rr1.googlevideo.com/videoplayback?x=1";
const raw = (o: Record<string, unknown>) => ({ url: U, ...o }) as any;

const fixture = [
  raw({ itag: 18, mime_type: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', has_video: true, has_audio: true, height: 360, fps: 30, bitrate: 500000 }),
  raw({ itag: 137, mime_type: 'video/mp4; codecs="avc1.640028"', has_video: true, has_audio: false, height: 1080, fps: 30, bitrate: 4000000, average_bitrate: 3800000, content_length: "40000000" }),
  raw({ itag: 136, mime_type: 'video/mp4; codecs="avc1.4d401f"', has_video: true, has_audio: false, height: 720, fps: 30, bitrate: 2000000, content_length: 20000000 }),
  raw({ itag: 247, mime_type: 'video/webm; codecs="vp9"', has_video: true, has_audio: false, height: 720, fps: 30, bitrate: 1500000, content_length: 15000000 }),
  raw({ itag: 135, mime_type: 'video/mp4; codecs="avc1.4d401e"', has_video: true, has_audio: false, height: 480, fps: 30, bitrate: 900000 }),
  raw({ itag: 140, mime_type: 'audio/mp4; codecs="mp4a.40.2"', has_video: false, has_audio: true, bitrate: 130000, average_bitrate: 129000, content_length: 3000000 }),
  raw({ itag: 251, mime_type: 'audio/webm; codecs="opus"', has_video: false, has_audio: true, bitrate: 160000, content_length: 3500000 }),
  raw({ itag: 140, mime_type: 'audio/mp4; codecs="mp4a.40.2"', has_video: false, has_audio: true, bitrate: 1, is_drc: true }),
  raw({ itag: 999, mime_type: 'video/mp4; codecs="avc1.4d401f"', has_video: true, has_audio: false, height: 720, url: undefined }),
];

test("parseMime splits container and codecs", () => {
  assert.deepEqual(parseMime('video/mp4; codecs="avc1.4D400C, mp4a.40.2"'), { container: "video/mp4", video: "avc1.4D400C", audio: "mp4a.40.2" });
  assert.deepEqual(parseMime('audio/webm; codecs="opus"'), { container: "audio/webm", video: "", audio: "opus" });
  assert.deepEqual(parseMime(undefined), { container: "", video: "", audio: "" });
});

test("mapFormat produces yt-dlp-shaped formats", () => {
  const f = mapFormat(fixture[1]!, 100)!;
  assert.equal(f.formatId, "137");
  assert.equal(f.ext, "mp4");
  assert.equal(f.protocol, "https");
  assert.equal(f.filesize, 40000000);
  assert.equal(f.filesizeApprox, null);
  assert.equal(f.bitrate, 3800);
  assert.equal(f.vcodec, "avc1.640028");
  assert.equal(f.acodec, "none");
  assert.ok(f.hasVideo && !f.hasAudio);
  const a = mapFormat(fixture[5]!, 100)!;
  assert.equal(a.ext, "m4a");
  assert.equal(a.vcodec, "none");
  assert.equal(a.height, null);
  const muxed = mapFormat(fixture[0]!, 100)!;
  assert.ok(muxed.hasVideo && muxed.hasAudio);
  assert.equal(muxed.filesize, null);
  assert.equal(muxed.filesizeApprox, 6_250_000); // 500 kbit/s * 100 s / 8
});

test("mapFormat rejects unusable formats", () => {
  assert.equal(mapFormat(fixture[8]!, null), null); // no url
  assert.equal(mapFormat(raw({ itag: 5, mime_type: "video/x-flv", has_video: true }), null), null);
  assert.equal(mapFormat(raw({ itag: 5, mime_type: "video/mp4", has_text: true }), null), null);
  assert.equal(mapFormat(raw({ itag: 5, url: "ftp://x/y", mime_type: "video/mp4", has_video: true }), null), null);
});

test("mapFormats drops DRC and repeated itags", () => {
  const list = mapFormats(fixture, null);
  assert.deepEqual(list.map((f) => f.formatId), ["18", "137", "136", "247", "135", "140", "251"]);
});

test("selectPlayback prefers H.264 under the cap with m4a audio", () => {
  const formats = mapFormats(fixture, null);
  const p = selectPlayback("T", formats, 720);
  assert.equal(p.video.formatId, "136");
  assert.equal(p.audio?.formatId, "140");
  assert.equal(p.height, 720);
  assert.deepEqual(p.heights, [360, 480, 720, 1080]);
  assert.equal(p.title, "T");
  assert.equal(selectPlayback(null, formats, 0).video.formatId, "136"); // 0 means 720
  assert.equal(selectPlayback(null, formats, 1080).video.formatId, "137");
  assert.equal(selectPlayback(null, formats, 480).video.formatId, "135");
});

test("selectPlayback falls back to muxed, and to the smallest when all are taller", () => {
  const muxedOnly = mapFormats([fixture[0]!], null);
  const p = selectPlayback(null, muxedOnly, 720);
  assert.equal(p.video.formatId, "18");
  assert.equal(p.audio, null);
  const videoOnly = mapFormats([fixture[1]!, fixture[2]!, fixture[0]!], null); // no audio-only stream
  assert.equal(selectPlayback(null, videoOnly, 720).video.formatId, "18");
  const tall = mapFormats([fixture[1]!, fixture[2]!, fixture[5]!], null);
  assert.equal(selectPlayback(null, tall, 240).video.formatId, "136");
  assert.throws(() => selectPlayback(null, mapFormats([fixture[5]!], null), 720));
});

test("mapped formats feed offlineChoices", () => {
  const choices = offlineChoices(mapFormats(fixture, 100), 100);
  assert.equal(choices[0]?.label, "1080p · mp4 + m4a audio");
  assert.deepEqual(choices[0]?.formatIds, ["137", "140"]);
  assert.equal(choices.at(-1)?.audioOnly, true);
});

test("planChunks covers the file exactly", () => {
  assert.deepEqual(planChunks(0), []);
  assert.deepEqual(planChunks(10, 4), [[0, 3], [4, 7], [8, 9]]);
  assert.deepEqual(planChunks(8, 4), [[0, 3], [4, 7]]);
  const big = planChunks(20_000_000);
  assert.equal(big.length, 3);
  assert.equal(big.at(-1)?.[1], 19_999_999);
});

test("progress formatting matches yt-dlp's style", () => {
  assert.equal(formatPercent(42, 100), "42.0%");
  assert.equal(formatPercent(1, 0), "");
  assert.equal(formatBytes(12.34 * 1024 * 1024), "12.34MiB");
  assert.equal(formatBytes(512), "512.00B");
  assert.equal(formatBytes(null), "Unknown");
  assert.equal(formatSpeed(3.2 * 1024 * 1024), "3.20MiB/s");
  assert.equal(formatSpeed(0), "Unknown B/s");
  assert.equal(formatEta(12), "00:12");
  assert.equal(formatEta(3723), "01:02:03");
  assert.equal(formatEta(null), "Unknown");
});

test("duration and view parsing", () => {
  assert.equal(parseDuration("0:19"), 19);
  assert.equal(parseDuration("3:55"), 235);
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("LIVE"), null);
  assert.equal(parseViews("444,275,066 views"), 444275066);
  assert.equal(parseViews("768M views"), 768000000);
  assert.equal(parseViews("1.2K views"), 1200);
  assert.equal(parseViews("1 view"), 1);
  assert.equal(parseViews("No views"), 0);
  assert.equal(parseViews("2 years ago"), null);
});

test("resultFromNode reads classic and lockup nodes", () => {
  const node = {
    type: "Video", video_id: "jNQXAC9IVRw", title: { text: "Me at the zoo" }, author: { name: "jawed" },
    duration: { seconds: 19 }, view_count: { text: "444,275,066 views" },
  };
  const video = resultFromNode(node);
  assert.deepEqual(video, { id: "jNQXAC9IVRw", title: "Me at the zoo", channel: "jawed", duration: 19, views: 444275066 });
  const lockup = resultFromNode({
    type: "LockupView", content_id: "fOT0BUpITw8", content_type: "VIDEO",
    content_image: { overlays: [{ badges: [{ text: "3:55" }] }] },
    metadata: {
      title: { text: "BELLAKEO" },
      metadata: { metadata_rows: [
        { metadata_parts: [{ text: { text: "Peso Pluma" } }] },
        { metadata_parts: [{ text: { text: "768M views" } }, { text: { text: "2 years ago" } }] },
      ] },
    },
  });
  assert.deepEqual(lockup, { id: "fOT0BUpITw8", title: "BELLAKEO", channel: "Peso Pluma", duration: 235, views: 768000000 });
  assert.equal(resultFromNode({ type: "GridShelfView" }), null);
  assert.equal(resultFromNode({ type: "LockupView", content_id: "PLabc", content_type: "PLAYLIST" }), null);
  assert.equal(resultFromNode({ type: "Video", video_id: "short" }), null);
  const list = resultsFromNodes([{ type: "Shelf" }, node, node]);
  assert.equal(list.length, 1);
});

test("classifyListUrl", () => {
  assert.deepEqual(classifyListUrl("https://www.youtube.com/playlist?list=PLabc123"), { kind: "playlist", id: "PLabc123" });
  assert.deepEqual(classifyListUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLabc123"), { kind: "playlist", id: "PLabc123" });
  assert.deepEqual(classifyListUrl("youtube.com/@jawed"), { kind: "channel", url: "https://www.youtube.com/@jawed" });
  assert.deepEqual(classifyListUrl("https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A/videos"),
    { kind: "channel", url: "https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A", browseId: "UC4QobU6STFB0P71PMvOGN5A" });
  assert.deepEqual(classifyListUrl("https://www.youtube.com/c/Name"), { kind: "channel", url: "https://www.youtube.com/c/Name" });
  assert.deepEqual(classifyListUrl("https://www.youtube.com/user/Name"), { kind: "channel", url: "https://www.youtube.com/user/Name" });
  assert.equal(classifyListUrl("https://example.com/@x"), null);
  assert.equal(classifyListUrl("https://www.youtube.com/"), null);
});

test("playabilityMessage names the reason", () => {
  assert.equal(playabilityMessage("OK", undefined, false), null);
  assert.match(playabilityMessage("OK", undefined, true)!, /live stream/);
  assert.match(playabilityMessage("LOGIN_REQUIRED", "This video is private", false)!, /private/);
  assert.match(playabilityMessage("LOGIN_REQUIRED", "Sign in to confirm your age", false)!, /age-restricted/);
  assert.match(playabilityMessage("UNPLAYABLE", "Video unavailable", false)!, /unavailable/);
});

test("pageSlice", () => {
  assert.deepEqual(pageSlice([1, 2, 3, 4, 5], 1, 2), [3, 4]);
  assert.deepEqual(pageSlice([1, 2, 3], 5, 2), []);
});
