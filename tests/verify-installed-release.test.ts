import assert from "node:assert/strict";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = process.cwd();
const sourcePluginRoot = join(repositoryRoot, "plugins", "videoflowcut");
const verifierPath = join(sourcePluginRoot, "scripts", "verify-installed-release.mjs");

async function withInstalledSnapshot(run: (pluginRoot: string) => Promise<void>) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "videoflowcut-installed-release-"));
  const installedPluginRoot = join(temporaryRoot, "videoflowcut");
  try {
    await cp(sourcePluginRoot, installedPluginRoot, { recursive: true });
    await run(installedPluginRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function verify(installedPluginRoot: string) {
  return spawnSync(process.execPath, [verifierPath, "--installed-plugin-root", installedPluginRoot], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
}

test("安装快照与源码发行物完全一致时通过只读发布校验", async () => {
  await withInstalledSnapshot(async (installedPluginRoot) => {
    const result = verify(installedPluginRoot);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout) as {
      verified: boolean;
      source: { pluginVersion: string; releaseId: string };
      installed: { pluginVersion: string; releaseId: string };
    };
    assert.equal(evidence.verified, true);
    assert.equal(evidence.source.pluginVersion, evidence.installed.pluginVersion);
    assert.equal(evidence.source.releaseId, evidence.installed.releaseId);
  });
});

test("发布校验拒绝把源码目录伪装成已安装快照", () => {
  const result = verify(sourcePluginRoot);
  assert.notEqual(result.status, 0, "源码目录不能作为已安装插件快照通过校验");
  assert.match(result.stderr, /不能指向源码插件目录/u);
});

test("发布校验拒绝 MCP 启动器与源码不一致的安装快照", async () => {
  await withInstalledSnapshot(async (installedPluginRoot) => {
    await appendFile(join(installedPluginRoot, "scripts", "mcp-launcher.mjs"), "\n// regression: installed launcher diverged\n", "utf8");
    const result = verify(installedPluginRoot);
    assert.notEqual(result.status, 0, "旧 MCP 启动器不能作为匹配快照通过校验");
    assert.match(result.stderr, /MCP 入口不一致/u);
  });
});

test("发布校验拒绝关键 Runtime 启动脚本与源码不一致的安装快照", async () => {
  for (const script of ["repo-root.mjs", "runtime-launcher.mjs", "mcp-session.mjs", "prepare-render-browser.mjs"]) {
    await withInstalledSnapshot(async (installedPluginRoot) => {
      await appendFile(join(installedPluginRoot, "scripts", script), "\n// regression: startup chain diverged\n", "utf8");
      const result = verify(installedPluginRoot);
      assert.notEqual(result.status, 0, `${script} 漂移不能通过发布校验`);
      assert.match(result.stderr, /MCP 入口不一致/u);
    });
  }
});

test("发布校验拒绝插件声明身份与源码不一致的安装快照", async () => {
  await withInstalledSnapshot(async (installedPluginRoot) => {
    await appendFile(join(installedPluginRoot, ".codex-plugin", "plugin.json"), "\n", "utf8");
    const result = verify(installedPluginRoot);
    assert.notEqual(result.status, 0, "被改动的插件声明不能通过发布校验");
    assert.match(result.stderr, /插件 manifest 声明身份不一致/u);
  });
});

test("发布校验拒绝 captions Skill 回退到旧字幕入口的安装快照", async () => {
  await withInstalledSnapshot(async (installedPluginRoot) => {
    const captionsPath = join(installedPluginRoot, "skills", "captions", "references", "caption-operations.md");
    const captions = await readFile(captionsPath, "utf8");
    assert.match(captions, /generate_source_audio_captions/u, "测试前提：源码 Skill 必须指向当前原声字幕入口");
    await writeFile(captionsPath, captions.replace("generate_source_audio_captions", "submit_source_audio_captions"), "utf8");
    const result = verify(installedPluginRoot);
    assert.notEqual(result.status, 0, "旧字幕入口不能作为当前已安装 Skill 通过校验");
    assert.match(result.stderr, /Skills 内容树不一致/u);
  });
});

test("发布校验拒绝缺少关键 project-basics Skill 的安装快照", async () => {
  await withInstalledSnapshot(async (installedPluginRoot) => {
    await rm(join(installedPluginRoot, "skills", "project-basics", "SKILL.md"));
    const result = verify(installedPluginRoot);
    assert.notEqual(result.status, 0, "缺少项目基础合同的 Skill 快照不能通过校验");
    assert.match(result.stderr, /Skills 内容树不一致/u);
  });
});

test("发布校验拒绝运行时内容与 manifest 摘要不一致的安装快照", async () => {
  await withInstalledSnapshot(async (installedPluginRoot) => {
    await appendFile(join(installedPluginRoot, "runtime", "dist", "mcp.cjs"), "\n// regression: runtime content diverged\n", "utf8");
    const result = verify(installedPluginRoot);
    assert.notEqual(result.status, 0, "被改动的 Runtime 内容不能通过发布校验");
    assert.match(result.stderr, /manifest 无效|实际发行产物摘要不一致/u);
  });
});
