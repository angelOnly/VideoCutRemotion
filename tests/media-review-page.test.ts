import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createServer } from "../apps/server/src/app.js";
import { mediaReviewPage } from "../apps/server/src/media-review-page.js";

test("只读审阅路由保留媒体 Range 服务并拒绝越界、缺失和非媒体路径", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vfc-review-page-"));
  const server = await createServer({ workspaceRoot });
  try {
    const created = server.application.createProject({ name: "播放器回归", profile: "presenter_motion" });
    const projectId = created.snapshot.project.id;
    const directory = join(created.snapshot.project.rootPath, "previews");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "a & b.mp4"), "0123456789");
    await writeFile(join(directory, "plain.txt"), "文字");
    const path = `${projectId}/previews/a%20%26%20b.mp4`;
    const response = await server.app.inject({ url: `/review/${path}` });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /text\/html/u);
    assert.match(String(response.headers["content-security-policy"]), /default-src 'none'/u);
    assert.match(response.body, /a &amp; b.mp4/u);
    assert.match(response.body, /id="play"/u);
    assert.doesNotMatch(response.body, /<video[^>]*\bcontrols\b/u);
    const media = await server.app.inject({ url: `/media/${path}`, headers: { range: "bytes=2-5" } });
    assert.equal(media.statusCode, 206);
    assert.equal(media.body, "2345");
    for (const invalid of [`${projectId}/previews/missing.mp4`, `${projectId}/previews/plain.txt`, "%2e%2e%5coutside.mp4"]) {
      assert.ok((await server.app.inject({ url: `/review/${invalid}` })).statusCode >= 400);
    }
    assert.equal(server.application.readProject(projectId).revision.number, created.revision.number);
    assert.equal(server.application.listJobs(projectId).length, 0);
  } finally {
    await server.app.close(); server.application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("审阅控件处理播放、暂停、重播、进度和真实解码失败，不依赖原生控件", async () => {
  // 用事件驱动的媒体对象检查浏览器合同；实际解码和宿主稳定性另在候选版验证。
  const elements: Record<string, any> = {};
  for (const id of ["media", "play", "replay", "seek", "time", "error", "loop"]) {
    elements[id] = { listeners: {} as Record<string, (event?: any) => void>, textContent: "", addEventListener(event: string, callback: () => void) { this.listeners[event] = callback; } };
  }
  const media = elements.media;
  Object.assign(media, { duration: NaN, currentTime: 0, paused: true, ended: false,
    async play() { media.paused = false; media.listeners.play(); },
    pause() { media.paused = true; media.listeners.pause(); } });
  const html = mediaReviewPage("/media/p/test.mp4", "</script><script>bad()</script>", "video", "test-nonce");
  assert.doesNotMatch(html, /<script>bad\(\)/u);
  const script = html.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/u)![1];
  runInNewContext(script, { document: { getElementById: (id: string) => elements[id] } });
  assert.equal(elements.play.disabled, true);
  media.duration = 5; media.listeners.loadedmetadata();
  assert.equal(elements.play.disabled, false);
  elements.play.listeners.click(); await Promise.resolve();
  assert.equal(elements.play.textContent, "暂停");
  elements.play.listeners.click();
  assert.equal(elements.play.textContent, "播放");
  elements.seek.value = "3"; elements.seek.listeners.input();
  assert.equal(media.currentTime, 3);
  elements.replay.listeners.click(); await Promise.resolve();
  assert.equal(media.currentTime, 0);
  elements.loop.listeners.change({ target: { checked: true } });
  assert.equal(media.loop, true);
  media.error = { code: 3 }; media.listeners.error();
  assert.match(elements.error.textContent, /解码失败.*3/u);
  assert.equal(elements.play.disabled, true);
});
