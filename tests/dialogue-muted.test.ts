import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../apps/server/src/app.js";
import { registerSoundTools } from "../apps/server/src/sound-tools.js";
import { createMediaAsset, createTimelineItem } from "@videocut/domain";
import { soundDependencySignature } from "../packages/media-intelligence/src/sound-signature.js";

test("Dialogue 静音经 MCP/HTTP 可逆，拒绝过期和非布尔输入，不改变素材、片段或其他音轨", async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-dialogue-muted-"));
  const { app, application } = await createServer({ workspaceRoot: root });
  const server = new McpServer({ name: "dialogue-contract", version: "1.0.0" });
  const client = new Client({ name: "dialogue-test", version: "1.0.0" });
  const projectId = application.createProject({ name: "旁白静音隔离验证" }).snapshot.project.id;
  const current = () => application.readProject(projectId);
  application.repository.commit(projectId, current().revision.number, "隔离音频夹具", snapshot => {
    const source = createMediaAsset({ name: "测试旁白", kind: "audio", managedPath: "assets/tone.wav" });
    snapshot.assets.push({ ...source, status: "ready", metadata: { durationMs: 2000, hasAudio: true } });
    snapshot.timeline.items.push(createTimelineItem({ trackId: snapshot.timeline.tracks.find(track => track.name === "Dialogue")!.id, assetId: source.id, startFrame: 0, endFrame: 48, sourceStartFrame: 0, sourceEndFrame: 48 }));
  });
  const before = current();
  registerSoundTools(server, application, () => projectId);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === "set_dialogue_muted"));
    const call = (muted: unknown, revision = current().revision.number) => client.callTool({ name: "set_dialogue_muted", arguments: { muted, base_revision_id: revision } });
    assert.equal((await call("true")).isError, true);
    assert.equal((await call(true, before.revision.number - 1)).isError, true);
    assert.equal(current().revision.number, before.revision.number);
    assert.notEqual((await call(true)).isError, true);
    const after = current();
    assert.equal(after.snapshot.timeline.tracks.find(track => track.name === "Dialogue")!.muted, true);
    assert.deepEqual(after.snapshot.timeline.items, before.snapshot.timeline.items);
    for (const key of ["assets", "script", "speechAsset", "sourceCaptionPrograms"] as const) assert.deepEqual(after.snapshot[key], before.snapshot[key]);
    assert.deepEqual(after.snapshot.timeline.tracks.filter(track => track.name !== "Dialogue"), before.snapshot.timeline.tracks.filter(track => track.name !== "Dialogue"));
    assert.notEqual(soundDependencySignature(after.snapshot), soundDependencySignature(before.snapshot));
    assert.ok(after.revision.impact.dirtyRanges.some(range => range.startFrame === 0 && range.endFrame === 48));
    assert.notEqual((await call(true)).isError, true);
    assert.equal(current().snapshot.timeline.tracks.find(track => track.name === "Dialogue")!.muted, true);
    const restored = await app.inject({ method: "POST", url: `/api/projects/${projectId}/dialogue-muted`, payload: { baseRevision: current().revision.number, muted: false } });
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(current().snapshot.timeline, before.snapshot.timeline);
  } finally {
    await client.close(); await server.close(); await app.close(); application.repository.close();
    await rm(root, { recursive: true, force: true });
  }
});
