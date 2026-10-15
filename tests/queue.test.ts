import assert from "node:assert/strict";
import { test } from "node:test";
import { DownloadQueue, type DownloadItem, type DownloadRequest } from "../src/queue.ts";

const request = (videoId: string): DownloadRequest => ({
  videoId, title: videoId, formatIds: ["18"], audioOnly: false, label: "360p", notePath: null, embed: null,
});

/** A runner whose downloads finish only when the test says so. */
function controllable() {
  const pending = new Map<string, { resolve: (v: string[]) => void; reject: (e: Error) => void }>();
  const runner = (item: DownloadItem, signal: AbortSignal) => new Promise<string[]>((resolve, reject) => {
    pending.set(item.videoId, { resolve, reject });
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  return { pending, runner };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("runs at most two downloads at once, oldest first", async () => {
  const { pending, runner } = controllable();
  const queue = new DownloadQueue(runner, 2);
  queue.add(request("a"));
  queue.add(request("b"));
  queue.add(request("c"));
  await tick();
  assert.deepEqual([...pending.keys()], ["a", "b"]);
  assert.equal(queue.activeCount, 3);
  pending.get("a")!.resolve(["x.mp4"]);
  await tick();
  assert.deepEqual([...pending.keys()], ["a", "b", "c"]);
  const a = queue.items.find((i) => i.videoId === "a")!;
  assert.equal(a.status, "done");
  assert.deepEqual(a.saved, ["x.mp4"]);
});

test("cancel aborts a running item and skips a queued one", async () => {
  const { pending, runner } = controllable();
  const queue = new DownloadQueue(runner, 1);
  const a = queue.add(request("a"));
  const b = queue.add(request("b"));
  await tick();
  queue.cancel(b.id);
  assert.equal(b.status, "cancelled");
  queue.cancel(a.id);
  await tick();
  assert.equal(a.status, "cancelled");
  assert.equal(a.error, null);
  assert.equal(pending.has("b"), false);
});

test("failures keep their message and can be retried", async () => {
  const { pending, runner } = controllable();
  const queue = new DownloadQueue(runner, 1);
  const a = queue.add(request("a"));
  await tick();
  pending.get("a")!.reject(new Error("network down"));
  await tick();
  assert.equal(a.status, "failed");
  assert.equal(a.error, "network down");
  queue.retry(a.id);
  await tick();
  assert.equal(a.status, "downloading");
  pending.get("a")!.resolve(["ok.mp4"]);
  await tick();
  assert.equal(a.status, "done");
  queue.clearFinished();
  assert.equal(queue.items.length, 0);
});

test("listeners hear every change", async () => {
  const { pending, runner } = controllable();
  const queue = new DownloadQueue(runner, 1);
  let calls = 0;
  queue.onChange(() => calls++);
  queue.add(request("a"));
  await tick();
  pending.get("a")!.resolve([]);
  await tick();
  assert.ok(calls >= 3);
});
