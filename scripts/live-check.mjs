// Live check of the built-in engine against the real YouTube. NOT part of `npm test` (it needs the
// network and YouTube may change): run it with `npm run test:live`.
//
//   node scripts/live-check.mjs [--proxy http://host:port] [--no-download]

import esbuild from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const proxy = args.includes("--proxy") ? args[args.indexOf("--proxy") + 1] ?? "" : "";
const skipDownload = args.includes("--no-download");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "oy-live-"));
const outfile = path.join(work, "jsengine.mjs");
await esbuild.build({
  entryPoints: ["src/jsengine.ts"], bundle: true, platform: "node", format: "esm", target: "node20", outfile, logLevel: "error",
  // youtubei.js and its dependencies are bundled; Node built-ins stay external.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const { JsEngine } = await import(pathToFileURL(outfile).href);
const engine = new JsEngine(() => ({ proxy }));

const results = [];
async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)${detail ? "  " + detail : ""}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)  ${error instanceof Error ? error.message : error}`);
  }
}
function expect(condition, message) { if (!condition) throw new Error(message); }

const VIDEOS = [
  { id: "jNQXAC9IVRw", title: /me at the zoo/i, seconds: [15, 25] },
  { id: "dQw4w9WgXcQ", title: /never gonna give you up/i, seconds: [200, 225] },
];

for (const v of VIDEOS) {
  await check(`playback ${v.id}`, async () => {
    const p = await engine.playback(v.id, 720);
    expect(p.title && v.title.test(p.title), `unexpected title ${JSON.stringify(p.title)}`);
    expect(/^https:\/\//.test(p.video.url), "video url is not https");
    expect(p.height > 0 && p.height <= 720, `height ${p.height} outside the 720 cap`);
    expect(p.video.hasAudio || (p.audio && /^https:\/\//.test(p.audio.url)), "no audio stream");
    expect(p.heights.length >= 1, "no heights");
    return `${p.height}p ${p.video.formatId}${p.audio ? "+" + p.audio.formatId : " (muxed)"} heights=[${p.heights}]`;
  });

  await check(`formats ${v.id}`, async () => {
    const f = await engine.formats(v.id);
    expect(f.formats.length > 0, "empty format list");
    expect(f.duration !== null && f.duration >= v.seconds[0] && f.duration <= v.seconds[1], `duration ${f.duration} outside ${v.seconds}`);
    expect(f.formats.some((x) => x.hasVideo), "no video format");
    expect(new Set(f.formats.map((x) => x.formatId)).size === f.formats.length, "duplicate format ids");
    return `${f.formats.length} formats, ${f.duration}s`;
  });
}

await check("search relevance", async () => {
  const r = await engine.search("me at the zoo", { pageSize: 5 });
  expect(r.length > 0, "no results");
  expect(r.every((x) => /^[\w-]{11}$/.test(x.id) && x.title), "malformed result");
  return `${r.length} results, first: ${r[0].title}`;
});

await check("search paging has no repeats across pages", async () => {
  const a = await engine.search("lofi hip hop", { page: 0, pageSize: 10 });
  const b = await engine.search("lofi hip hop", { page: 1, pageSize: 10 });
  expect(a.length === 10 && b.length > 0, `pages hold ${a.length} and ${b.length}`);
  const ids = new Set(a.map((x) => x.id));
  expect(b.every((x) => !ids.has(x.id)), "page 2 repeats page 1");
  return `${a.length} + ${b.length}`;
});

await check("search sorted by date", async () => {
  const r = await engine.search("news", { sort: "date", pageSize: 5 });
  expect(r.length > 0, "no results");
  return `${r.length} results`;
});

await check("listUrl playlist", async () => {
  const r = await engine.listUrl("https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI", { pageSize: 5 });
  expect(r.length > 0, "empty playlist");
  return `${r.length} items, first: ${r[0].title}`;
});

await check("listUrl channel handle", async () => {
  const r = await engine.listUrl("https://www.youtube.com/@jawed", { pageSize: 5 });
  expect(r.length > 0, "no videos");
  expect(r.every((x) => /^[\w-]{11}$/.test(x.id)), "malformed id");
  return `${r.length} videos, first: ${r[0].title}`;
});

await check("listUrl rejects a non-list link", async () => {
  try { await engine.listUrl("https://example.com/"); } catch (e) { return e.message; }
  throw new Error("expected a rejection");
});

await check("playback of a missing video fails clearly", async () => {
  try { await engine.playback("zzzzzzzzzzz", 720); } catch (e) { return e.message; }
  throw new Error("expected a rejection");
});

if (!skipDownload) {
  await check("download jNQXAC9IVRw (smallest video + audio) with progress and cleanup", async () => {
    const f = await engine.formats("jNQXAC9IVRw");
    const video = f.formats.filter((x) => x.hasVideo && !x.hasAudio && x.ext === "mp4").sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0]
      ?? f.formats.filter((x) => x.hasVideo).sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0];
    const audio = f.formats.find((x) => x.hasAudio && !x.hasVideo && x.ext === "m4a");
    const ids = [video.formatId, ...(video.hasAudio || !audio ? [] : [audio.formatId])];
    const reports = [];
    const out = await engine.download("jNQXAC9IVRw", ids, (p) => reports.push(p.percent), new AbortController().signal);
    try {
      expect(out.files.length === ids.length, "wrong number of files");
      for (const file of out.files) {
        const head = fs.readFileSync(file).subarray(0, 12);
        expect(fs.statSync(file).size > 10_000, `${file} is too small`);
        expect(head.includes(Buffer.from("ftyp")) || head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), `${file} does not look like mp4/webm`);
      }
      expect(reports.length > 0 && reports.at(-1) === 100, "progress did not end at 100%");
      for (let i = 1; i < reports.length; i++) expect(reports[i] >= reports[i - 1] || reports[i - 1] === 100, "progress went backwards");
      return `${out.files.map((x) => path.basename(x) + " " + fs.statSync(x).size + "B").join(", ")}`;
    } finally {
      fs.rmSync(out.folder, { recursive: true, force: true });
    }
  });

  await check("aborting a download cleans up the temp folder", async () => {
    const f = await engine.formats("dQw4w9WgXcQ");
    const best = f.formats.filter((x) => x.hasVideo).sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("obsidian-youtube-")).length;
    const ctl = new AbortController();
    const started = engine.download("dQw4w9WgXcQ", [best.formatId], () => ctl.abort(), ctl.signal);
    try { await started; } catch (e) {
      const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("obsidian-youtube-")).length;
      expect(/cancelled/i.test(e.message), "unexpected error: " + e.message);
      expect(after === before, "temp folder left behind");
      return "cancelled and cleaned";
    }
    throw new Error("download finished before the abort took effect");
  });
}

fs.rmSync(work, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} live checks passed`);
process.exit(failed ? 1 : 0);
