import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const launcherPath = join(repositoryRoot, "plugins", "videoflowcut", "scripts", "candidate-runtime.mjs");
const productionWorkspace = resolve(repositoryRoot, "workspace");

function validateCandidate(arguments_: string[], environment: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [launcherPath, "validate", ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: environment
  });
}

test("候选 Runtime 必须显式隔离工作区、端口和 ComfyUI Bridge，且不会读取生产环境回退", () => {
  const workspaceRoot = resolve(repositoryRoot, ".candidate-validation", "workspace");
  const result = validateCandidate([
    "--repo-root", repositoryRoot,
    "--workspace", workspaceRoot,
    "--port", "3111",
    "--comfyui-bridge-url", "http://127.0.0.1:8199/comfyui-bridge/v1"
  ], {
    ...process.env,
    // 即使宿主环境带着生产值，候选入口也只能使用命令行中的显式边界。
    VIDEOCUT_WORKSPACE: productionWorkspace,
    VIDEOFLOWCUT_PORT: "3100",
    COMFYUI_BRIDGE_URL: "http://127.0.0.1:8188/comfyui-bridge/v1"
  });

  assert.equal(result.status, 0, result.stderr);
  const configuration = JSON.parse(result.stdout) as {
    candidate: boolean;
    validated: boolean;
    workspaceRoot: string;
    port: number;
    bridgeUrl: string;
  };
  assert.equal(configuration.candidate, true);
  assert.equal(configuration.validated, true);
  assert.equal(configuration.workspaceRoot, workspaceRoot);
  assert.equal(configuration.port, 3111);
  assert.equal(configuration.bridgeUrl, "http://127.0.0.1:8199/comfyui-bridge/v1");
});

test("候选 Runtime 对缺失或生产边界一律 fail closed", () => {
  const candidateWorkspace = resolve(repositoryRoot, ".candidate-validation", "workspace");
  const baseline = ["--repo-root", repositoryRoot];
  const cases: Array<{ name: string; arguments_: string[]; expected: RegExp }> = [
    {
      name: "缺少独立工作区",
      arguments_: ["--port", "3111", "--comfyui-bridge-url", "http://127.0.0.1:8199/comfyui-bridge/v1"],
      expected: /必须显式提供 --workspace/u
    },
    {
      name: "使用生产工作区",
      arguments_: ["--workspace", productionWorkspace, "--port", "3111", "--comfyui-bridge-url", "http://127.0.0.1:8199/comfyui-bridge/v1"],
      expected: /不能与生产工作区重叠/u
    },
    {
      name: "使用生产 Runtime 端口",
      arguments_: ["--workspace", candidateWorkspace, "--port", "3100", "--comfyui-bridge-url", "http://127.0.0.1:8199/comfyui-bridge/v1"],
      expected: /不能使用生产 Runtime 端口 3100/u
    },
    {
      name: "使用生产 ComfyUI 端口",
      arguments_: ["--workspace", candidateWorkspace, "--port", "3111", "--comfyui-bridge-url", "http://127.0.0.1:8188/comfyui-bridge/v1"],
      expected: /不能指向生产 ComfyUI 端口 8188/u
    }
  ];

  for (const scenario of cases) {
    const result = validateCandidate([...baseline, ...scenario.arguments_]);
    assert.notEqual(result.status, 0, `${scenario.name} 不应通过候选验证`);
    assert.match(result.stderr, scenario.expected, `${scenario.name} 应给出明确拒绝原因`);
  }
});

test("候选 Runtime 将当前环境的自定义生产边界仅作为 denylist", () => {
  const customProductionWorkspace = resolve(repositoryRoot, ".custom-production", "workspace");
  const candidateWorkspace = resolve(repositoryRoot, ".candidate-validation", "workspace");
  const productionEnvironment = {
    ...process.env,
    VIDEOCUT_WORKSPACE: customProductionWorkspace,
    VIDEOFLOWCUT_PORT: "4123",
    COMFYUI_BRIDGE_URL: "http://127.0.0.1:8299/comfyui-bridge/v1"
  };
  const baseline = ["--repo-root", repositoryRoot];
  const cases: Array<{ name: string; arguments_: string[]; expected: RegExp }> = [
    {
      name: "自定义生产工作区",
      arguments_: ["--workspace", customProductionWorkspace, "--port", "3111", "--comfyui-bridge-url", "http://127.0.0.1:8199/comfyui-bridge/v1"],
      expected: /不能与生产工作区重叠/u
    },
    {
      name: "自定义生产端口",
      arguments_: ["--workspace", candidateWorkspace, "--port", "4123", "--comfyui-bridge-url", "http://127.0.0.1:8199/comfyui-bridge/v1"],
      expected: /当前环境中的生产 Runtime 端口 4123/u
    },
    {
      name: "自定义生产 Bridge 端点",
      arguments_: ["--workspace", candidateWorkspace, "--port", "3111", "--comfyui-bridge-url", "http://127.0.0.1:8299/another-bridge-path"],
      expected: /当前环境中的生产 ComfyUI Bridge 共用端点/u
    }
  ];

  for (const scenario of cases) {
    const result = validateCandidate([...baseline, ...scenario.arguments_], productionEnvironment);
    assert.notEqual(result.status, 0, `${scenario.name} 不应通过候选验证`);
    assert.match(result.stderr, scenario.expected, `${scenario.name} 应被当前环境的生产边界拒绝`);
  }
});
