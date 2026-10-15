import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsEngine } from "../src/jsengine.ts";
import { YtDlpError } from "../src/formats.ts";
import type { DownloadProgress } from "../src/formats.ts";
import { planChunks } from "../src/jsmap.ts";
import {
  AAC, FakeYt, MIB, OPUS, VID, VP9, audio, bytesOf, feed, id11, info, mediaServer, muxed, video, vnode,
} from "./helpers/fakeyt.ts";
import type { Media } from "./helpers/fakeyt.ts";

// Downloads land in os.tmpdir(); point it at a private folder so the tests can look inside.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "oy-engine-test-"));
process.env.TMPDIR = TMP;
const leftovers = () => fs.readdirSync(TMP).filter((n) => n.startsWith("obsidian-youtube-"));

interface Rig { engine: JsEngine; yt: FakeYt; media: Media; created: () => number; url: (k: string) => string; close(): Promise<void> }

async function rig(clients: (url: (k: string) => string, media: Media) => Record<string, any>, files: Record<string, import("./helpers/fakeyt.ts").FileMode> = {}): Promise<Rig> {
  const media = await mediaServer();
  for (const [k, m] of Object.entries(files)) media.add(k, m);
  const yt = new FakeYt(clients(media.url, media));
  let created = 0;
  const engine = new JsEngine(() => ({ proxy: "" }), { createInnertube: async () => { created++; return yt; } });
  return { engine, yt, media, created: () => created, url: media.url, close: () => media.close() };
}

async function using(r: Rig, run: () => Promise<void>): Promise<void> {
  try { await run(); } finally { await r.close(); }
}

const clientsCalled = (r: Rig) => r.yt.calls.map((c) => c.client);

// ---------- client order and probing ----------

test("the first client is tried first and the others are skipped when it yields a video+audio pair", async () => {
  const r = await rig((u) => ({
    IOS: info({ adaptive: [video(137, 1080, u("v1080")), audio(140, u("a140"))] }),
    ANDROID: info({ adaptive: [video(22, 720, u("never"))] }),
  }), { v1080: { size: 1000 }, a140: { size: 1000 } });
  await using(r, async () => {
    const p = await r.engine.playback(VID, 1080);
    assert.deepEqual(clientsCalled(r), ["IOS"]);
    assert.equal(p.video.formatId, "137");
    assert.equal(p.audio?.formatId, "140");
  });
});

test("clients are tried in order IOS, ANDROID, TV, MWEB until a usable video appears", async () => {
  const r = await rig((u) => ({
    IOS: info({ adaptive: [video(137, 1080, u("dead"))] }),
    ANDROID: info({}),
    TV: info({ formats: [muxed(18, 360, u("m18"))] }),
    MWEB: info({ adaptive: [video(299, 2160, u("never"))] }),
  }), { dead: { size: 1000, forbid: true }, m18: { size: 1000 } });
  await using(r, async () => {
    // a muxed stream alone does not end the search (no pair), so MWEB is asked too
    const p = await r.engine.playback(VID, 720);
    assert.deepEqual(clientsCalled(r), ["IOS", "ANDROID", "TV", "MWEB"]);
    assert.equal(p.video.formatId, "18");
  });
});

test("a client whose formats all fail the tail probe is skipped for the next one", async () => {
  const r = await rig((u) => ({
    IOS: info({ adaptive: [video(137, 1080, u("i137")), audio(140, u("i140"))] }),
    ANDROID: info({ adaptive: [video(136, 720, u("a136")), audio(140, u("a140"))] }),
  }), { i137: { size: 1000, forbid: true }, i140: { size: 1000, forbid: true }, a136: { size: 1000 }, a140: { size: 1000 } });
  await using(r, async () => {
    const p = await r.engine.playback(VID, 1080);
    assert.deepEqual(clientsCalled(r), ["IOS", "ANDROID"]);
    assert.equal(p.video.formatId, "136");
    assert.equal(p.audio?.formatId, "140");
  });
});

test("video from one client and audio from another are combined", async () => {
  const r = await rig((u) => ({
    IOS: info({ adaptive: [video(137, 1080, u("v"))] }),
    ANDROID: info({ adaptive: [audio(140, u("a")), video(137, 1080, u("v-dup"))] }),
  }), { v: { size: 1000 }, a: { size: 1000 }, "v-dup": { size: 1000 } });
  await using(r, async () => {
    const f = await r.engine.formats(VID);
    assert.deepEqual(f.formats.map((x) => x.formatId).sort(), ["137", "140"]);
    assert.ok(f.formats.find((x) => x.formatId === "137")!.url.endsWith("/m/v"), "the first client's URL wins for a repeated itag");
  });
});

test("formats whose probe answers 403 are dropped, the rest kept", async () => {
  const r = await rig((u) => ({
    IOS: info({ adaptive: [video(137, 1080, u("v1080")), video(136, 720, u("v720")), audio(140, u("a"))] }),
  }), { v1080: { size: 1000, forbid: true }, v720: { size: 1000 }, a: { size: 1000 } });
  await using(r, async () => {
    const f = await r.engine.formats(VID);
    assert.deepEqual(f.formats.map((x) => x.formatId), ["136", "140"]);
  });
});

test("the probe asks for the last KiB of a known-size file", async () => {
  const size = 5 * MIB;
  const r = await rig((u) => ({ IOS: info({ adaptive: [video(137, 1080, u("big"), { content_length: String(size) }), audio(140, u("aud"))] }) }),
    { big: { size }, aud: { size: 1000 } });
  await using(r, async () => {
    await r.engine.formats(VID);
    assert.deepEqual(r.media.rangesFor("big"), [`bytes=${size - 1024}-${size - 1}`]);
    assert.deepEqual(r.media.rangesFor("aud"), ["bytes=0-1023"]);
  });
});

test("a stream whose tail the server rejects is dropped, so playback fails", async () => {
  const size = 3 * MIB;
  const r = await rig((u) => ({ IOS: info({ adaptive: [video(137, 720, u("t"), { content_length: String(size) }), audio(140, u("a"))] }) }),
    { t: { size, forbidPast: size - 2048 }, a: { size: 1000 } });
  await using(r, async () => {
    await assert.rejects(r.engine.playback(VID, 720));
  });
});

test("when the size is only approximate the probe aims at 90% of it", async () => {
  const approx = Math.round(128000 * 212 / 8); // bitrate * duration / 8
  const r = await rig((u) => ({ IOS: info({ adaptive: [video(137, 720, u("t"), { content_length: undefined, bitrate: 128000 }), audio(140, u("a"))] }) }),
    { t: { size: approx }, a: { size: 1000 } });
  await using(r, async () => {
    await r.engine.formats(VID);
    const guess = Math.floor(approx * 0.9);
    assert.deepEqual(r.media.rangesFor("t"), [`bytes=${guess - 1024}-${guess - 1}`]);
  });
});

test("416, 200 and 206 count as served; 500, 404 and dropped connections do not", async () => {
  const r = await rig((u) => ({
    IOS: info({ adaptive: [
      video(1, 100, u("ok206")), video(2, 200, u("ok200")), video(3, 300, u("e500")), video(4, 400, u("e404")), video(5, 500, u("small416"), { content_length: "5000" }),
      audio(140, u("a")),
    ] }),
  }), { ok206: { size: 1000 }, ok200: { size: 1000, ignoreRange: true }, e500: { size: 1000, status: 500 }, small416: { size: 100 }, a: { size: 1000 } });
  await using(r, async () => {
    const ids = (await r.engine.formats(VID)).formats.map((f) => f.formatId).sort();
    assert.deepEqual(ids, ["1", "140", "2", "5"]);
  });
});

test("a probe that cannot connect drops the format instead of failing the call", async () => {
  const r = await rig((u) => ({ IOS: info({ adaptive: [video(1, 360, "http://127.0.0.1:9/x"), video(2, 240, u("ok")), audio(140, u("a"))] }) }),
    { ok: { size: 1000 }, a: { size: 1000 } });
  await using(r, async () => {
    assert.deepEqual((await r.engine.formats(VID)).formats.map((f) => f.formatId), ["2", "140"]);
  });
});

test("formats without a URL are deciphered with the player, and dropped if deciphering fails", async () => {
  const r = await rig((u) => ({
    IOS: info({ adaptive: [
      { ...video(137, 1080, ""), url: undefined, decipher: async (player: any) => { assert.deepEqual(player, { fake: true }); return u("deciphered"); } },
      { ...video(136, 720, ""), url: undefined, decipher: async () => { throw new Error("no solver"); } },
      audio(140, u("a")),
    ] }),
  }), { deciphered: { size: 1000 }, a: { size: 1000 } });
  await using(r, async () => {
    const f = await r.engine.formats(VID);
    assert.deepEqual(f.formats.map((x) => x.formatId), ["137", "140"]);
    assert.ok(f.formats[0]!.url.endsWith("/m/deciphered"));
  });
});

// ---------- playback selection ----------

const ladder = (u: (k: string) => string) => info({ adaptive: [
  video(137, 1080, u("v1080")), video(136, 720, u("v720")), video(135, 480, u("v480")), video(134, 360, u("v360")),
  { ...video(247, 720, u("v720vp9")), mime_type: VP9 },
  audio(140, u("a140")), audio(251, u("a251"), { mime_type: OPUS, bitrate: 160000 }),
] });
const ladderFiles = Object.fromEntries(["v1080", "v720", "v480", "v360", "v720vp9", "a140", "a251"].map((k) => [k, { size: 1000 }]));

test("the best video at or under maxHeight is chosen, with m4a audio preferred over higher-bitrate opus", async () => {
  const r = await rig((u) => ({ IOS: ladder(u) }), ladderFiles);
  await using(r, async () => {
    const p = await r.engine.playback(VID, 720);
    assert.equal(p.height, 720);
    assert.equal(p.video.formatId, "136", "H.264 outranks VP9 at the same height");
    assert.equal(p.audio?.formatId, "140");
    assert.deepEqual(p.heights, [360, 480, 720, 1080]);
    assert.equal(p.title, "Title");
  });
});

test("maxHeight 0 means 720 and larger caps pick taller streams", async () => {
  const r = await rig((u) => ({ IOS: ladder(u) }), ladderFiles);
  await using(r, async () => {
    assert.equal((await r.engine.playback(VID, 0)).height, 720);
    assert.equal((await r.engine.playback(VID, 1080)).height, 1080);
    assert.equal((await r.engine.playback(VID, 500)).height, 480);
  });
});

test("a cap below every stream falls back to the smallest one", async () => {
  const r = await rig((u) => ({ IOS: ladder(u) }), ladderFiles);
  await using(r, async () => {
    assert.equal((await r.engine.playback(VID, 144)).height, 360);
  });
});

test("only the muxed itag 18 working: playback uses it with no separate audio", async () => {
  const r = await rig((u) => ({
    IOS: info({ formats: [muxed(18, 360, u("m18"))], adaptive: [video(137, 1080, u("v")), audio(140, u("a"))] }),
    ANDROID: info({ formats: [muxed(18, 360, u("m18"))] }),
    TV: info({}), MWEB: info({}),
  }), { m18: { size: 1000 }, v: { size: 1000, forbid: true }, a: { size: 1000, forbid: true } });
  await using(r, async () => {
    const p = await r.engine.playback(VID, 1080);
    assert.equal(p.video.formatId, "18");
    assert.equal(p.audio, null);
    assert.equal(p.height, 360);
    assert.deepEqual(p.heights, [360]);
  });
});

test("a muxed stream beats a shorter adaptive pair but not a taller one", async () => {
  const r = await rig((u) => ({ IOS: info({ formats: [muxed(22, 720, u("m22"))], adaptive: [video(135, 480, u("v480")), audio(140, u("a"))] }) }),
    { m22: { size: 1000 }, v480: { size: 1000 }, a: { size: 1000 } });
  await using(r, async () => {
    const p = await r.engine.playback(VID, 720);
    assert.equal(p.video.formatId, "22");
  });
});

test("playback with only audio formats reports that no video stream was returned", async () => {
  const r = await rig((u) => ({ IOS: info({ adaptive: [audio(140, u("a"))] }), ANDROID: info({}), TV: info({}), MWEB: info({}) }), { a: { size: 1000 } });
  await using(r, async () => {
    await assert.rejects(r.engine.playback(VID, 720), (e: Error) => e instanceof YtDlpError);
  });
});

test("formats() reports title, duration and every working format", async () => {
  const r = await rig((u) => ({ IOS: { ...ladder(u), basic_info: { duration: 95, title: "My Clip" } } }), ladderFiles);
  await using(r, async () => {
    const f = await r.engine.formats(VID);
    assert.equal(f.title, "My Clip");
    assert.equal(f.duration, 95);
    assert.equal(f.formats.length, 7);
    assert.ok(f.formats.every((x) => x.protocol === "https"));
  });
});

test("describe() names the built-in engine and id is js", async () => {
  const r = await rig(() => ({}));
  await using(r, async () => {
    assert.equal(r.engine.id, "js");
    assert.match(await r.engine.describe(), /Built-in engine/);
  });
});

// ---------- playability ----------

const problem = (status: string, reason?: string, live = false) => (_u: (k: string) => string) => ({
  IOS: info({ status, reason, live }), ANDROID: info({ status, reason, live }), TV: info({ status, reason, live }), MWEB: info({ status, reason, live }),
});

const messages: Array<[string, string, string | undefined, boolean, RegExp]> = [
  ["UNPLAYABLE", "UNPLAYABLE", "Video unavailable", false, /unavailable or blocked.*Video unavailable/],
  ["LOGIN_REQUIRED age", "LOGIN_REQUIRED", "Sign in to confirm your age", false, /age-restricted/],
  ["LOGIN_REQUIRED private", "LOGIN_REQUIRED", "This is a private video", false, /private/],
  ["LOGIN_REQUIRED generic", "LOGIN_REQUIRED", "Sign in to confirm you're not a bot", false, /asked for a sign-in/],
  ["LIVE flag", "OK", undefined, true, /live stream/],
  ["LIVE_STREAM_OFFLINE", "LIVE_STREAM_OFFLINE", "Premieres soon", false, /not available right now/],
  ["ERROR", "ERROR", "Video unavailable", false, /This video is unavailable/],
  ["unknown status", "SOMETHING_NEW", "odd", false, /cannot play this video \(SOMETHING_NEW\)/],
];
for (const [name, status, reason, live, pattern] of messages) {
  test(`playability ${name} becomes a clear YtDlpError on every entry point`, async () => {
    const r = await rig(problem(status, reason, live));
    await using(r, async () => {
      for (const call of [() => r.engine.playback(VID, 720), () => r.engine.formats(VID)]) {
        await assert.rejects(call(), (e: Error) => e instanceof YtDlpError && pattern.test(e.message));
      }
    });
  });
}

test("a playability problem on one client does not stop the next client from working", async () => {
  const r = await rig((u) => ({
    IOS: info({ status: "LOGIN_REQUIRED", reason: "Sign in" }),
    ANDROID: info({ adaptive: [video(136, 720, u("v")), audio(140, u("a"))] }),
  }), { v: { size: 1000 }, a: { size: 1000 } });
  await using(r, async () => {
    assert.equal((await r.engine.playback(VID, 720)).video.formatId, "136");
  });
});

test("the first client's playability message is the one reported", async () => {
  const r = await rig(() => ({
    IOS: info({ status: "UNPLAYABLE", reason: "first" }), ANDROID: info({ status: "ERROR", reason: "second" }),
    TV: info({ status: "ERROR", reason: "third" }), MWEB: info({ status: "ERROR", reason: "fourth" }),
  }));
  await using(r, async () => {
    await assert.rejects(r.engine.playback(VID, 720), /first/);
  });
});

test("playability errors do not throw the cached session away", async () => {
  const r = await rig(problem("UNPLAYABLE", "x"));
  await using(r, async () => {
    await assert.rejects(r.engine.playback(VID, 720));
    await assert.rejects(r.engine.playback(VID, 720));
    assert.equal(r.created(), 1);
  });
});

// ---------- sessions and errors ----------

test("the session is created once and reused", async () => {
  const r = await rig((u) => ({ IOS: info({ adaptive: [video(136, 720, u("v")), audio(140, u("a"))] }) }), { v: { size: 1000 }, a: { size: 1000 } });
  await using(r, async () => {
    await r.engine.playback(VID, 720); await r.engine.formats(VID);
    assert.equal(r.created(), 1);
  });
});

test("when every client throws, the error is wrapped and the session is rebuilt next time", async () => {
  const boom = new Error("socket hang up");
  const r = await rig(() => ({ IOS: boom, ANDROID: boom, TV: boom, MWEB: boom }));
  await using(r, async () => {
    await assert.rejects(r.engine.playback(VID, 720), (e: Error) => e instanceof YtDlpError && /Network problem: socket hang up/.test(e.message));
    await assert.rejects(r.engine.playback(VID, 720));
    assert.equal(r.created(), 2);
  });
});

test("errors that name an unavailable video are explained as such", async () => {
  const e = new Error("This video is private");
  const r = await rig(() => ({ IOS: e, ANDROID: e, TV: e, MWEB: e }));
  await using(r, async () => {
    await assert.rejects(r.engine.playback(VID, 720), /YouTube cannot play this video: This video is private/);
  });
});

test("one client throwing falls through to the next", async () => {
  const r = await rig((u) => ({
    IOS: new Error("ECONNRESET"),
    ANDROID: info({ adaptive: [video(136, 720, u("v")), audio(140, u("a"))] }),
  }), { v: { size: 1000 }, a: { size: 1000 } });
  await using(r, async () => {
    assert.equal((await r.engine.playback(VID, 720)).video.formatId, "136");
  });
});

test("when no client yields any working stream the call fails with a generic message", async () => {
  const r = await rig((u) => ({
    IOS: info({ adaptive: [video(137, 1080, u("dead"))] }), ANDROID: info({}), TV: info({}), MWEB: info({}),
  }), { dead: { size: 1000, forbid: true } });
  await using(r, async () => {
    await assert.rejects(r.engine.playback(VID, 720), (e: Error) => e instanceof YtDlpError && /no playable streams/.test(e.message));
    assert.equal(r.created(), 1);
    await assert.rejects(r.engine.playback(VID, 720));
    assert.equal(r.created(), 2, "a session that produced nothing is rebuilt");
  });
});

test("a failing session factory is reported as unreachable and retried on the next call", async () => {
  let attempts = 0;
  const yt = new FakeYt({});
  const engine = new JsEngine(() => ({ proxy: "" }), { createInnertube: async () => { attempts++; throw new Error("ENOTFOUND www.youtube.com"); } });
  void yt;
  await assert.rejects(engine.formats(VID), (e: Error) => e instanceof YtDlpError && /Network problem: ENOTFOUND/.test(e.message));
  await assert.rejects(engine.formats(VID));
  assert.equal(attempts, 8, "each call tries the session once per client, and nothing is cached after a failure");
});

test("invalid video ids are rejected before any network use", async () => {
  const r = await rig(() => ({}));
  await using(r, async () => {
    for (const bad of ["", "short", "has space!!", "way-too-long-id-x", "../etc/passwd"]) {
      await assert.rejects(r.engine.formats(bad), /Invalid YouTube video id/);
      await assert.rejects(r.engine.playback(bad, 720), /Invalid YouTube video id/);
    }
    assert.equal(r.created(), 0);
  });
});

test("the session expires after six hours", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const r = await rig((u) => ({ IOS: info({ adaptive: [video(136, 720, u("v")), audio(140, u("a"))] }) }), { v: { size: 1000 }, a: { size: 1000 } });
  try {
    await r.engine.formats(VID);
    mock.timers.setTime(1_000_000 + 5 * 3600 * 1000);
    await r.engine.formats(VID);
    assert.equal(r.created(), 1);
    mock.timers.setTime(1_000_000 + 6 * 3600 * 1000 + 1);
    await r.engine.formats(VID);
    assert.equal(r.created(), 2);
  } finally { mock.timers.reset(); await r.close(); }
});

test("the engine hands its own fetch to the session factory and honours the proxy setting lazily", async () => {
  let seenFetch: unknown = null;
  const engine = new JsEngine(() => ({ proxy: "" }), { createInnertube: async (f) => { seenFetch = f; return new FakeYt({}); } });
  await assert.rejects(engine.formats(VID));
  assert.equal(typeof seenFetch, "function");
});

// ---------- search ----------

const NODES = [
  vnode(id11(1), "One", { channel: "Chan A", seconds: 61, views: "1.2M views" }),
  { type: "Channel", id: "UCxxxxxxxxxxxxxxxxxxxxxx" },
  null,
  { type: "Video" },
  vnode(id11(2), "Two"),
  { type: "ShortsLockupView", video_id: id11(3) },
  vnode("bad id", "Bad"),
  vnode(id11(1), "Dup of one"),
];

test("search maps video nodes and skips malformed ones", async () => {
  const r = await rig(() => ({}));
  r.yt.searchImpl = async () => feed("results", [NODES]);
  await using(r, async () => {
    const out = await r.engine.search("cats");
    assert.deepEqual(out, [
      { id: id11(1), title: "One", channel: "Chan A", duration: 61, views: 1_200_000 },
      { id: id11(2), title: "Two", channel: "", duration: null, views: null },
    ]);
    assert.deepEqual(r.yt.searches[0], { query: "cats", options: { type: "video" } });
  });
});

test("an empty or blank query returns nothing and makes no request", async () => {
  const r = await rig(() => ({}));
  await using(r, async () => {
    assert.deepEqual(await r.engine.search(""), []);
    assert.deepEqual(await r.engine.search("  \n "), []);
    assert.equal(r.created(), 0);
  });
});

test("newlines in a query are flattened to spaces", async () => {
  const r = await rig(() => ({}));
  r.yt.searchImpl = async () => feed("results", [[]]);
  await using(r, async () => {
    await r.engine.search("a\nb\r\nc");
    assert.equal(r.yt.searches[0]!.query, "a b  c");
  });
});

test("paging: later pages come from the cached list and continuations are fetched only when needed", async () => {
  const mk = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => vnode(id11(a + i), "t" + (a + i)));
  const r = await rig(() => ({}));
  const continued: number[] = [];
  r.yt.searchImpl = async () => feed("results", [mk(0, 4), mk(4, 8), mk(8, 10)], (n) => continued.push(n));
  await using(r, async () => {
    const p0 = await r.engine.search("q", { page: 0, pageSize: 3 });
    assert.deepEqual(p0.map((x) => x.id), [id11(0), id11(1), id11(2)]);
    assert.deepEqual(continued, []);
    const p1 = await r.engine.search("q", { page: 1, pageSize: 3 });
    assert.deepEqual(p1.map((x) => x.id), [id11(3), id11(4), id11(5)]);
    assert.deepEqual(continued, [1]);
    const p3 = await r.engine.search("q", { page: 3, pageSize: 3 });
    assert.deepEqual(p3.map((x) => x.id), [id11(9)]);
    assert.deepEqual(continued, [1, 2]);
    assert.equal(r.yt.searches.length, 1, "only page 0 reopens the search");
    assert.deepEqual(await r.engine.search("q", { page: 9, pageSize: 3 }), []);
  });
});

test("page 0 restarts the search from scratch", async () => {
  const r = await rig(() => ({}));
  let n = 0;
  r.yt.searchImpl = async () => feed("results", [[vnode(id11(++n), "x")]]);
  await using(r, async () => {
    assert.equal((await r.engine.search("q"))[0]!.id, id11(1));
    assert.equal((await r.engine.search("q"))[0]!.id, id11(2));
  });
});

test("continuation pages are de-duplicated against earlier results", async () => {
  const r = await rig(() => ({}));
  r.yt.searchImpl = async () => feed("results", [[vnode(id11(1), "a"), vnode(id11(2), "b")], [vnode(id11(2), "b again"), vnode(id11(3), "c")]]);
  await using(r, async () => {
    const out = await r.engine.search("q", { page: 1, pageSize: 2 });
    assert.deepEqual(out.map((x) => x.id), [id11(3)]);
  });
});

test("an empty continuation ends the list", async () => {
  const r = await rig(() => ({}));
  let asked = 0;
  r.yt.searchImpl = async () => feed("results", [[vnode(id11(1), "a")], [], [vnode(id11(9), "never")]], () => asked++);
  await using(r, async () => {
    assert.equal((await r.engine.search("q", { page: 3, pageSize: 1 })).length, 0);
    assert.equal(asked, 1);
    await r.engine.search("q", { page: 4, pageSize: 1 });
    assert.equal(asked, 1, "no more requests once the list is known to be exhausted");
  });
});

test("a continuation failure still returns what was already loaded", async () => {
  const r = await rig(() => ({}));
  r.yt.searchImpl = async () => {
    const f = feed("results", [[vnode(id11(1), "a"), vnode(id11(2), "b")], []]);
    f.getContinuation = async () => { throw new Error("network down"); };
    return f;
  };
  await using(r, async () => {
    const out = await r.engine.search("q", { page: 0, pageSize: 5 });
    assert.deepEqual(out.map((x) => x.id), [id11(1), id11(2)]);
  });
});

test("a continuation failure with nothing to show is an error", async () => {
  const r = await rig(() => ({}));
  r.yt.searchImpl = async () => {
    const f = feed("results", [[vnode(id11(1), "a")], []]);
    f.getContinuation = async () => { throw new Error("ECONNRESET"); };
    return f;
  };
  await using(r, async () => {
    await assert.rejects(r.engine.search("q", { page: 1, pageSize: 1 }), (e: Error) => e instanceof YtDlpError && /YouTube search failed\. Network problem: ECONNRESET/.test(e.message));
  });
});

test("a failing search is wrapped in YtDlpError", async () => {
  const r = await rig(() => ({}));
  r.yt.searchImpl = async () => { throw new Error("kaboom"); };
  await using(r, async () => {
    await assert.rejects(r.engine.search("q"), (e: Error) => e instanceof YtDlpError && /YouTube search failed\. kaboom/.test(e.message));
  });
});

test("sort: date uses the by-date feed and a separate cache entry", async () => {
  const dateCalls: string[] = [];
  const media = await mediaServer();
  const yt = new FakeYt({});
  yt.searchImpl = async () => feed("results", [[vnode(id11(1), "relevant")]]);
  const engine = new JsEngine(() => ({ proxy: "" }), {
    createInnertube: async () => yt,
    dateSearch: async (_yt, q) => { dateCalls.push(q); return feed("results", [[vnode(id11(2), "newest")]]); },
  });
  try {
    assert.equal((await engine.search("q", { sort: "date" }))[0]!.title, "newest");
    assert.equal((await engine.search("q"))[0]!.title, "relevant");
    assert.deepEqual(dateCalls, ["q"]);
    assert.equal(yt.searches.length, 1);
  } finally { await media.close(); }
});

test("the default by-date search posts the upload-date filter to /search", async () => {
  const yt = new FakeYt({});
  const engine = new JsEngine(() => ({ proxy: "" }), { createInnertube: async () => yt });
  await assert.rejects(engine.search("lofi beats", { sort: "date" }), (e: Error) => e instanceof YtDlpError && /sentinel/.test(e.message));
  assert.deepEqual(yt.actionsCalls, [{ endpoint: "/search", args: { query: "lofi beats", params: "CAISAhAB", parse: true } }]);
});

test("LockupView results are mapped too", async () => {
  const lockup = {
    type: "LockupView", content_id: id11(7), content_type: "VIDEO",
    metadata: { title: { text: "Lockup" }, metadata: { metadata_rows: [{ metadata_parts: [{ text: { text: "Some Channel" } }] }, { metadata_parts: [{ text: { text: "5K views" } }, { text: { text: "2 days ago" } }] }] } },
    content_image: { overlays: [{ badges: [{ text: "3:25" }] }] },
  };
  const r = await rig(() => ({}));
  r.yt.searchImpl = async () => feed("results", [[lockup]]);
  await using(r, async () => {
    assert.deepEqual(await r.engine.search("q"), [{ id: id11(7), title: "Lockup", channel: "Some Channel", duration: 205, views: 5000 }]);
  });
});

// ---------- listUrl ----------

test("a playlist link lists the playlist's videos", async () => {
  const r = await rig(() => ({}));
  r.yt.playlistImpl = async () => feed("items", [[{ type: "PlaylistVideo", id: id11(1), title: { text: "P1" }, author: { name: "Uploader" }, duration: { seconds: 30 } }]]);
  await using(r, async () => {
    const out = await r.engine.listUrl("https://www.youtube.com/playlist?list=PLabc123_-xyz");
    assert.deepEqual(out, [{ id: id11(1), title: "P1", channel: "Uploader", duration: 30, views: null }]);
    assert.deepEqual(r.yt.playlists, ["PLabc123_-xyz"]);
    assert.deepEqual(r.yt.resolved, []);
  });
});

test("a watch link with a list parameter is treated as the playlist", async () => {
  const r = await rig(() => ({}));
  r.yt.playlistImpl = async () => feed("items", [[]]);
  await using(r, async () => {
    await r.engine.listUrl("https://youtube.com/watch?v=jNQXAC9IVRw&list=PL123");
    assert.deepEqual(r.yt.playlists, ["PL123"]);
  });
});

const channelFixture = (r: Rig) => {
  r.yt.channelImpl = async () => ({
    metadata: { title: "The Channel" },
    getVideos: async () => feed("videos", [[
      { type: "GridVideo", id: id11(1), title: { text: "G1" }, duration: { seconds: 10 } },
      { type: "GridVideo", id: id11(2), title: { text: "G2" }, author: { name: "Other" } },
    ]]),
  });
};

test("an @handle is resolved to a channel id and the channel name fills in missing authors", async () => {
  const r = await rig(() => ({}));
  channelFixture(r);
  r.yt.resolveImpl = async () => ({ payload: { browseId: "UC" + "b".repeat(22) } });
  await using(r, async () => {
    const out = await r.engine.listUrl("https://www.youtube.com/@somehandle/videos");
    assert.deepEqual(r.yt.resolved, ["https://www.youtube.com/@somehandle"]);
    assert.deepEqual(r.yt.channels, ["UC" + "b".repeat(22)]);
    assert.deepEqual(out.map((x) => x.channel), ["The Channel", "Other"]);
  });
});

test("a /channel/UC… link skips resolving", async () => {
  const r = await rig(() => ({}));
  channelFixture(r);
  const id = "UC" + "c".repeat(22);
  await using(r, async () => {
    await r.engine.listUrl(`youtube.com/channel/${id}`);
    assert.deepEqual(r.yt.resolved, []);
    assert.deepEqual(r.yt.channels, [id]);
  });
});

test("/c/ and /user/ links are resolved", async () => {
  const r = await rig(() => ({}));
  channelFixture(r);
  await using(r, async () => {
    await r.engine.listUrl("https://www.youtube.com/c/CustomName");
    await r.engine.listUrl("https://www.youtube.com/user/OldName");
    assert.deepEqual(r.yt.resolved, ["https://www.youtube.com/c/CustomName", "https://www.youtube.com/user/OldName"]);
  });
});

test("links that are not playlists or channels are rejected without a request", async () => {
  const r = await rig(() => ({}));
  await using(r, async () => {
    for (const bad of ["", "garbage", "https://example.com/@x", "https://www.youtube.com/watch?v=jNQXAC9IVRw", "https://www.youtube.com/channel/notvalid", "https://evil.com/youtube.com/playlist?list=PL1"]) {
      await assert.rejects(r.engine.listUrl(bad), (e: Error) => e instanceof YtDlpError && /not a YouTube playlist or channel/.test(e.message), bad);
    }
    assert.equal(r.created(), 0);
  });
});

test("an unresolvable handle says the channel was not found", async () => {
  const r = await rig(() => ({}));
  r.yt.resolveImpl = async () => ({ payload: {} });
  await using(r, async () => {
    await assert.rejects(r.engine.listUrl("https://www.youtube.com/@nobody"), /Could not find that channel/);
  });
});

test("listing failures are wrapped", async () => {
  const r = await rig(() => ({}));
  r.yt.playlistImpl = async () => { throw new Error("Playlist not found"); };
  await using(r, async () => {
    await assert.rejects(r.engine.listUrl("https://www.youtube.com/playlist?list=PLzzz"), (e: Error) => e instanceof YtDlpError && /Could not list that link\. Playlist not found/.test(e.message));
  });
});

test("playlist paging reuses the cached feed", async () => {
  const r = await rig(() => ({}));
  const mk = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => ({ type: "PlaylistVideo", id: id11(a + i), title: { text: "t" } }));
  r.yt.playlistImpl = async () => feed("items", [mk(0, 3), mk(3, 6)]);
  await using(r, async () => {
    const a = await r.engine.listUrl("https://www.youtube.com/playlist?list=PLq", { page: 0, pageSize: 2 });
    const b = await r.engine.listUrl("https://www.youtube.com/playlist?list=PLq", { page: 2, pageSize: 2 });
    assert.deepEqual(a.map((x) => x.id), [id11(0), id11(1)]);
    assert.deepEqual(b.map((x) => x.id), [id11(4), id11(5)]);
    assert.equal(r.yt.playlists.length, 1);
  });
});

test("at most eight lists are cached; the oldest is forgotten", async () => {
  const r = await rig(() => ({}));
  r.yt.searchImpl = async (q: string) => feed("results", [[vnode(id11(1), q)], [vnode(id11(2), q)]]);
  await using(r, async () => {
    for (let i = 0; i < 9; i++) await r.engine.search("q" + i);
    assert.equal(r.yt.searches.length, 9);
    // q0 was evicted: asking for its page 1 re-opens nothing (page>0 with no cache re-opens)
    await r.engine.search("q0", { page: 1, pageSize: 1 });
    assert.equal(r.yt.searches.length, 10);
    await r.engine.search("q8", { page: 1, pageSize: 1 });
    assert.equal(r.yt.searches.length, 10, "a recent list is still cached");
  });
});

// ---------- download ----------

const noop = () => undefined;
const never = () => new AbortController().signal;

function downloadRig(files: Record<string, import("./helpers/fakeyt.ts").FileMode>, formats: (u: (k: string) => string) => any[]): Promise<Rig> {
  return rig((u) => ({ IOS: info({ adaptive: formats(u) }) }), files);
}

const dlFormats = (vSize: number, aSize: number) => (u: (k: string) => string) => [
  video(137, 1080, u("vid"), { content_length: String(vSize) }),
  audio(140, u("aud"), { content_length: String(aSize) }),
];

test("download writes the exact bytes, in 8 MiB ranges, named <id>.f<itag>.<ext>", async () => {
  const vSize = 17 * MIB + 12345, aSize = 300_000;
  const r = await downloadRig({ vid: { size: vSize, seed: 3 }, aud: { size: aSize, seed: 4 } }, dlFormats(vSize, aSize));
  await using(r, async () => {
    const res = await r.engine.download(VID, ["137", "140"], noop, never());
    assert.deepEqual(res.files.map((f) => path.basename(f)), [`${VID}.f137.mp4`, `${VID}.f140.m4a`]);
    assert.ok(res.files.every((f) => path.dirname(f) === res.folder));
    assert.ok(path.basename(res.folder).startsWith("obsidian-youtube-"));
    assert.ok(res.folder.startsWith(TMP));
    assert.ok(fs.readFileSync(res.files[0]!).equals(bytesOf(3, 0, vSize)));
    assert.ok(fs.readFileSync(res.files[1]!).equals(bytesOf(4, 0, aSize)));
    const planned = planChunks(vSize, 8 * MIB).map(([a, b]) => `bytes=${a}-${b}`);
    const tail = `bytes=${vSize - 1024}-${vSize - 1}`;
    assert.deepEqual(r.media.rangesFor("vid").filter((x) => x !== tail), planned);
    fs.rmSync(res.folder, { recursive: true, force: true });
  });
});

test("files come back in the order the formats were requested", async () => {
  const r = await downloadRig({ vid: { size: 5000 }, aud: { size: 3000 } }, dlFormats(5000, 3000));
  await using(r, async () => {
    const res = await r.engine.download(VID, ["140", "137"], noop, never());
    assert.deepEqual(res.files.map((f) => path.basename(f)), [`${VID}.f140.m4a`, `${VID}.f137.mp4`]);
    fs.rmSync(res.folder, { recursive: true, force: true });
  });
});

test("progress is monotonic, within 0-100, formatted, and ends at 100%", async () => {
  const size = 3 * MIB;
  const r = await downloadRig({ vid: { size, delay: 60 }, aud: { size: 1000 } }, dlFormats(size, 1000));
  await using(r, async () => {
    const seen: DownloadProgress[] = [];
    const res = await r.engine.download(VID, ["137"], (p) => seen.push(p), never());
    assert.ok(seen.length >= 2, "expected several reports");
    let last = -1;
    for (const p of seen) {
      assert.ok(p.percent !== null && p.percent >= 0 && p.percent <= 100);
      assert.ok(p.percent >= last, "percent went backwards");
      last = p.percent;
      assert.equal(p.total, "3.00MiB");
      assert.match(p.speed, /(B\/s|Unknown B\/s)$/);
      assert.match(p.eta, /^(\d\d:\d\d(:\d\d)?|Unknown)$/);
    }
    assert.equal(seen.at(-1)!.percent, 100);
    fs.rmSync(res.folder, { recursive: true, force: true });
  });
});

test("progress of two files restarts per file and each ends at 100%", async () => {
  const r = await downloadRig({ vid: { size: 4000 }, aud: { size: 2000 } }, dlFormats(4000, 2000));
  await using(r, async () => {
    const seen: Array<number | null> = [];
    const res = await r.engine.download(VID, ["137", "140"], (p) => seen.push(p.percent), never());
    assert.ok(seen.filter((p) => p === 100).length >= 2, "each file ends at 100%");
    assert.equal(seen.at(-1), 100);
    assert.ok(seen.every((p) => p !== null && p >= 0 && p <= 100));
    fs.rmSync(res.folder, { recursive: true, force: true });
  });
});

test("a server that ignores Range and answers 200 still produces the full file", async () => {
  const size = 3 * MIB + 7;
  const r = await downloadRig({ vid: { size, ignoreRange: true, seed: 9 }, aud: { size: 10 } }, dlFormats(size, 10));
  await using(r, async () => {
    const res = await r.engine.download(VID, ["137"], noop, never());
    assert.ok(fs.readFileSync(res.files[0]!).equals(bytesOf(9, 0, size)));
    fs.rmSync(res.folder, { recursive: true, force: true });
  });
});

test("unknown sizes: the total is learned from a short final piece", async () => {
  const size = 9 * MIB + 100;
  const r = await rig((u) => ({ IOS: info({ duration: 0, adaptive: [video(137, 1080, u("vid"), { content_length: undefined, bitrate: undefined, average_bitrate: undefined }), audio(140, u("aud"))] }) }),
    { vid: { size, noTotal: true, seed: 5 }, aud: { size: 1000 } });
  await using(r, async () => {
    const seen: Array<number | null> = [];
    const res = await r.engine.download(VID, ["137"], (p) => seen.push(p.percent), never());
    assert.ok(fs.readFileSync(res.files[0]!).equals(bytesOf(5, 0, size)));
    assert.equal(seen.at(-1), 100);
    fs.rmSync(res.folder, { recursive: true, force: true });
  });
});

test("when ranges above 1 MiB answer 403 the engine drops to 1 MiB pieces", async () => {
  const size = 3 * MIB + 500;
  const r = await downloadRig({ vid: { size, maxRange: MIB, seed: 6 }, aud: { size: 1000 } }, dlFormats(size, 1000));
  await using(r, async () => {
    const res = await r.engine.download(VID, ["137"], noop, never());
    assert.ok(fs.readFileSync(res.files[0]!).equals(bytesOf(6, 0, size)));
    const ranges = r.media.rangesFor("vid");
    assert.ok(ranges.includes(`bytes=0-${8 * MIB - 1 > size ? size - 1 : 8 * MIB - 1}`), "first an 8 MiB request");
    assert.ok(ranges.includes(`bytes=0-${MIB - 1}`), "then 1 MiB");
    fs.rmSync(res.folder, { recursive: true, force: true });
  });
});

test("the reduced chunk size sticks for later downloads on the same engine", async () => {
  const size = 2 * MIB + 5;
  const r = await downloadRig({ vid: { size, maxRange: MIB }, aud: { size: 1000 } }, dlFormats(size, 1000));
  await using(r, async () => {
    const a = await r.engine.download(VID, ["137"], noop, never());
    r.media.hits.length = 0;
    const b = await r.engine.download(VID, ["137"], noop, never());
    const tail = `bytes=${size - 1024}-${size - 1}`;
    const lengths = r.media.hits.filter((h) => h.key === "vid" && h.range !== tail).map((h) => {
      const [from, to] = h.range.slice(6).split("-").map(Number) as [number, number];
      return to - from + 1;
    });
    assert.ok(lengths.length > 0 && lengths.every((n) => n <= MIB), `later downloads asked for ${lengths}`);
    for (const x of [a, b]) fs.rmSync(x.folder, { recursive: true, force: true });
  });
});

test("an aborted download rejects with 'Download cancelled.' and removes its temp folder", async () => {
  const size = 6 * MIB;
  const r = await downloadRig({ vid: { size, delay: 40 }, aud: { size: 1000 } }, dlFormats(size, 1000));
  await using(r, async () => {
    const before = leftovers().length;
    const ctl = new AbortController();
    let aborted = false;
    const p = r.engine.download(VID, ["137"], () => { if (!aborted) { aborted = true; ctl.abort(); } }, ctl.signal);
    await assert.rejects(p, (e: Error) => e instanceof YtDlpError && /Download cancelled/.test(e.message));
    assert.equal(leftovers().length, before);
  });
});

test("aborting between two files stops before the second and cleans up", async () => {
  const r = await downloadRig({ vid: { size: 5000 }, aud: { size: 5000 } }, dlFormats(5000, 5000));
  await using(r, async () => {
    const ctl = new AbortController();
    const before = leftovers().length;
    await assert.rejects(r.engine.download(VID, ["137", "140"], (p) => { if (p.percent === 100) ctl.abort(); }, ctl.signal), /cancelled/);
    assert.deepEqual(r.media.rangesFor("aud"), ["bytes=3976-4999"], "only the probe reached the second file");
    assert.equal(leftovers().length, before);
  });
});

test("an already-aborted signal fails at once, without touching the network", async () => {
  const r = await downloadRig({ vid: { size: 5000 }, aud: { size: 5000 } }, dlFormats(5000, 5000));
  await using(r, async () => {
    const ctl = new AbortController(); ctl.abort();
    await assert.rejects(r.engine.download(VID, ["137"], noop, ctl.signal), /Download cancelled/);
    assert.equal(r.created(), 0);
    assert.equal(r.media.hits.length, 0);
  });
});

test("a refusing server (HTTP 403 on data, even for small pieces) fails cleanly with a message and no folder", async () => {
  const r = await downloadRig({ vid: { size: 100000, dataStatus: 403 }, aud: { size: 1000 } }, dlFormats(100000, 1000));
  await using(r, async () => {
    const before = leftovers().length;
    await assert.rejects(r.engine.download(VID, ["137"], noop, never()), (e: Error) => e instanceof YtDlpError && /refused the download \(HTTP 403\)/.test(e.message));
    assert.equal(leftovers().length, before);
  });
});

test("HTTP 500 on data is reported once without retrying", async () => {
  const r = await downloadRig({ vid: { size: 100000, dataStatus: 500 }, aud: { size: 1000 } }, dlFormats(100000, 1000));
  await using(r, async () => {
    const before = leftovers().length;
    await assert.rejects(r.engine.download(VID, ["137"], noop, never()), (e: Error) => e instanceof YtDlpError && /HTTP 500/.test(e.message));
    assert.equal(r.media.rangesFor("vid").length, 2, "one probe and one data request");
    assert.equal(leftovers().length, before);
  });
});

test("a connection dropped mid-chunk is retried and the file still comes out exact", async () => {
  const size = 600_000;
  const r = await downloadRig({ vid: { size, dropAfter: 100_000, dropTimes: 2, seed: 8 }, aud: { size: 1000 } }, dlFormats(size, 1000));
  await using(r, async () => {
    const res = await r.engine.download(VID, ["137"], noop, never());
    assert.ok(fs.readFileSync(res.files[0]!).equals(bytesOf(8, 0, size)));
    fs.rmSync(res.folder, { recursive: true, force: true });
  });
});

test("a connection that keeps dropping fails after the retries and cleans up", async () => {
  const size = 600_000;
  const r = await downloadRig({ vid: { size, dropAfter: 50_000, dropAlways: true }, aud: { size: 1000 } }, dlFormats(size, 1000));
  await using(r, async () => {
    const before = leftovers().length;
    r.media.hits.length = 0;
    await assert.rejects(r.engine.download(VID, ["137"], noop, never()), (e: Error) => e instanceof YtDlpError);
    assert.equal(leftovers().length, before);
    assert.ok(r.media.rangesFor("vid").length >= 4, "initial attempt plus three retries");
  });
});

test("invalid ids and format ids are rejected up front", async () => {
  const r = await downloadRig({ vid: { size: 5000 }, aud: { size: 5000 } }, dlFormats(5000, 5000));
  await using(r, async () => {
    const sig = never();
    await assert.rejects(r.engine.download("bad", ["137"], noop, sig), /Invalid YouTube video id/);
    await assert.rejects(r.engine.download(VID, [], noop, sig), /Invalid format id/);
    for (const bad of ["../x", "a/b", "a b", "", "x".repeat(65), "a;rm", "é"]) {
      await assert.rejects(r.engine.download(VID, ["137", bad], noop, sig), /Invalid format id/, JSON.stringify(bad));
    }
    assert.equal(r.created(), 0);
    assert.equal(r.media.hits.length, 0);
  });
});

test("a format that is not offered fails before any folder is created", async () => {
  const r = await downloadRig({ vid: { size: 5000 }, aud: { size: 5000 } }, dlFormats(5000, 5000));
  await using(r, async () => {
    const before = leftovers().length;
    await assert.rejects(r.engine.download(VID, ["137", "999"], noop, never()), /Format 999 is no longer offered/);
    assert.equal(leftovers().length, before);
  });
});

test("download works against the muxed fallback format too", async () => {
  const r = await rig((u) => ({ IOS: info({ formats: [muxed(18, 360, u("m18"), { content_length: "20000" })] }), ANDROID: info({}), TV: info({}), MWEB: info({}) }), { m18: { size: 20000, seed: 2 } });
  await using(r, async () => {
    const res = await r.engine.download(VID, ["18"], noop, never());
    assert.equal(path.basename(res.files[0]!), `${VID}.f18.mp4`);
    assert.ok(fs.readFileSync(res.files[0]!).equals(bytesOf(2, 0, 20000)));
    fs.rmSync(res.folder, { recursive: true, force: true });
  });
});

test("webm/opus audio is saved with a .webm extension", async () => {
  const r = await rig((u) => ({ IOS: info({ adaptive: [video(137, 720, u("v")), audio(251, u("o"), { mime_type: OPUS, content_length: "4000" })] }) }), { v: { size: 1000 }, o: { size: 4000, seed: 12 } });
  await using(r, async () => {
    const res = await r.engine.download(VID, ["251"], noop, never());
    assert.equal(path.basename(res.files[0]!), `${VID}.f251.webm`);
    assert.ok(fs.readFileSync(res.files[0]!).equals(bytesOf(12, 0, 4000)));
    fs.rmSync(res.folder, { recursive: true, force: true });
  });
});

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });
