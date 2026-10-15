import test from "node:test";
import assert from "node:assert/strict";
import {
  bestAudio, classifyListUrl, extFor, formatBytes, formatEta, formatPercent, formatSpeed, mapFormat, mapFormats, pageSlice,
  parseDuration, parseMime, parseViews, planChunks, playabilityMessage, playableVideo, resultFromNode, resultsFromNodes, selectPlayback,
  CHUNK_BYTES,
} from "../src/jsmap.ts";
import { offlineChoices } from "../src/formats.ts";
import type { StreamFormat } from "../src/formats.ts";

const U = "https://rr1.googlevideo.com/videoplayback?x=1";
const raw = (o: Record<string, unknown>) => ({ url: U, ...o }) as any;

function sf(o: Partial<StreamFormat>): StreamFormat {
  return { url: U, formatId: "1", ext: "mp4", height: null, fps: null, bitrate: null, filesize: null, filesizeApprox: null, vcodec: "none", acodec: "none", protocol: "https", hasVideo: false, hasAudio: false, ...o };
}
const vid = (id: string, height: number, vcodec: string, o: Partial<StreamFormat> = {}) => sf({ formatId: id, height, vcodec, hasVideo: true, fps: 30, bitrate: height, ...o });
const aud = (id: string, acodec: string, o: Partial<StreamFormat> = {}) => sf({ formatId: id, acodec, hasAudio: true, ext: acodec.startsWith("mp4a") ? "m4a" : "webm", bitrate: 100, ...o });

// ---------- parseMime / extFor ----------

test("parseMime handles unquoted codecs, extra spaces and upper case", () => {
  assert.deepEqual(parseMime("video/webm;codecs=vp9"), { container: "video/webm", video: "vp9", audio: "" });
  assert.deepEqual(parseMime('Video/MP4 ;  codecs = "AV01.0.05M.08 ,  mp4a.40.2"'), { container: "video/mp4", video: "AV01.0.05M.08", audio: "mp4a.40.2" });
});

test("parseMime keeps only the first codec per kind and ignores unknown ones", () => {
  assert.deepEqual(parseMime('video/mp4; codecs="avc1.4d401f, avc1.640028, mp4a.40.2, mp4a.40.5, weird.1"'), { container: "video/mp4", video: "avc1.4d401f", audio: "mp4a.40.2" });
});

test("parseMime recognises every video and audio codec family", () => {
  for (const v of ["avc1.1", "avc3.1", "vp9", "vp09.00.40.08", "vp8", "av01.0", "hev1.1", "hvc1.1", "h263", "theora"]) assert.equal(parseMime(`video/x; codecs="${v}"`).video, v, v);
  for (const a of ["mp4a.40.2", "opus", "vorbis", "ac-3", "ec-3", "flac", "mp3"]) assert.equal(parseMime(`audio/x; codecs="${a}"`).audio, a, a);
});

test("parseMime survives garbage", () => {
  assert.deepEqual(parseMime(""), { container: "", video: "", audio: "" });
  assert.deepEqual(parseMime("nonsense"), { container: "", video: "", audio: "" });
  assert.deepEqual(parseMime('audio/mp4; codecs=""'), { container: "audio/mp4", video: "", audio: "" });
});

test("extFor maps containers the way yt-dlp names files", () => {
  assert.equal(extFor("video/mp4"), "mp4");
  assert.equal(extFor("audio/mp4"), "m4a");
  assert.equal(extFor("video/webm"), "webm");
  assert.equal(extFor("audio/webm"), "webm");
  assert.equal(extFor("video/3gpp"), "3gp");
  assert.equal(extFor("video/x-flv"), "");
  assert.equal(extFor(""), "");
});

// ---------- mapFormat ----------

test("mapFormat needs a positive integer itag", () => {
  for (const itag of [0, -3, 1.5, "18", undefined, NaN]) assert.equal(mapFormat(raw({ itag, mime_type: "video/mp4", has_video: true }), null), null, String(itag));
  assert.ok(mapFormat(raw({ itag: 18, mime_type: "video/mp4", has_video: true }), null));
});

test("mapFormat accepts http and https, rejects other schemes and non-strings", () => {
  assert.ok(mapFormat(raw({ itag: 1, url: "http://a/b", mime_type: "video/mp4", has_video: true }), null));
  assert.ok(mapFormat(raw({ itag: 1, url: "HTTPS://a/b", mime_type: "video/mp4", has_video: true }), null));
  for (const url of ["data:video/mp4;base64,AA", "blob:x", 5, null, ""]) assert.equal(mapFormat(raw({ itag: 1, url, mime_type: "video/mp4", has_video: true }), null), null);
});

test("mapFormat drops OTF segments and text tracks", () => {
  assert.equal(mapFormat(raw({ itag: 1, mime_type: "video/mp4", has_video: true, is_type_otf: true }), null), null);
  assert.equal(mapFormat(raw({ itag: 1, mime_type: "video/mp4", has_text: true, has_video: true }), null), null);
});

test("mapFormat infers video/audio from the mime type when flags are absent", () => {
  const v = mapFormat(raw({ itag: 1, mime_type: 'video/mp4; codecs="avc1.4d401f"', height: 480 }), null)!;
  assert.ok(v.hasVideo && !v.hasAudio);
  const a = mapFormat(raw({ itag: 2, mime_type: 'audio/webm; codecs="opus"' }), null)!;
  assert.ok(!a.hasVideo && a.hasAudio);
  const both = mapFormat(raw({ itag: 3, mime_type: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', height: 360 }), null)!;
  assert.ok(both.hasVideo && both.hasAudio);
  assert.equal(both.acodec, "mp4a.40.2");
});

test("mapFormat marks missing codecs as unknown and absent streams as none", () => {
  const f = mapFormat(raw({ itag: 1, mime_type: "video/mp4", has_video: true, has_audio: true, height: 360 }), null)!;
  assert.equal(f.vcodec, "unknown");
  assert.equal(f.acodec, "unknown");
  const a = mapFormat(raw({ itag: 2, mime_type: "audio/mp4", has_video: false, has_audio: true }), null)!;
  assert.equal(a.vcodec, "none");
});

test("mapFormat rejects formats that have neither video nor audio", () => {
  assert.equal(mapFormat(raw({ itag: 1, mime_type: "video/mp4", has_video: false, has_audio: false }), null), null);
});

test("mapFormat bitrate prefers the average and rounds to 0.1 kbit/s", () => {
  assert.equal(mapFormat(raw({ itag: 1, mime_type: "audio/mp4", has_audio: true, bitrate: 130000, average_bitrate: 129000 }), null)!.bitrate, 129);
  assert.equal(mapFormat(raw({ itag: 1, mime_type: "audio/mp4", has_audio: true, bitrate: 1234567 }), null)!.bitrate, 1234.6);
  assert.equal(mapFormat(raw({ itag: 1, mime_type: "audio/mp4", has_audio: true }), null)!.bitrate, null);
});

test("mapFormat file sizes: numeric strings, junk, zero and the duration-based estimate", () => {
  const base = { itag: 1, mime_type: "audio/mp4", has_audio: true, bitrate: 80000 };
  assert.equal(mapFormat(raw({ ...base, content_length: "12345" }), 10)!.filesize, 12345);
  assert.equal(mapFormat(raw({ ...base, content_length: 777 }), 10)!.filesize, 777);
  const junk = mapFormat(raw({ ...base, content_length: "abc" }), 10)!;
  assert.equal(junk.filesize, null);
  assert.equal(junk.filesizeApprox, 100_000); // 80 kbit/s * 10 s / 8
  assert.equal(mapFormat(raw({ ...base, content_length: "0" }), 10)!.filesize, null);
  assert.equal(mapFormat(raw({ ...base, content_length: "  " }), 10)!.filesize, null);
  assert.equal(mapFormat(raw({ ...base }), 0)!.filesizeApprox, null);
  assert.equal(mapFormat(raw({ ...base }), null)!.filesizeApprox, null);
  assert.equal(mapFormat(raw({ ...base, content_length: 5 }), 10)!.filesizeApprox, null, "an exact size makes the estimate unnecessary");
});

test("mapFormat heights and fps: only for video, only when positive", () => {
  const v = mapFormat(raw({ itag: 1, mime_type: "video/mp4", has_video: true, height: 0, fps: 60 }), null)!;
  assert.equal(v.height, null);
  assert.equal(v.fps, 60);
  const a = mapFormat(raw({ itag: 2, mime_type: "audio/mp4", has_audio: true, height: 720, fps: 30 }), null)!;
  assert.equal(a.height, null);
  assert.equal(a.fps, null);
  assert.equal(mapFormat(raw({ itag: 3, mime_type: "video/mp4", has_video: true, height: "1080" }), null)!.height, 1080);
});

test("mapFormat maps 3gp video", () => {
  const f = mapFormat(raw({ itag: 17, mime_type: 'video/3gpp; codecs="mp4v.20.3, mp4a.40.2"', has_video: true, has_audio: true, height: 144 }), null)!;
  assert.equal(f.ext, "3gp");
  assert.equal(f.acodec, "mp4a.40.2");
});

test("mapFormats skips dubbed, auto-dubbed and descriptive audio and keeps the first of a repeated itag", () => {
  const a = { mime_type: 'audio/mp4; codecs="mp4a.40.2"', has_audio: true };
  const list = mapFormats([
    raw({ itag: 140, ...a, bitrate: 1 }),
    raw({ itag: 141, ...a, is_dubbed: true }),
    raw({ itag: 142, ...a, is_auto_dubbed: true }),
    raw({ itag: 143, ...a, is_descriptive: true }),
    raw({ itag: 140, ...a, bitrate: 999999 }),
    null as any,
  ].filter(Boolean), null);
  assert.deepEqual(list.map((f) => f.formatId), ["140"]);
  assert.equal(list[0]!.bitrate, 0.0 + 0, "bitrate 1 bit/s rounds to 0 kbit/s");
});

test("mapFormats of an empty list is empty", () => {
  assert.deepEqual(mapFormats([], 10), []);
});

// ---------- selection helpers ----------

test("playableVideo accepts H.264, AV1 and VP9 with a height, nothing else", () => {
  assert.ok(playableVideo(vid("1", 360, "avc1.42")));
  assert.ok(playableVideo(vid("2", 360, "av01.0.05M.08")));
  assert.ok(playableVideo(vid("3", 360, "vp9")));
  assert.ok(playableVideo(vid("4", 360, "vp09.00.40.08")));
  assert.ok(!playableVideo(vid("5", 360, "hev1.1.6")));
  assert.ok(!playableVideo(vid("6", 360, "vp8")));
  assert.ok(!playableVideo(vid("7", 0, "avc1.42", { height: null })));
  assert.ok(!playableVideo(aud("8", "opus")));
});

test("bestAudio prefers m4a over a higher-bitrate opus, then the highest bitrate", () => {
  const picked = bestAudio([aud("251", "opus", { bitrate: 160 }), aud("139", "mp4a.40.5", { bitrate: 48 }), aud("140", "mp4a.40.2", { bitrate: 129 })]);
  assert.equal(picked?.formatId, "140");
});

test("bestAudio falls back to opus, ignores other codecs and video streams", () => {
  assert.equal(bestAudio([aud("251", "opus", { bitrate: 160 }), aud("250", "opus", { bitrate: 70 })])?.formatId, "251");
  assert.equal(bestAudio([aud("1", "ec-3"), vid("2", 360, "avc1", { hasAudio: true, acodec: "mp4a.40.2" })]), null);
  assert.equal(bestAudio([]), null);
});

test("selectPlayback: AV1 beats VP9 at the same height; H.264 beats both; higher fps breaks ties", () => {
  const audio = aud("140", "mp4a.40.2");
  assert.equal(selectPlayback("t", [vid("a", 720, "vp9"), vid("b", 720, "av01.0"), audio], 720).video.formatId, "b");
  assert.equal(selectPlayback("t", [vid("a", 720, "vp9"), vid("b", 720, "av01.0"), vid("c", 720, "avc1.4d"), audio], 720).video.formatId, "c");
  assert.equal(selectPlayback("t", [vid("a", 720, "avc1", { fps: 30 }), vid("b", 720, "avc1", { fps: 60 }), audio], 720).video.formatId, "b");
});

test("selectPlayback without any audio stream uses the muxed format, or the video alone", () => {
  const muxed = vid("18", 360, "avc1", { hasAudio: true, acodec: "mp4a.40.2" });
  const p = selectPlayback("t", [muxed, vid("137", 1080, "avc1")], 1080);
  assert.equal(p.video.formatId, "18");
  assert.equal(p.audio, null);
  const alone = selectPlayback("t", [vid("137", 1080, "avc1")], 1080);
  assert.equal(alone.video.formatId, "137");
  assert.equal(alone.audio, null);
});

test("selectPlayback prefers the separate pair at equal height, and a taller muxed stream over a shorter pair", () => {
  const muxed = vid("22", 720, "avc1", { hasAudio: true, acodec: "mp4a.40.2" });
  const equal = selectPlayback("t", [muxed, vid("136", 720, "avc1"), aud("140", "mp4a.40.2")], 720);
  assert.equal(equal.video.formatId, "136");
  assert.equal(equal.audio?.formatId, "140");
  const taller = selectPlayback("t", [muxed, vid("135", 480, "avc1"), aud("140", "mp4a.40.2")], 720);
  assert.equal(taller.video.formatId, "22");
  assert.equal(taller.audio, null);
});

test("selectPlayback heights are unique, ascending and ignore unplayable codecs", () => {
  const p = selectPlayback("t", [vid("1", 720, "avc1"), vid("2", 720, "vp9"), vid("3", 360, "avc1"), vid("4", 1080, "hev1.1"), aud("140", "mp4a.40.2")], 1080);
  assert.deepEqual(p.heights, [360, 720]);
  assert.equal(p.height, 720);
});

test("selectPlayback throws when nothing is playable", () => {
  assert.throws(() => selectPlayback("t", [], 720), /No playable video stream/);
  assert.throws(() => selectPlayback("t", [vid("1", 720, "hev1.1")], 720), /No playable video stream/);
  assert.throws(() => selectPlayback("t", [aud("140", "mp4a.40.2")], 720), /No playable video stream/);
});

test("selectPlayback passes the title through, including null", () => {
  assert.equal(selectPlayback(null, [vid("1", 360, "avc1")], 360).title, null);
  assert.equal(selectPlayback("Hello", [vid("1", 360, "avc1")], 360).title, "Hello");
});

// ---------- numbers and text ----------

test("planChunks: exact multiples, remainders, tiny files and invalid input", () => {
  assert.deepEqual(planChunks(10, 5), [[0, 4], [5, 9]]);
  assert.deepEqual(planChunks(11, 5), [[0, 4], [5, 9], [10, 10]]);
  assert.deepEqual(planChunks(3, 5), [[0, 2]]);
  assert.deepEqual(planChunks(1, 1), [[0, 0]]);
  for (const bad of [0, -1, NaN, Infinity]) assert.deepEqual(planChunks(bad, 5), []);
  assert.deepEqual(planChunks(10, 0), []);
  assert.deepEqual(planChunks(10, -5), []);
});

test("planChunks defaults to 8 MiB pieces that tile the file without gaps", () => {
  assert.equal(CHUNK_BYTES, 8 * 1024 * 1024);
  const total = 25 * 1024 * 1024 + 17;
  const plan = planChunks(total);
  assert.equal(plan.length, 4);
  assert.equal(plan[0]![0], 0);
  assert.equal(plan.at(-1)![1], total - 1);
  for (let i = 1; i < plan.length; i++) assert.equal(plan[i]![0], plan[i - 1]![1] + 1);
  assert.ok(plan.slice(0, -1).every(([a, b]) => b - a + 1 === CHUNK_BYTES));
});

test("formatPercent clamps and blanks", () => {
  assert.equal(formatPercent(50, 200), "25.0%");
  assert.equal(formatPercent(300, 200), "100.0%");
  assert.equal(formatPercent(-5, 200), "0.0%");
  assert.equal(formatPercent(5, null), "");
  assert.equal(formatPercent(5, 0), "");
});

test("formatBytes covers every unit and bad input", () => {
  assert.equal(formatBytes(0), "0.00B");
  assert.equal(formatBytes(1023), "1023.00B");
  assert.equal(formatBytes(1024), "1.00KiB");
  assert.equal(formatBytes(1536), "1.50KiB");
  assert.equal(formatBytes(1024 ** 2), "1.00MiB");
  assert.equal(formatBytes(1024 ** 3 * 2.5), "2.50GiB");
  assert.equal(formatBytes(1024 ** 4), "1.00TiB");
  assert.equal(formatBytes(1024 ** 5), "1024.00TiB");
  for (const bad of [null, -1, NaN, Infinity]) assert.equal(formatBytes(bad as number | null), "Unknown");
});

test("formatSpeed and formatEta edge cases", () => {
  assert.equal(formatSpeed(1024 ** 2), "1.00MiB/s");
  for (const bad of [null, 0, -5, NaN]) assert.equal(formatSpeed(bad as number | null), "Unknown B/s");
  assert.equal(formatEta(0), "00:00");
  assert.equal(formatEta(59.6), "01:00");
  assert.equal(formatEta(75), "01:15");
  assert.equal(formatEta(3599.5), "01:00:00");
  assert.equal(formatEta(3723), "01:02:03");
  assert.equal(formatEta(100 * 3600), "100:00:00");
  for (const bad of [null, -1, NaN, Infinity]) assert.equal(formatEta(bad as number | null), "Unknown");
});

test("parseDuration reads M:SS, MM:SS and H:MM:SS forms", () => {
  assert.equal(parseDuration("0:19"), 19);
  assert.equal(parseDuration("3:55"), 235);
  assert.equal(parseDuration("59:59"), 3599);
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("12:34:56"), 45296);
  assert.equal(parseDuration("24:00:00"), 86400);
  assert.equal(parseDuration("  3:05 "), 185);
});

test("parseDuration rejects anything that is not a clock", () => {
  for (const bad of ["LIVE", "", "3", "3:5", "1:2:3", "100:00", "1:00:00:00", "a:bc", "3:55 left", "-1:00"]) assert.equal(parseDuration(bad), null, bad);
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration(undefined), null);
});

test("parseViews: abbreviations, separators, singular, empty and unreadable", () => {
  assert.equal(parseViews("No views"), 0);
  assert.equal(parseViews("no view"), 0);
  assert.equal(parseViews("1 view"), 1);
  assert.equal(parseViews("1.2M views"), 1_200_000);
  assert.equal(parseViews("768M views"), 768_000_000);
  assert.equal(parseViews("2.5B views"), 2_500_000_000);
  assert.equal(parseViews("1.2K views"), 1200);
  assert.equal(parseViews("12K views"), 12_000);
  assert.equal(parseViews("1.5 M views"), 1_500_000);
  assert.equal(parseViews("444,275,066 views"), 444_275_066);
  assert.equal(parseViews("1.234 views"), 1234);
  assert.equal(parseViews("  7,001 VIEWS "), 7001);
  for (const bad of ["views", "abc", "", "3.4M subscribers", "1.2M"]) assert.equal(parseViews(bad), null, bad);
  assert.equal(parseViews(null), null);
  assert.equal(parseViews(undefined), null);
});

// ---------- nodes ----------

const ID1 = "aaaaaaaaaaa", ID2 = "bbbbbbbbbbb";

test("resultFromNode: classic nodes, id fallback, short view counts and string authors", () => {
  assert.deepEqual(resultFromNode({ type: "GridVideo", id: ID1, title: { text: "G" }, author: "Plain Author", length_text: { text: "1:02:03" }, short_view_count: { text: "5K views" } }),
    { id: ID1, title: "G", channel: "Plain Author", duration: 3723, views: 5000 });
  assert.deepEqual(resultFromNode({ type: "CompactVideo", video_id: ID1, title: { text: "C" }, author: { name: "N" }, duration: { seconds: 0 } }),
    { id: ID1, title: "C", channel: "N", duration: 0, views: null });
  assert.equal(resultFromNode({ type: "ReelItem", id: ID1 })!.title, ID1, "a missing title falls back to the id");
});

test("resultFromNode: view_count wins over short_view_count", () => {
  const r = resultFromNode({ type: "Video", video_id: ID1, view_count: { text: "1,000 views" }, short_view_count: { text: "9K views" } });
  assert.equal(r!.views, 1000);
});

test("resultFromNode rejects non-videos and bad ids", () => {
  for (const node of [null, undefined, "str", 5, {}, { type: "Channel", id: ID1 }, { type: "Playlist", id: ID1 }, { type: "Video", video_id: "short" }, { type: "Video", video_id: 12345678901 }, { type: "ShelfRenderer" }]) {
    assert.equal(resultFromNode(node as any), null, JSON.stringify(node));
  }
});

test("resultFromNode: lockup rows put views and channel apart, skip 'ago', and read the duration badge", () => {
  const node = {
    type: "LockupView", content_id: ID1, content_type: "VIDEO",
    metadata: { title: { text: "L" }, metadata: { metadata_rows: [
      { metadata_parts: [{ text: { text: "Chan" } }] },
      { metadata_parts: [{ text: { text: "No views" } }, { text: { text: "3 weeks ago" } }] },
    ] } },
    content_image: { overlays: [{ badges: [{ text: "LIVE" }] }, { badges: [{ text: "1:02:03" }] }] },
  };
  assert.deepEqual(resultFromNode(node), { id: ID1, title: "L", channel: "Chan", duration: 3723, views: 0 });
});

test("resultFromNode: lockups of other kinds or with odd ids are ignored; sparse ones still map", () => {
  assert.equal(resultFromNode({ type: "LockupView", content_id: ID1, content_type: "PLAYLIST" }), null);
  assert.equal(resultFromNode({ type: "LockupView", content_id: "bad", content_type: "VIDEO" }), null);
  assert.deepEqual(resultFromNode({ type: "LockupView", content_id: ID1, content_type: "VIDEO" }), { id: ID1, title: ID1, channel: "", duration: null, views: null });
});

test("resultsFromNodes keeps order, drops repeats and survives non-arrays", () => {
  const nodes = [{ type: "Video", video_id: ID2, title: { text: "b" } }, null, { type: "Video", video_id: ID1, title: { text: "a" } }, { type: "Video", video_id: ID2, title: { text: "b2" } }];
  assert.deepEqual(resultsFromNodes(nodes).map((r) => [r.id, r.title]), [[ID2, "b"], [ID1, "a"]]);
  for (const bad of [undefined, null, "x", {}, 5]) assert.deepEqual(resultsFromNodes(bad), []);
});

// ---------- links ----------

test("classifyListUrl accepts every YouTube host form", () => {
  for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "WWW.YOUTUBE.COM"]) {
    assert.deepEqual(classifyListUrl(`https://${host}/playlist?list=PLabc`), { kind: "playlist", id: "PLabc" }, host);
  }
  assert.deepEqual(classifyListUrl("youtube.com/playlist?list=PLabc"), { kind: "playlist", id: "PLabc" });
});

test("classifyListUrl rejects other hosts, look-alikes and short ids", () => {
  for (const bad of ["https://youtu.be/abc?list=PLabc", "https://notyoutube.com/@x", "https://youtube.com.evil.com/@x", "https://evil.com/youtube.com/@x", "", "   ", "https://www.youtube.com/playlist?list=L", "https://www.youtube.com/playlist?list=a b", "https://www.youtube.com/"]) {
    assert.equal(classifyListUrl(bad), null, bad);
  }
});

test("classifyListUrl: handles, channels, /c/ and /user/", () => {
  assert.deepEqual(classifyListUrl("https://www.youtube.com/@handle/videos?x=1"), { kind: "channel", url: "https://www.youtube.com/@handle" });
  assert.equal(classifyListUrl("https://www.youtube.com/@"), null);
  const id = "UC" + "x".repeat(22);
  assert.deepEqual(classifyListUrl(`https://www.youtube.com/channel/${id}/videos`), { kind: "channel", url: `https://www.youtube.com/channel/${id}`, browseId: id });
  assert.equal(classifyListUrl("https://www.youtube.com/channel/UCshort"), null);
  assert.equal(classifyListUrl(`https://www.youtube.com/channel/XX${"x".repeat(22)}`), null);
  assert.deepEqual(classifyListUrl("https://www.youtube.com/c/Some_Name"), { kind: "channel", url: "https://www.youtube.com/c/Some_Name" });
  assert.deepEqual(classifyListUrl("https://www.youtube.com/user/oldname"), { kind: "channel", url: "https://www.youtube.com/user/oldname" });
  assert.equal(classifyListUrl("https://www.youtube.com/c/"), null);
  assert.equal(classifyListUrl("https://www.youtube.com/user"), null);
});

test("classifyListUrl: a list parameter outranks the path", () => {
  assert.deepEqual(classifyListUrl("https://www.youtube.com/@handle?list=PLwins"), { kind: "playlist", id: "PLwins" });
  assert.equal(classifyListUrl("https://www.youtube.com/watch?v=jNQXAC9IVRw"), null);
});

// ---------- playability ----------

test("playabilityMessage: OK and missing statuses are playable", () => {
  assert.equal(playabilityMessage("OK", undefined, false), null);
  assert.equal(playabilityMessage(undefined, "whatever", false), null);
});

test("playabilityMessage: a live flag wins over everything", () => {
  assert.match(playabilityMessage("OK", undefined, true)!, /live stream/);
  assert.match(playabilityMessage("UNPLAYABLE", "x", true)!, /live stream/);
});

test("playabilityMessage: sign-in flavours", () => {
  assert.match(playabilityMessage("LOGIN_REQUIRED", "This video is private", false)!, /private/);
  assert.match(playabilityMessage("LOGIN_REQUIRED", "Sign in to confirm your age", false)!, /age-restricted/);
  assert.match(playabilityMessage("LOGIN_REQUIRED", "This video may be inappropriate for some users", false)!, /age-restricted/);
  assert.match(playabilityMessage("LOGIN_REQUIRED", "Sign in to confirm you're not a bot", false)!, /asked for a sign-in/);
  assert.match(playabilityMessage("LOGIN_REQUIRED", undefined, false)!, /asked for a sign-in to play this video\.$/);
});

test("playabilityMessage: other statuses and the reason suffix", () => {
  assert.match(playabilityMessage("AGE_VERIFICATION_REQUIRED", undefined, false)!, /age-restricted\.$/);
  assert.match(playabilityMessage("CONTENT_CHECK_REQUIRED", "check", false)!, /age-restricted \(check\)\.$/);
  assert.match(playabilityMessage("LIVE_STREAM_OFFLINE", "Starts soon", false)!, /not available right now \(Starts soon\)\.$/);
  assert.equal(playabilityMessage("UNPLAYABLE", undefined, false), "This video is unavailable or blocked.");
  assert.equal(playabilityMessage("ERROR", "gone", false), "This video is unavailable (gone).");
  assert.equal(playabilityMessage("WEIRD", undefined, false), "YouTube cannot play this video (WEIRD).");
  assert.equal(playabilityMessage("WEIRD", "why", false), "YouTube cannot play this video (WEIRD) (why).");
});

// ---------- paging ----------

test("pageSlice clamps negative pages and handles empties", () => {
  assert.deepEqual(pageSlice([1, 2, 3, 4, 5], -3, 2), [1, 2]);
  assert.deepEqual(pageSlice([1, 2, 3, 4, 5], 2, 2), [5]);
  assert.deepEqual(pageSlice([1, 2, 3, 4, 5], 3, 2), []);
  assert.deepEqual(pageSlice([], 0, 5), []);
  assert.deepEqual(pageSlice([1, 2], 0, 0), []);
});

// ---------- offlineChoices on engine-produced formats ----------

const fixture = [
  raw({ itag: 18, mime_type: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', has_video: true, has_audio: true, height: 360, fps: 30, bitrate: 500000 }),
  raw({ itag: 137, mime_type: 'video/mp4; codecs="avc1.640028"', has_video: true, has_audio: false, height: 1080, fps: 30, bitrate: 4000000, average_bitrate: 3800000, content_length: "40000000" }),
  raw({ itag: 136, mime_type: 'video/mp4; codecs="avc1.4d401f"', has_video: true, has_audio: false, height: 720, fps: 60, bitrate: 2000000, content_length: 20000000 }),
  raw({ itag: 247, mime_type: 'video/webm; codecs="vp9"', has_video: true, has_audio: false, height: 720, fps: 30, bitrate: 1500000, content_length: 15000000 }),
  raw({ itag: 135, mime_type: 'video/mp4; codecs="avc1.4d401e"', has_video: true, has_audio: false, height: 480, fps: 30, bitrate: 900000 }),
  raw({ itag: 140, mime_type: 'audio/mp4; codecs="mp4a.40.2"', has_video: false, has_audio: true, bitrate: 130000, average_bitrate: 129000, content_length: 3000000 }),
  raw({ itag: 251, mime_type: 'audio/webm; codecs="opus"', has_video: false, has_audio: true, bitrate: 160000, content_length: 3500000 }),
];

test("offlineChoices on mapped formats: one per height plus audio-only, with sizes and pairing", () => {
  const choices = offlineChoices(mapFormats(fixture, 100), 100);
  assert.deepEqual(choices.map((c) => c.label), [
    "1080p · mp4 + m4a audio", "720p 60fps · mp4 + m4a audio", "480p · mp4 + m4a audio", "360p · mp4", "Audio only · m4a",
  ]);
  assert.deepEqual(choices.map((c) => c.formatIds), [["137", "140"], ["136", "140"], ["135", "140"], ["18"], ["140"]]);
  assert.deepEqual(choices.map((c) => c.audioOnly), [false, false, false, false, true]);
  assert.equal(choices[0]!.size, 43_000_000);
  assert.equal(choices[0]!.estimated, false);
  assert.equal(choices[1]!.size, 23_000_000);
});

test("offlineChoices marks sizes estimated when only a bitrate is known, and unknown without a duration", () => {
  const withDuration = offlineChoices(mapFormats(fixture, 100), 100);
  const p480 = withDuration.find((c) => c.label.startsWith("480p"))!;
  assert.equal(p480.estimated, true);
  assert.equal(p480.size, 11_250_000 + 3_000_000); // 900 kbit/s * 100 s / 8, plus the audio
  const noDuration = offlineChoices(mapFormats(fixture, null), null).find((c) => c.label.startsWith("480p"))!;
  assert.equal(noDuration.size, null);
  assert.equal(noDuration.estimated, true);
});

test("offlineChoices has no video choices without any audio unless the stream is muxed", () => {
  const onlyVideo = offlineChoices(mapFormats(fixture.filter((f) => f.itag === 137 || f.itag === 136), 100), 100);
  assert.deepEqual(onlyVideo, []);
  const muxedOnly = offlineChoices(mapFormats(fixture.filter((f) => f.itag === 18 || f.itag === 137), 100), 100);
  assert.deepEqual(muxedOnly.map((c) => c.label), ["360p · mp4"]);
});

test("offlineChoices falls back to webm when there is no mp4 for a height, and to opus audio", () => {
  const list = mapFormats([fixture[3]!, fixture[6]!], 100);
  const choices = offlineChoices(list, 100);
  assert.deepEqual(choices.map((c) => c.label), ["720p · webm + webm audio", "Audio only · webm"]);
  assert.deepEqual(choices[0]!.formatIds, ["247", "251"]);
});

test("offlineChoices ignores formats whose itag-based id is unusable", () => {
  const list = mapFormats(fixture, 100).map((f) => (f.formatId === "135" ? { ...f, formatId: "13 5/../" } : f));
  assert.ok(!offlineChoices(list, 100).some((c) => c.label.startsWith("480p")));
});
