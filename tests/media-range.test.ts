import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "../apps/server/src/app.js";

test("受管媒体支持单范围读取，长素材拖动不需要整文件下载", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "videocut-media-range-"));
  const server = await createServer({ workspaceRoot });
  try {
    const created = server.application.createProject({ name: "媒体范围读取" });
    const relativePath = join("assets", "source", "range.bin");
    const path = join(created.snapshot.project.rootPath, relativePath);
    await mkdir(join(created.snapshot.project.rootPath, "assets", "source"), { recursive: true });
    await writeFile(path, Buffer.from("0123456789", "utf8"));
    const url = `/media/${created.snapshot.project.id}/assets/source/range.bin`;

    const full = await server.app.inject({ method: "GET", url });
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers["accept-ranges"], "bytes");
    assert.equal(full.headers["content-length"], "10");
    assert.equal(full.body, "0123456789");

    const partial = await server.app.inject({ method: "GET", url, headers: { range: "bytes=2-5" } });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.headers["content-range"], "bytes 2-5/10");
    assert.equal(partial.headers["content-length"], "4");
    assert.equal(partial.body, "2345");

    const suffix = await server.app.inject({ method: "GET", url, headers: { range: "bytes=-3" } });
    assert.equal(suffix.statusCode, 206);
    assert.equal(suffix.headers["content-range"], "bytes 7-9/10");
    assert.equal(suffix.body, "789");

    for (const range of ["bytes=10-12", "bytes=0-1,4-5", "bytes=-0"]) {
      const invalid = await server.app.inject({ method: "GET", url, headers: { range } });
      assert.equal(invalid.statusCode, 416, range);
      assert.equal(invalid.headers["content-range"], "bytes */10");
    }
  } finally {
    await server.app.close();
    server.application.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
