# ComfyUI Bridge 全部应用 HTTP 接入文档

本文覆盖当前插件发现到的全部应用：3DGenStudio、FunASR、LTX2.3、4 个 MiniMax H3 工作流、OmniVoice、Stable Audio 3 Medium，以及 2 个当前不可调用的 MiniMax 超级工作流。

## 1. 使用前提与安全边界

Bridge 基础地址为：

```text
http://127.0.0.1:8188/comfyui-bridge/v1
```

服务没有内置鉴权。只应在本机或受控内网使用；不要将 ComfyUI 端口直接暴露到公网。

工作流来源有两类：

- App Mode 工作流：`<ComfyUI 用户目录>/default/workflows/**/*.json`，只要文件存在 `extra.linearData` 就会被递归发现；
- 静态 API 工作流：插件的 `api_workflows/**/*.bridge.json`，目前包含 Trellis2 的 GLB 生成应用。

每个 App Mode 工作流将执行快照、公开输入/输出映射和源图指纹保存在同一个工作流 JSON 的 `extra.comfyuiBridge` 中。图被修改后，旧快照会保留，但其指纹不再匹配，列表会返回 `available: false`，创建任务会返回 `409`；Bridge **绝不会执行旧快照中的旧工作流**。在 ComfyUI 中等待图转换完成后正常保存一次，即会生成新快照并恢复调用。

## 2. 通用调用协议

### 2.1 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 检查 Bridge 与可调用工作流数量 |
| `GET` | `/workflows` | 列出全部工作流及可用状态 |
| `GET` | `/workflows/{workflowId}` | 获取当前输入、输出和 `schemaVersion` |
| `POST` | `/workflows/{workflowId}/runs` | 创建异步任务 |
| `GET` | `/runs/{runId}` | 查询任务状态和结果 |
| `GET` | `/runs/{runId}/outputs/{outputId}` | 下载文件结果 |

每次运行前都必须重新请求工作流详情，使用刚刚返回的 `schemaVersion`。工作流重新保存后版本会改变，不能写死。

### 2.2 请求格式

没有媒体输入的应用使用 JSON：

```json
{
  "schemaVersion": "从详情接口读取",
  "fieldValues": {
    "字段 ID": "字段值"
  }
}
```

有图片、视频或音频输入的应用使用 `multipart/form-data`：

| 表单字段 | 内容 |
| --- | --- |
| `request` | 上述 JSON 的字符串形式 |
| `file_{媒体槽位 ID}` | 对应媒体文件 |

例如媒体槽位 ID 为 `input-xxx` 时，文件字段名就是 `file_input-xxx`。可选媒体不上传时，直接不要传该字段；Bridge 会移除工作流中对应的示例媒体连线，避免错误复用示例文件。单文件上限为 512 MB。

`fieldValues` 只能填写详情接口 `fields` 中给出的 ID；省略非必填字段会保留工作流快照的默认值。

### 2.3 结果与状态

创建成功返回 HTTP `201`，响应的 `id` 是 `runId`。轮询状态包括：

| 状态 | 含义 |
| --- | --- |
| `queued` | 已提交，等待 ComfyUI 执行 |
| `running` | 正在执行 |
| `succeeded` | 完成；`outputs` 中有结果 |
| `failed` | 失败；读取 `error` |

文本结果直接包含在 `outputs[].text`。图片、视频、音频、GLB 等文件结果会包含：

```json
{
  "outputSlotId": "输出槽位 ID",
  "displayName": "输出名称",
  "kind": "image | video | audio | file",
  "fileName": "结果文件名",
  "mime": "MIME 类型",
  "outputId": "本次任务的文件 ID",
  "downloadUrl": "/comfyui-bridge/v1/runs/{runId}/outputs/{outputId}"
}
```

`downloadUrl` 是相对 ComfyUI 服务根地址的路径，应以 `http://127.0.0.1:8188` 拼接，不能再次拼接 Bridge 基础路径。任务记录和下载索引只保存在当前 ComfyUI 进程内，成功后请及时下载。

### 2.4 通用 JavaScript 调用器

下面的代码适用于本文件列出的所有可调用应用。`files` 的键为媒体槽位 ID，值为浏览器 `File` 对象；无媒体应用传空对象即可。

```js
const origin = "http://127.0.0.1:8188";
const api = `${origin}/comfyui-bridge/v1`;

async function runBridgeApplication(workflowId, fieldValues = {}, files = {}) {
  const definitionResponse = await fetch(`${api}/workflows/${workflowId}`);
  if (!definitionResponse.ok) throw new Error(await definitionResponse.text());
  const definition = await definitionResponse.json();
  if (!definition.available) throw new Error(definition.reason || "工作流当前不可调用");

  const request = {
    schemaVersion: definition.schemaVersion,
    fieldValues,
  };
  const slots = Object.keys(files);
  let response;
  if (slots.length === 0) {
    response = await fetch(`${api}/workflows/${workflowId}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } else {
    const form = new FormData();
    form.append("request", JSON.stringify(request));
    for (const [slotId, file] of Object.entries(files)) {
      form.append(`file_${slotId}`, file, file.name);
    }
    response = await fetch(`${api}/workflows/${workflowId}/runs`, {
      method: "POST",
      body: form,
    });
  }
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function waitForBridgeRun(runId) {
  while (true) {
    const response = await fetch(`${api}/runs/${runId}`);
    if (!response.ok) throw new Error(await response.text());
    const run = await response.json();
    if (run.status === "succeeded") return run;
    if (run.status === "failed") throw new Error(run.error || "ComfyUI 执行失败");
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// 文件结果下载：fetch(origin + output.downloadUrl)
```

## 3. 当前可调用应用

下方字段 ID 来自当前工作流快照，用于帮助首次接入。运行时仍以详情接口为准。

### 3.1 3DGenStudio Trellis2 Native 单图生成贴图 GLB

| 项目 | 值 |
| --- | --- |
| 工作流 ID | `3dgenstudio-trellis2-native-int8` |
| 请求方式 | multipart |
| 必填媒体 | `file_source-image`：源图片（image） |
| 输出 | `textured-glb`：带贴图 GLB（file） |

可选字段：

| 字段 ID | 含义 | 默认值 |
| --- | --- | --- |
| `target-face-count` | 目标面数 | `500000` |
| `remove-background` | 去除背景 | `true` |
| `texture-size` | 贴图尺寸 | `2048` |
| `seed` | 随机种子 | `1234` |
| `upsample-resolution` | 几何上采样分辨率 | `1536` |
| `remesh-resolution` | 重拓扑分辨率 | `768` |
| `sign-mode` | 重拓扑符号模式：`udf` / `sdf` | `udf` |
| `qef` | 启用 QEF | `false` |

该应用还依赖本机已安装 Trellis2 Native、网格保存节点及相应模型；HTTP 任务创建成功不代表模型执行一定成功，最终以任务状态为准。

### 3.2 FunASR 本地音频转文字

| 项目 | 值 |
| --- | --- |
| 工作流 ID | `dd564543-d02d-4247-9e97-089417db9e7a` |
| 请求方式 | multipart |
| 必填媒体 | `file_input-5885c94eaaaea66971d2aae7`：音频（audio） |
| 标量字段 | 无 |
| 输出 | `output-a754f8f91fab898b68713986`：文本（text） |

成功后从 `outputs` 中读取 `kind: "text"` 的 `text`，无需下载文件。

### 3.3 LTX2.3 数字人

| 项目 | 值 |
| --- | --- |
| 工作流 ID | `7f5e0c56-93b4-4937-b7f2-efd0f1853e33` |
| 请求方式 | multipart |
| 必填媒体 | `file_input-841ec65c7590d1ca16cc8693`：人物图片（image） |
| 必填媒体 | `file_input-f6b9636fc08252300e35b9d7`：驱动音频（audio） |
| 标量字段 | 无 |
| 输出 | `output-b8b44adb7d4d3baedaccf80d`：视频（通常为 MP4） |

示例：

```js
const run = await runBridgeApplication(
  "7f5e0c56-93b4-4937-b7f2-efd0f1853e33",
  {},
  {
    "input-841ec65c7590d1ca16cc8693": portraitFile,
    "input-f6b9636fc08252300e35b9d7": speechFile,
  },
);
const finished = await waitForBridgeRun(run.id);
const video = finished.outputs.find((item) => item.kind === "video");
```

### 3.4 MiniMax H3 文生视频

| 项目 | 值 |
| --- | --- |
| 工作流 ID | `4d02d4eb-a4a5-4c13-95d5-6b6a594b4daa` |
| 请求方式 | JSON |
| 媒体输入 | 无 |
| 输出 | `output-6c7fe43db63ba2c534ab2323`：视频 |

| 字段 ID | 含义 |
| --- | --- |
| `input-9cba93bc1180fbcd475a6981` | 提示词 |
| `input-ec1635efae33c980f7339d0d` | 视频时长（秒） |
| `input-82c76755986379efa7f1ed67` | 画面比例 |
| `input-3d3b5074f3c4a7ee70252e54` | 清晰度（百万像素） |
| `input-e93ffea95203063ef1b0002f` | 随机种子 |

### 3.5 MiniMax H3 图生视频

| 项目 | 值 |
| --- | --- |
| 工作流 ID | `96dac139-f645-46a7-8dc4-f8d1fb5586d9` |
| 请求方式 | multipart |
| 必填媒体 | `file_input-39357e2212d4c8cb16fa160c`：参考首帧图像（image） |
| 输出 | `output-a4afdad358a04688707ea738`：视频 |

| 字段 ID | 含义 |
| --- | --- |
| `input-430a9ac52e063fb5990c7484` | 提示词 |
| `input-78e423877b75bc90a4e52547` | 视频时长（秒） |
| `input-095fc48f851fa45251839c3f` | 画面比例 |
| `input-7bfa6da95fd6cb345d72a268` | 清晰度（百万像素） |
| `input-9ee3d0e1afb379070c9f2ece` | 随机种子 |

### 3.6 MiniMax H3 首尾帧生视频

| 项目 | 值 |
| --- | --- |
| 工作流 ID | `ffa80b03-339d-47ba-b8c4-94577d52f775` |
| 请求方式 | multipart |
| 必填媒体 | `file_input-e5410f0549b2698117eea16c`：首帧图像（image） |
| 必填媒体 | `file_input-d6a3609e515cfe83aead3c20`：尾帧图像（image） |
| 输出 | `output-c05cebe99263ebdc05e8d38e`：视频 |

| 字段 ID | 含义 |
| --- | --- |
| `input-5a2e9f7ec4073c663eccf036` | 提示词 |
| `input-b587e9be1cb4fe730baeda5f` | 视频时长（秒） |
| `input-194dc9fef7e731fe355fec7d` | 画面比例 |
| `input-685cf6ed95997eef190ff5dc` | 清晰度（百万像素） |
| `input-aa48dd9a3095a593a659cab7` | 随机种子 |

### 3.7 MiniMax H3 多参考视频

| 项目 | 值 |
| --- | --- |
| 工作流 ID | `79ae27fd-bd4d-4e67-8dc3-6fcd7e8ce09d` |
| 请求方式 | multipart |
| 输出 | `output-88829de5bdd392e91d396314`：视频 |

所有媒体槽位均为可选；按实际需要上传一个或多个，不上传的槽位不要提交：

| 文件字段 | 媒体含义 |
| --- | --- |
| `file_input-6c34d91a401708239425b2d0` | 参考图像 1 |
| `file_input-4e3badbedb0f409ad8e4c0a1` | 参考图像 2 |
| `file_input-d42f70bdf10e7e04ab77e89b` | 参考图像 3 |
| `file_input-39c9e20bfa5cdffb1507e31e` | 参考图像 4 |
| `file_input-9515c1fa94d36413a37c3267` | 参考图像 5 |
| `file_input-4155d142acb167358743f81c` | 参考图像 6 |
| `file_input-7d82d872cc299131e9b39617` | 参考视频 |
| `file_input-6a686c95af18351ff7f60862` | 参考音频 1 |
| `file_input-468f71c6757ad772bcab095f` | 参考音频 2 |
| `file_input-26a1730b22aac74d867526b7` | 参考音频 3 |

| 字段 ID | 含义 |
| --- | --- |
| `input-8a3551cf4e00e8f6c1227f21` | 提示词 |
| `input-e6d51ade08a92ce0ece3f5c6` | 视频时长（秒） |
| `input-9132a699ed38b888e08a5770` | 初采画面比例 |
| `input-2673498cfad358686687df93` | 初采清晰度（百万像素） |
| `input-39ad94877131325afab1e27e` | 最终画面比例 |
| `input-98031c4a91bceb25a4e8479e` | 最终清晰度（百万像素） |
| `input-3aedc32ad032bcc507395110` | 初采随机种子 |
| `input-30925a51399f3d64e1bc6890` | 二采随机种子 |

### 3.8 OmniVoice 自动音色克隆

| 项目 | 值 |
| --- | --- |
| 工作流 ID | `ba6238d0-3ee4-41d5-a1f4-a2aefc3933ce` |
| 请求方式 | multipart |
| 必填媒体 | `file_input-1f85f7c29fbfbb2985331aae`：参考音频（audio） |
| 输出 | `output-491586216985ba5e8fe28c56`：克隆音频 |

| 字段 ID | 含义 |
| --- | --- |
| `input-caf62e956e5d99e3e2f4b68e` | 待合成文本 |

### 3.9 Stable Audio 3 Medium 音效、环境声与无歌词音乐

| 项目 | 值 |
| --- | --- |
| 工作流 ID | `stable-audio-3-medium-v1` |
| 请求方式 | JSON |
| 媒体输入 | 无 |
| 输出 | `audio`：44.1 kHz 双声道 FLAC 音频 |

该应用使用后训练的 Medium 推理模型，不使用仅供微调的 `medium-base`。模型文件仅从国内镜像下载，并放入以下目录：

| 文件 | 本机目录 | 国内镜像地址 |
| --- | --- | --- |
| `stable_audio_3_medium.safetensors` | `ComfyUI/models/checkpoints/` | `https://hf-mirror.com/Comfy-Org/stable-audio-3/resolve/main/checkpoints/stable_audio_3_medium.safetensors` |
| `t5gemma_b_b_ul2.safetensors` | `ComfyUI/models/text_encoders/` | `https://hf-mirror.com/Comfy-Org/stable-audio-3/resolve/main/text_encoders/t5gemma_b_b_ul2.safetensors` |

| 字段 ID | 类型与规则 | 默认值 |
| --- | --- | --- |
| `prompt` | 必填文本；建议用英文描述声音、动作、材质、空间与时长 | — |
| `duration_seconds` | 数字，范围 1–120 秒；表示最大时长，生成结果可能更短 | `10` |
| `seed` | 整数，范围 0–9007199254740991 | `20260921` |

运行前必须请求 `GET /workflows/stable-audio-3-medium-v1` 并使用响应中的最新 `schemaVersion`。工作流保存后版本会变化。中文调用方应先将声音意图转换为英文提示词；此工作流不额外加载翻译或提示词扩写模型。

成功后音频输出会同时返回两个地址：`downloadUrl` 保持强制下载行为；`previewUrl` 用于直接试听，返回 `audio/flac`、`Content-Disposition: inline`，并支持 Range 请求，可作为浏览器地址或 HTML `<audio>` 的 `src`。

示例：

```js
const run = await runBridgeApplication("stable-audio-3-medium-v1", {
  prompt: "A short cinematic thunder crack followed by distant rolling thunder in a wide valley, no music.",
  duration_seconds: 8,
  seed: 2026092101,
});
const finished = await waitForBridgeRun(run.id);
const audio = finished.outputs.find((item) => item.kind === "audio");
const downloadUrl = origin + audio.downloadUrl;
const previewUrl = origin + audio.previewUrl;
```

服务端固定使用 8 步 LCM 采样与 CFG 1，不对外开放这些参数。接口会自动裁掉末尾连续静音：低于 -45 dB 且持续至少 0.35 秒的尾部静音会被移除，并保留最后有效声音后的 0.15 秒自然尾音。因此 `duration_seconds` 表示最大时长而非强制填充时长；音频中的内部停顿会原样保留。当前时长上限为 120 秒；如需提高，须先完成显存与队列压力测试。

已于 2026-09-21 完成木门关闭、远处雷暴、复古科幻按钮及蒸汽喷发共 4 次真实生成验收，结果均为 44.1 kHz 双声道 FLAC；缺少 `prompt` 返回 `400`，过期 `schemaVersion` 返回 `409`。同日完成尾部静音裁剪验收：请求 8 秒“木门关闭”音效，返回 `stable_audio_3_00006.flac` 为 5.67 秒、44.1 kHz 双声道 FLAC；使用 `silencedetect` 检查，文件末尾不存在持续至少 0.35 秒的静音。

## 4. 当前不可调用的应用

这两个文件同样会出现在 `/workflows`，但不能创建任务。它们不是被删除或隐藏，而是明确暴露修复原因。

| 工作流 ID | 应用 | 当前原因 | 恢复方法 |
| --- | --- | --- | --- |
| `24073813-2bf5-44d7-8997-14ccf86bbb18` | YZ金鱼 MiniMax H3 超级多合一工作流（官方版） | 未生成 Bridge 执行快照 | 在 ComfyUI 中打开工作流，确认 App Mode 的公开输入/输出，然后等待图转换完成并正常保存。 |
| `8088131a-5936-4f7b-aa9e-b589c5dfaa83` | YZ金鱼 MiniMax H3 超级多合一工作流（全部可用输入输出） | `expression` 公开输入无法唯一映射到执行图 | 在 App Mode 中让该公开输入只对应一个实际 Widget；若有多个同名 `expression`，分别命名或只公开正确的一个，然后正常保存。 |

修复后先请求 `GET /workflows/{workflowId}`，确认 `available` 为 `true`，再按该接口实时返回的字段重新接入。

## 5. 常见错误

| HTTP 状态 | 原因 | 处理 |
| --- | --- | --- |
| `400` | 媒体字段名错误、缺少必填媒体、提交了未知字段或字段值无效 | 重新读取详情，按 `file_{slotId}` 与 `fields` 发送。 |
| `404` | 工作流、任务或输出 ID 不存在 | 检查 ID；ComfyUI 重启后旧任务 ID 无效。 |
| `409` | `schemaVersion` 过期，或工作流快照因图变更而失效 | 重新请求详情；若 `available: false`，在 ComfyUI 重新保存工作流。 |
| `413` | 媒体文件或请求元数据超过限制 | 单个媒体文件需小于等于 512 MB。 |
| `500` / `failed` | 模型、节点、显存、编码或工作流本身执行失败 | 读取 `error`，并查看 ComfyUI 控制台日志。 |

## 6. 重启后的验收步骤

1. 重启 ComfyUI。
2. 请求 `GET /comfyui-bridge/v1/health`。
3. 请求 `GET /comfyui-bridge/v1/workflows`，确认本文件第 3 节的 9 个应用显示 `available: true`。
4. 先用 FunASR、LTX2.3 和一个 MiniMax 工作流各完成一次真实调用，确认音频上传、视频输出和可选媒体路径都正常。
5. 对需要长期保留的文件结果，立即请求其 `downloadUrl` 保存到业务侧存储。
