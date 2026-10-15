import test from "node:test";
import assert from "node:assert/strict";
import { EngineChain, type EngineChoice, type Fallback } from "../src/engines.ts";
import type { Engine } from "../src/engine.ts";
import type { Playback } from "../src/formats.ts";

const PLAY: Playback = { title: "t", video: { url: "u", formatId: "1", ext: "mp4", height: 360, fps: 30, bitrate: 1, filesize: 1, filesizeApprox: null, vcodec: "avc1", acodec: "none", protocol: "https", hasVideo: true, hasAudio: false }, audio: null, height: 360, heights: [360] };

function mock(id: "js" | "yt-dlp", opts: { fail?: string; available?: boolean } = {}): Fallback & { calls: string[] } {
  const calls: string[] = [];
  const maybe = () => { if (opts.fail) throw new Error(opts.fail); };
  return {
    id, calls,
    available: async () => opts.available ?? true,
    describe: async () => `${id} engine`,
    playback: async () => { calls.push("playback"); maybe(); return { ...PLAY, title: id }; },
    formats: async () => { calls.push("formats"); maybe(); return { title: id, formats: [], duration: 1 }; },
    search: async () => { calls.push("search"); maybe(); return [{ id: "a", title: id, channel: "c", duration: 1, views: 1 }]; },
    listUrl: async () => { calls.push("listUrl"); maybe(); return []; },
    download: async () => { calls.push("download"); maybe(); return { files: [id], folder: id }; },
  } as Fallback & { calls: string[] };
}
const chain = (choice: EngineChoice, js: Engine, yt: Fallback) => new EngineChain(() => choice, js, yt);

test("auto uses the built-in engine first and never touches yt-dlp when it works", async () => {
  const js = mock("js"), yt = mock("yt-dlp");
  const c = chain("auto", js, yt);
  assert.equal((await c.playback("x", 720)).title, "js");
  assert.deepEqual(yt.calls, []);
});

test("auto falls back to an installed yt-dlp when the built-in engine fails", async () => {
  const js = mock("js", { fail: "boom" }), yt = mock("yt-dlp");
  const c = chain("auto", js, yt);
  assert.equal((await c.playback("x", 720)).title, "yt-dlp");
  assert.equal((await c.search("q"))[0]!.title, "yt-dlp");
});

test("auto without yt-dlp reports the built-in engine's own error", async () => {
  const js = mock("js", { fail: "video is private" }), yt = mock("yt-dlp", { available: false });
  await assert.rejects(chain("auto", js, yt).playback("x", 720), /video is private/);
  assert.deepEqual(yt.calls, []);
});

test("when both fail the first engine's error is shown", async () => {
  const js = mock("js", { fail: "first" }), yt = mock("yt-dlp", { fail: "second" });
  await assert.rejects(chain("auto", js, yt).search("q"), /first/);
});

test("builtin never calls yt-dlp, ytdlp never calls the built-in engine", async () => {
  const js = mock("js", { fail: "x" }), yt = mock("yt-dlp");
  await assert.rejects(chain("builtin", js, yt).playback("x", 720), /x/);
  assert.deepEqual(yt.calls, []);
  const js2 = mock("js"), yt2 = mock("yt-dlp");
  assert.equal((await chain("ytdlp", js2, yt2).playback("x", 720)).title, "yt-dlp");
  assert.deepEqual(js2.calls, []);
});

test("the setting is read on every call", async () => {
  let choice: EngineChoice = "builtin";
  const js = mock("js"), yt = mock("yt-dlp");
  const c = new EngineChain(() => choice, js, yt);
  assert.equal((await c.playback("x", 1)).title, "js");
  choice = "ytdlp";
  assert.equal((await c.playback("x", 1)).title, "yt-dlp");
});

test("a download goes to the engine that listed the formats", async () => {
  const js = mock("js", { fail: "no" }), yt = mock("yt-dlp");
  const c = chain("auto", js, yt);
  await c.formats("vid"); // js fails, yt-dlp answers
  yt.calls.length = 0; js.calls.length = 0;
  await c.download("vid", ["137"], () => undefined, new AbortController().signal);
  assert.deepEqual(js.calls, []);
  assert.deepEqual(yt.calls, ["download"]);
});

test("a cancelled download is not retried on another engine", async () => {
  const ctl = new AbortController();
  const js: Fallback & { calls: string[] } = { ...mock("js"), download: async () => { ctl.abort(); throw new Error("Download cancelled."); } };
  const yt = mock("yt-dlp");
  await assert.rejects(chain("auto", js, yt).download("v", ["1"], () => undefined, ctl.signal), /cancelled/);
  assert.deepEqual(yt.calls, []);
});

test("describe explains the setup", async () => {
  assert.match(await chain("auto", mock("js"), mock("yt-dlp", { available: false })).describe(), /No yt-dlp fallback/);
  assert.match(await chain("auto", mock("js"), mock("yt-dlp")).describe(), /Fallback: yt-dlp engine/);
});
