import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { assertCodexMcpRegistration } from "../scripts/verify-codex-mcp-registration.mjs";

const repoRoot = process.cwd();
const installedPluginRoot = join(repoRoot, "测试安装路径", "new-release");
const mcpSpec = { command: "node", args: ["./scripts/mcp-launcher.mjs"], env: { VIDEOFLOWCUT_SFX_ROOTS: "音效" }, startup_timeout_sec: 45, tool_timeout_sec: 180 };
const options = { repoRoot, installedPluginRoot, mcpSpec };
const fixture = () => ({ name: "videoflowcut", enabled: true, disabled_reason: null,
  transport: { type: "stdio", command: "node", args: [join(installedPluginRoot, "scripts", "mcp-launcher.mjs")],
    cwd: repoRoot, env: { ...mcpSpec.env }, env_vars: [] as string[] },
  startup_timeout_sec: 45, tool_timeout_sec: 180, enabled_tools: null, disabled_tools: null });

test("宿主注册核验与真实桌面连接核验保持分离", () => {
  assert.deepEqual(assertCodexMcpRegistration(fixture(), options), {
    hostRegistrationVerified: true,
    launcher: join(installedPluginRoot, "scripts", "mcp-launcher.mjs"),
    desktopConnectionVerified: false
  });
});

test("新版已安装仍不能接受宿主指向已清理旧安装目录", () => {
  const registration = fixture();
  registration.transport.args = [join(repoRoot, "old-release", "scripts", "mcp-launcher.mjs")];
  assert.throws(() => assertCodexMcpRegistration(registration, options), /不是本次安装版/);
});

test("拒绝相对入口或不稳定安装槽工作目录", () => {
  const relative = fixture();
  relative.transport.args = ["./scripts/mcp-launcher.mjs"];
  assert.throws(() => assertCodexMcpRegistration(relative, options), /绝对入口/);
  const unstable = fixture();
  unstable.transport.cwd = installedPluginRoot;
  assert.throws(() => assertCodexMcpRegistration(unstable, options), /稳定仓库目录/);
});

test("拒绝关闭、命令改写和运行环境漂移", () => {
  const disabled = fixture();
  disabled.enabled = false;
  assert.throws(() => assertCodexMcpRegistration(disabled, options), /未启用/);
  const command = fixture();
  command.transport.command = "tsx";
  assert.throws(() => assertCodexMcpRegistration(command, options), /启动命令/);
  const environment = fixture();
  Object.assign(environment.transport.env, { VIDEOCUT_WORKSPACE: "另一队列" });
  assert.throws(() => assertCodexMcpRegistration(environment, options), /运行环境/);
  const inherited = fixture();
  inherited.transport.env_vars = ["VIDEOCUT_WORKSPACE"];
  assert.throws(() => assertCodexMcpRegistration(inherited, options), /运行环境/);
});

test("拒绝额外入口参数、超时漂移或残缺工具表", () => {
  const extra = fixture();
  extra.transport.args.push("--skip-validation");
  assert.throws(() => assertCodexMcpRegistration(extra, options), /启动路径/);
  const timeout = fixture();
  timeout.startup_timeout_sec = 1;
  assert.throws(() => assertCodexMcpRegistration(timeout, options), /超时/);
  const filtered = { ...fixture(), disabled_tools: ["manage_audio"] };
  assert.throws(() => assertCodexMcpRegistration(filtered, options), /工具过滤/);
});
