import assert from "node:assert/strict";
import { test } from "node:test";
import { offlineChoices, parsePlayback, parseProgress, type StreamFormat } from "../src/formats.ts";

const fmt = (o: Record<string, unknown>) => ({ url: "https://rr1.googlevideo.com/videoplayback?x=1", ...o });

test("a video-only and audio-only pair plays with separate audio", () => {
  const playback = parsePlayback({
    title: "Clip",
    formats: [
      fmt({ format_id: "18", vcodec: "avc1", acodec: "mp4a", height: 360, ext: "mp4" }),
      fmt({ format_id: "136", vcodec: "avc1", acodec: "none", height: 720, ext: "mp4" }),
      fmt({ format_id: "137", vcodec: "avc1", acodec: "none", height: 1080, ext: "mp4" }),
      fmt({ format_id: "140", vcodec: "none", acodec: "mp4a", abr: 128, ext: "m4a" }),
    ],
    requested_formats: [
      fmt({ format_id: "136", vcodec: "avc1", acodec: "none", height: 720, ext: "mp4" }),
      fmt({ format_id: "140", vcodec: "none", acodec: "mp4a", abr: 128, ext: "m4a" }),
    ],
  });
  assert.equal(playback.video.formatId, "136");
  assert.equal(playback.audio?.formatId, "140");
  assert.equal(playback.height, 720);
  assert.deepEqual(playback.heights, [360, 720, 1080]);
  assert.equal(playback.title, "Clip");
});

test("a muxed selection needs no separate audio", () => {
  const playback = parsePlayback({
    formats: [fmt({ format_id: "18", vcodec: "avc1", acodec: "mp4a", height: 360 })],
    requested_downloads: [fmt({ format_id: "18", vcodec: "avc1", acodec: "mp4a", height: 360 })],
  });
  assert.equal(playback.video.formatId, "18");
  assert.equal(playback.audio, null);
});

test("streams without an http URL are ignored", () => {
  assert.throws(() => parsePlayback({ requested_formats: [{ url: "file:///etc/passwd", vcodec: "avc1", acodec: "mp4a", height: 360 }] }));
});

test("download progress lines are parsed", () => {
  assert.deepEqual(parseProgress(" 42.5%|  12.30MiB| 1.20MiB/s|00:08"), { percent: 42.5, total: "12.30MiB", speed: "1.20MiB/s", eta: "00:08" });
  assert.equal(parseProgress("N/A|N/A|N/A|N/A").percent, null);
});

test("offline choices pair video-only streams with separate audio, without ffmpeg", () => {
  const formats: StreamFormat[] = [
    { formatId: "18", vcodec: "avc1", acodec: "mp4a", height: 360, ext: "mp4", filesize: 10_000_000 },
    { formatId: "137", vcodec: "avc1", acodec: "none", height: 1080, ext: "mp4", filesize_approx: 90_000_000 },
    { formatId: "140", vcodec: "none", acodec: "mp4a", ext: "m4a", abr: 128, filesize: 5_000_000 },
  ].map((o) => ({
    url: "https://x", fps: null, bitrate: (o as { abr?: number }).abr ?? null,
    filesize: (o as { filesize?: number }).filesize ?? null,
    filesizeApprox: (o as { filesize_approx?: number }).filesize_approx ?? null,
    hasVideo: o.vcodec !== "none", hasAudio: o.acodec !== "none", formatId: o.formatId, vcodec: o.vcodec,
    acodec: o.acodec, height: o.height ?? null, ext: o.ext, protocol: "https",
  }));

  const choices = offlineChoices(formats, 200);
  assert.deepEqual(choices.map((c) => c.formatIds), [["137", "140"], ["18"], ["140"]]);
  assert.equal(choices[0]?.size, 95_000_000);
  assert.equal(choices[0]?.estimated, true);
  assert.equal(choices[0]?.label, "1080p · mp4 + m4a audio");
  assert.deepEqual(choices.map((c) => c.audioOnly), [false, false, true]);
});

test("direct streams are preferred over HLS at the same height", () => {
  const base = { url: "https://x", fps: null, bitrate: null, filesizeApprox: null, hasVideo: true, hasAudio: false, vcodec: "avc1", acodec: "none", height: 240, ext: "mp4" };
  const formats: StreamFormat[] = [
    { ...base, formatId: "229", protocol: "m3u8_native", filesize: null },
    { ...base, formatId: "133", protocol: "https", filesize: 400_000 },
    { ...base, formatId: "140", vcodec: "none", acodec: "mp4a", hasVideo: false, hasAudio: true, height: null, ext: "m4a", protocol: "https", filesize: 300_000 },
  ];
  assert.deepEqual(offlineChoices(formats, 19)[0]?.formatIds, ["133", "140"]);
});
