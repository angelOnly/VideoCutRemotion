import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createProjectSnapshot } from "@videocut/domain";
import { DocumentVisual } from "../packages/remotion-runtime/src/explainer-registry.js";

test("证据画面保留来源记录，只渲染作者明确填写的展示文字，缺省不留下角标底框", () => {
  const snapshot = createProjectSnapshot({ projectId: "display-test", rootPath: "isolated", name: "来源展示隔离" });
  snapshot.evidenceCaptures.push({ id: "capture", sourceAssetId: "page", sourceTitle: "内部来源标题", publisher: "内部出版方", sourceUrl: "https://example.test/internal", highlights: [{ x: 0, y: 0, width: 0.3, height: 0.2 }] } as typeof snapshot.evidenceCaptures[number]);
  const program = { id: "program", sceneId: "scene", kind: "EvidenceDocument" as const, primaryTask: "已采用标题", assetIds: [], evidenceCaptureId: "capture", status: "ready" as const, states: [], props: {} };
  const before = structuredClone(snapshot.evidenceCaptures);
  const render = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(DocumentVisual, { snapshot, mediaBaseUrl: "http://localhost", program: { ...program, props }, isUi: false }));
  const plain = render({});
  assert.doesNotMatch(plain, /内部来源标题|内部出版方|example.test|来源证据|原文重点/);
  assert.match(plain, /bottom:7%/);
  assert.doesNotMatch(plain, /top:-32px/);
  const chosen = render({ sourceCaption: "署名：已获授权作者", eyebrow: "相关条件" });
  assert.match(chosen, /署名：已获授权作者/);
  assert.match(chosen, /相关条件/);
  assert.match(chosen, /bottom:15%/);
  assert.deepEqual(snapshot.evidenceCaptures, before, "展示选择不能删除内部来源和原件信息");
});
