import React, { useLayoutEffect, useRef } from "react";
import { AbsoluteFill, useVideoConfig } from "remotion";

/**
 * 阶段 5 的代码型 Scene 不是让调用方提交 JSX，而是从一小组已审查的组件中选择。
 * JSON 只描述可编辑内容；Renderer 永远不会把其中任何字段当作代码、路径、样式或 URL 执行。
 */
export const RESTRICTED_SCENE_SCHEMA_VERSION = 1 as const;
export const RESTRICTED_SCENE_TEMPLATES = ["FlowMap", "MetricComparison"] as const;
export type RestrictedSceneTemplate = typeof RESTRICTED_SCENE_TEMPLATES[number];
export const RESTRICTED_SCENE_ACCENTS = ["blue", "violet", "amber"] as const;
export type RestrictedSceneAccent = typeof RESTRICTED_SCENE_ACCENTS[number];

export interface RestrictedFlowNode {
  label: string;
  detail?: string;
}

export interface RestrictedMetric {
  label: string;
  value: number;
}

interface RestrictedSceneBase {
  schemaVersion: typeof RESTRICTED_SCENE_SCHEMA_VERSION;
  template: RestrictedSceneTemplate;
  title: string;
  accent: RestrictedSceneAccent;
  /** 每个节点/指标的最短揭示间隔；只影响预置组件运动，不开放任意动画表达式。 */
  revealFrames: number;
}

export interface RestrictedFlowMapScene extends RestrictedSceneBase {
  template: "FlowMap";
  nodes: RestrictedFlowNode[];
}

export interface RestrictedMetricComparisonScene extends RestrictedSceneBase {
  template: "MetricComparison";
  metrics: RestrictedMetric[];
}

export type RestrictedSceneDefinition = RestrictedFlowMapScene | RestrictedMetricComparisonScene;

export type RestrictedSceneResolution =
  | { status: "not_requested" }
  | { status: "ready"; definition: RestrictedSceneDefinition }
  | { status: "rejected"; code: string; message: string };

const forbiddenKeys = new Set([
  "code",
  "jsx",
  "tsx",
  "script",
  "import",
  "require",
  "eval",
  "function",
  "source",
  "fragment",
  "vertex",
  "glsl",
  "wgsl",
  "src",
  "url",
  "style",
  "classname",
  "dangerouslysetinnerhtml"
]);

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const ownKeys = (value: Record<string, unknown>) => Object.keys(value);

function rejected(code: string, message: string): RestrictedSceneResolution {
  return { status: "rejected", code, message };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  const allowedKeys = new Set(allowed);
  for (const key of ownKeys(value)) {
    if (forbiddenKeys.has(key.toLowerCase())) return `字段 ${key} 不允许进入受限 Scene`;
    if (!allowedKeys.has(key)) return `字段 ${key} 不属于受限 Scene Schema`;
  }
  return undefined;
}

function text(value: unknown, name: string, options: { required?: boolean; max?: number } = {}): string | undefined {
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "string") throw new Error(`${name} 必须是文字`);
  const normalized = value.trim();
  if (options.required && !normalized) throw new Error(`${name} 不能为空`);
  if (normalized.length > (options.max ?? 120)) throw new Error(`${name} 不能超过 ${options.max ?? 120} 个字符`);
  if (/\u0000/u.test(normalized)) throw new Error(`${name} 不能包含控制字符`);
  return normalized || undefined;
}

function accent(value: unknown): RestrictedSceneAccent {
  if (value === undefined) return "blue";
  if (typeof value !== "string" || !(RESTRICTED_SCENE_ACCENTS as readonly string[]).includes(value)) {
    throw new Error("accent 只能使用已注册的 blue、violet 或 amber");
  }
  return value as RestrictedSceneAccent;
}

function revealFrames(value: unknown): number {
  if (value === undefined) return 12;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 90) {
    throw new Error("revealFrames 必须是 1 到 90 的整数");
  }
  return value;
}

function parseFlowNodes(value: unknown): RestrictedFlowNode[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) throw new Error("FlowMap 必须提供 2 到 5 个节点");
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`nodes[${index}] 必须是对象`);
    const invalidKey = hasOnlyKeys(entry, ["label", "detail"]);
    if (invalidKey) throw new Error(invalidKey);
    return {
      label: text(entry.label, `nodes[${index}].label`, { required: true, max: 48 })!,
      detail: text(entry.detail, `nodes[${index}].detail`, { max: 84 })
    };
  });
}

function parseMetrics(value: unknown): RestrictedMetric[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) throw new Error("MetricComparison 必须提供 2 到 4 个指标");
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`metrics[${index}] 必须是对象`);
    const invalidKey = hasOnlyKeys(entry, ["label", "value"]);
    if (invalidKey) throw new Error(invalidKey);
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value) || Math.abs(entry.value) > 1_000_000) {
      throw new Error(`metrics[${index}].value 必须是绝对值不超过 1000000 的有限数字`);
    }
    return { label: text(entry.label, `metrics[${index}].label`, { required: true, max: 48 })!, value: entry.value };
  });
}

/**
 * 受限 Scene 的唯一入口。未知字段、代码字段、URL、CSS 和非 JSON 对象都被拒绝，
 * 所以即使上游当前仍以 Record<string, unknown> 保存 props，也不能借此执行任意 JSX。
 */
export function resolveRestrictedScene(value: unknown): RestrictedSceneResolution {
  if (value === undefined) return { status: "not_requested" };
  if (!isRecord(value)) return rejected("RESTRICTED_SCENE_INVALID", "restrictedScene 必须是普通 JSON 对象");
  const schemaKeyError = hasOnlyKeys(value, ["schemaVersion", "template", "title", "accent", "revealFrames", "nodes", "metrics"]);
  if (schemaKeyError) return rejected("RESTRICTED_SCENE_FIELD_FORBIDDEN", schemaKeyError);
  if (value.schemaVersion !== RESTRICTED_SCENE_SCHEMA_VERSION) {
    return rejected("RESTRICTED_SCENE_SCHEMA_UNSUPPORTED", `仅支持 schemaVersion=${RESTRICTED_SCENE_SCHEMA_VERSION}`);
  }
  if (typeof value.template !== "string" || !(RESTRICTED_SCENE_TEMPLATES as readonly string[]).includes(value.template)) {
    return rejected("RESTRICTED_SCENE_TEMPLATE_UNSUPPORTED", "template 必须是已注册的 FlowMap 或 MetricComparison");
  }
  try {
    const base = {
      schemaVersion: RESTRICTED_SCENE_SCHEMA_VERSION,
      template: value.template as RestrictedSceneTemplate,
      title: text(value.title, "title", { required: true, max: 72 })!,
      accent: accent(value.accent),
      revealFrames: revealFrames(value.revealFrames)
    };
    if (base.template === "FlowMap") {
      if (value.metrics !== undefined) return rejected("RESTRICTED_SCENE_TEMPLATE_FIELDS", "FlowMap 不接受 metrics");
      return { status: "ready", definition: { ...base, template: "FlowMap", nodes: parseFlowNodes(value.nodes) } };
    }
    if (value.nodes !== undefined) return rejected("RESTRICTED_SCENE_TEMPLATE_FIELDS", "MetricComparison 不接受 nodes");
    return { status: "ready", definition: { ...base, template: "MetricComparison", metrics: parseMetrics(value.metrics) } };
  } catch (error) {
    return rejected("RESTRICTED_SCENE_INVALID", error instanceof Error ? error.message : "restrictedScene 无法解析");
  }
}

/**
 * Shader 只开放内置、审查过的 WebGL 模板。调用方不能提交 GLSL/WGSL、URL 或 JSX，
 * 这样既能得到真实 GPU 着色效果，也不会把任意代码带进 Player / Render Worker。
 */
export type AdvancedVisualFeature = "shader" | "complex_3d";
export const CURATED_SHADER_TEMPLATES = ["aurora_mesh", "signal_grid"] as const;
export type CuratedShaderTemplate = typeof CURATED_SHADER_TEMPLATES[number];
export const CURATED_SHADER_INTENSITIES = ["subtle", "medium"] as const;
export type CuratedShaderIntensity = typeof CURATED_SHADER_INTENSITIES[number];

export interface CuratedShaderDefinition {
  template: CuratedShaderTemplate;
  accent: RestrictedSceneAccent;
  intensity: CuratedShaderIntensity;
}

export type AdvancedVisualResolution =
  | { status: "not_requested" }
  | { status: "ready"; feature: "shader"; definition: CuratedShaderDefinition }
  | { status: "rejected"; feature: AdvancedVisualFeature; code: string; message: string; fallback: "registered_scene" | "pre_rendered_project_asset" }
  | { status: "degraded"; feature: "complex_3d"; assetId: string; message: string; fallback: "pre_rendered_project_asset" };

export const ADVANCED_VISUAL_RUNTIME_CAPABILITIES = {
  shader: {
    status: "curated_webgl",
    reason: "当前只允许内置 WebGL 模板；不接受任意 GLSL/WGSL、网络资源或用户代码",
    templates: CURATED_SHADER_TEMPLATES
  },
  complex3d: {
    status: "pre_rendered_asset_only",
    reason: "当前 Remotion Runtime 未安装并验证 Three/3D 场景运行时；只能播放已审核的项目内预渲染素材"
  }
} as const;

function resolveCuratedShader(value: Record<string, unknown>): AdvancedVisualResolution {
  // source / glsl 等字段必须明确报错，不能让调用方误以为提交的自定义着色器被悄悄忽略。
  if (["source", "fragment", "vertex", "glsl", "wgsl"].some((key) => key in value)) {
    return {
      status: "rejected",
      feature: "shader",
      code: "SHADER_SOURCE_FORBIDDEN",
      message: "Shader 只允许选择已注册模板，不能提交 GLSL、WGSL 或其它源码",
      fallback: "registered_scene"
    };
  }
  const invalidKey = hasOnlyKeys(value, ["feature", "template", "accent", "intensity"]);
  if (invalidKey) {
    return { status: "rejected", feature: "shader", code: "SHADER_SCHEMA_INVALID", message: invalidKey, fallback: "registered_scene" };
  }
  if (typeof value.template !== "string" || !(CURATED_SHADER_TEMPLATES as readonly string[]).includes(value.template)) {
    return {
      status: "rejected",
      feature: "shader",
      code: "SHADER_TEMPLATE_UNSUPPORTED",
      message: "Shader template 必须是已注册的 aurora_mesh 或 signal_grid",
      fallback: "registered_scene"
    };
  }
  if (value.intensity !== undefined && (typeof value.intensity !== "string" || !(CURATED_SHADER_INTENSITIES as readonly string[]).includes(value.intensity))) {
    return {
      status: "rejected",
      feature: "shader",
      code: "SHADER_INTENSITY_INVALID",
      message: "Shader intensity 只能使用 subtle 或 medium",
      fallback: "registered_scene"
    };
  }
  try {
    return {
      status: "ready",
      feature: "shader",
      definition: {
        template: value.template as CuratedShaderTemplate,
        accent: accent(value.accent),
        intensity: (value.intensity ?? "subtle") as CuratedShaderIntensity
      }
    };
  } catch (error) {
    return {
      status: "rejected",
      feature: "shader",
      code: "SHADER_SCHEMA_INVALID",
      message: error instanceof Error ? error.message : "Shader 参数无法解析",
      fallback: "registered_scene"
    };
  }
}

/**
 * 此函数只做能力协商，不信任或解析任何外部 Shader/3D 源码。complex_3d 的 assetId
 * 仍须由上层 Project Asset Resolver 验证为已就绪的本地预渲染 Asset 后才可真正绑定。
 */
export function resolveAdvancedVisualRequest(value: unknown): AdvancedVisualResolution {
  if (value === undefined) return { status: "not_requested" };
  if (!isRecord(value) || typeof value.feature !== "string") {
    return { status: "rejected", feature: "shader", code: "ADVANCED_VISUAL_INVALID", message: "advancedVisual 必须声明受支持的 feature", fallback: "registered_scene" };
  }
  if (value.feature === "shader") {
    return resolveCuratedShader(value);
  }
  if (value.feature !== "complex_3d") {
    return { status: "rejected", feature: "shader", code: "ADVANCED_VISUAL_FEATURE_UNSUPPORTED", message: "advancedVisual.feature 仅允许 shader 或 complex_3d", fallback: "registered_scene" };
  }
  const invalidKey = hasOnlyKeys(value, ["feature", "preRenderedAssetId"]);
  if (invalidKey) {
    return { status: "rejected", feature: "complex_3d", code: "COMPLEX_3D_SOURCE_FORBIDDEN", message: invalidKey, fallback: "pre_rendered_project_asset" };
  }
  const assetId = typeof value.preRenderedAssetId === "string" ? value.preRenderedAssetId.trim() : "";
  // Asset ID 是领域对象标识，不接受路径、URL、空白片段或任意模型文件名。
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(assetId)) {
    return {
      status: "rejected",
      feature: "complex_3d",
      code: "COMPLEX_3D_PRE_RENDER_REQUIRED",
      message: "复杂三维当前只能引用一个项目内预渲染 Asset ID，不能提交模型路径或源码",
      fallback: "pre_rendered_project_asset"
    };
  }
  return {
    status: "degraded",
    feature: "complex_3d",
    assetId,
    message: "当前按预渲染项目素材降级；未启用 Three/3D 实时场景。",
    fallback: "pre_rendered_project_asset"
  };
}

const palettes: Record<RestrictedSceneAccent, { accent: string; soft: string; foreground: string }> = {
  blue: { accent: "#79a9ff", soft: "#244979", foreground: "#f6f9ff" },
  violet: { accent: "#c7a1ff", soft: "#4d3677", foreground: "#fbf7ff" },
  amber: { accent: "#ffcb72", soft: "#704e20", foreground: "#fffaf1" }
};

const shaderVertexSource = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

/** 所有 Fragment Shader 均硬编码在 Runtime 内；上游 props 永远不能改变这段程序。 */
const shaderFragmentSources: Record<CuratedShaderTemplate, string> = {
  aurora_mesh: `
precision mediump float;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_accent;
uniform float u_intensity;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 p = uv - 0.5;
  p.x *= u_resolution.x / u_resolution.y;
  float waveA = sin(p.x * 3.4 + u_time * 0.52 + sin(p.y * 3.0));
  float waveB = cos(p.y * 5.2 - u_time * 0.38 + p.x * 1.7);
  float mesh = smoothstep(-1.0, 1.0, waveA * waveB);
  float halo = 1.0 - smoothstep(0.08, 0.95, length(p + vec2(sin(u_time * 0.2) * 0.12, -0.05)));
  vec3 base = vec3(0.025, 0.045, 0.095);
  vec3 color = base + u_accent * (0.14 + 0.34 * mesh * u_intensity + 0.24 * halo * u_intensity);
  gl_FragColor = vec4(color, 1.0);
}`,
  signal_grid: `
precision mediump float;
uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_accent;
uniform float u_intensity;
float line(float coordinate, float width) {
  return 1.0 - smoothstep(width, width + 0.0035, abs(fract(coordinate) - 0.5));
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 grid = uv * vec2(10.0, 16.0);
  float gridLine = max(line(grid.x, 0.012), line(grid.y, 0.012));
  float scan = 0.5 + 0.5 * sin((uv.y * 19.0 - u_time * 1.1) * 3.14159);
  float pulse = 0.5 + 0.5 * sin((uv.x * 4.0 + uv.y * 3.0 + u_time * 0.28) * 6.28318);
  vec3 base = vec3(0.018, 0.03, 0.065);
  vec3 color = base + u_accent * ((gridLine * 0.2 + scan * 0.06 + pulse * 0.09) * u_intensity);
  gl_FragColor = vec4(color, 1.0);
}`
};

const shaderPalette: Record<RestrictedSceneAccent, [number, number, number]> = {
  blue: [0.475, 0.663, 1],
  violet: [0.78, 0.631, 1],
  amber: [1, 0.796, 0.447]
};

type CuratedShaderRuntime = {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer;
  position: number;
  resolution: WebGLUniformLocation | null;
  time: WebGLUniformLocation | null;
  accent: WebGLUniformLocation | null;
  intensity: WebGLUniformLocation | null;
};

function compileWebGlShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("无法创建内置 Shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "未知编译错误";
    gl.deleteShader(shader);
    throw new Error(`内置 Shader 编译失败：${message}`);
  }
  return shader;
}

function createCuratedShaderRuntime(canvas: HTMLCanvasElement, definition: CuratedShaderDefinition): CuratedShaderRuntime {
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("当前浏览器不支持项目内置 WebGL Shader");
  const vertex = compileWebGlShader(gl, gl.VERTEX_SHADER, shaderVertexSource);
  const fragment = compileWebGlShader(gl, gl.FRAGMENT_SHADER, shaderFragmentSources[definition.template]);
  const program = gl.createProgram();
  if (!program) throw new Error("无法创建内置 Shader Program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "未知链接错误";
    gl.deleteProgram(program);
    throw new Error(`内置 Shader 链接失败：${message}`);
  }
  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    throw new Error("无法创建内置 Shader 顶点缓冲");
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  return {
    gl,
    program,
    buffer,
    position: gl.getAttribLocation(program, "a_position"),
    resolution: gl.getUniformLocation(program, "u_resolution"),
    time: gl.getUniformLocation(program, "u_time"),
    accent: gl.getUniformLocation(program, "u_accent"),
    intensity: gl.getUniformLocation(program, "u_intensity")
  };
}

/**
 * 真实 WebGL Canvas 只接收已解析的受控定义。逐帧值由 Remotion 的局部时间提供，
 * 没有 requestAnimationFrame、随机数、网络请求或调用方注入源码，因此 Player 和 Render
 * 可在同一个帧号得到同一结果。
 */
export const CuratedShaderVisual: React.FC<{ definition: CuratedShaderDefinition; localFrame: number; title: string }> = ({ definition, localFrame, title }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<CuratedShaderRuntime | undefined>(undefined);
  const { width, height, fps } = useVideoConfig();

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const runtime = createCuratedShaderRuntime(canvas, definition);
    runtimeRef.current = runtime;
    return () => {
      runtime.gl.deleteBuffer(runtime.buffer);
      runtime.gl.deleteProgram(runtime.program);
      if (runtimeRef.current === runtime) runtimeRef.current = undefined;
    };
  }, [definition.template]);

  useLayoutEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const { gl } = runtime;
    gl.viewport(0, 0, width, height);
    gl.useProgram(runtime.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, runtime.buffer);
    gl.enableVertexAttribArray(runtime.position);
    gl.vertexAttribPointer(runtime.position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(runtime.resolution, width, height);
    gl.uniform1f(runtime.time, localFrame / Math.max(1, fps));
    gl.uniform3fv(runtime.accent, shaderPalette[definition.accent]);
    gl.uniform1f(runtime.intensity, definition.intensity === "medium" ? 1 : 0.58);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }, [definition.accent, definition.intensity, fps, height, localFrame, width]);

  return <AbsoluteFill aria-label={`内置 Shader：${definition.template}`} style={{ overflow: "hidden", background: "#07101c" }}>
    <canvas ref={canvasRef} width={width} height={height} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
    <div style={{ position: "absolute", left: "9%", right: "9%", top: "10%", color: "#f5f8ff", fontFamily: "Inter, Noto Sans SC, sans-serif", fontSize: Math.max(36, Math.round(width * 0.043)), fontWeight: 850, lineHeight: 1.14, textShadow: "0 3px 18px #000b" }}>{title}</div>
    <div style={{ position: "absolute", left: "9%", bottom: "10%", padding: "8px 13px", borderRadius: 999, border: "1px solid #ffffff44", color: "#edf4ff", background: "#07111aaa", fontFamily: "Inter, Noto Sans SC, sans-serif", fontSize: Math.max(14, Math.round(width * 0.015)), fontWeight: 700 }}>内置视觉层 · {definition.template === "aurora_mesh" ? "关系渐变" : "信号网格"}</div>
  </AbsoluteFill>;
};

function revealStyle(localFrame: number, index: number, revealEvery: number): React.CSSProperties {
  const progress = Math.max(0, Math.min(1, (localFrame - index * revealEvery) / Math.max(1, Math.min(10, revealEvery))));
  return { opacity: progress, transform: `translateY(${Math.round((1 - progress) * 22)}px)` };
}

/**
 * 已审查组件的实际渲染实现。它只消费 resolveRestrictedScene 产出的定义，
 * 从类型上阻断 raw props 直接进入 CSS、元素名、组件名或媒体加载器。
 */
export const RestrictedSceneVisual: React.FC<{ definition: RestrictedSceneDefinition; localFrame: number }> = ({ definition, localFrame }) => {
  const palette = palettes[definition.accent];
  if (definition.template === "FlowMap") {
    return <AbsoluteFill aria-label="受限 FlowMap 场景" style={{ padding: "7.5%", color: palette.foreground, background: "linear-gradient(145deg,#0d1525,#182d4a)", fontFamily: "Inter, Noto Sans SC, sans-serif" }}>
      <div style={{ fontSize: 46, fontWeight: 850, lineHeight: 1.13 }}>{definition.title}</div>
      <div style={{ position: "absolute", left: "8%", right: "8%", top: "42%", display: "flex", alignItems: "stretch", gap: 12 }}>
        {definition.nodes.map((node, index) => <React.Fragment key={`${node.label}-${index}`}>
          <div style={{ ...revealStyle(localFrame, index, definition.revealFrames), flex: 1, minHeight: 162, padding: 20, display: "grid", alignContent: "space-between", borderRadius: 18, background: palette.soft, border: `1px solid ${palette.accent}66` }}>
            <strong style={{ fontSize: 27, lineHeight: 1.2 }}>{node.label}</strong>
            {node.detail && <span style={{ marginTop: 16, color: `${palette.foreground}cc`, fontSize: 16, lineHeight: 1.35 }}>{node.detail}</span>}
          </div>
          {index < definition.nodes.length - 1 && <div aria-hidden style={{ ...revealStyle(localFrame, index + 1, definition.revealFrames), alignSelf: "center", color: palette.accent, fontSize: 36 }}>→</div>}
        </React.Fragment>)}
      </div>
    </AbsoluteFill>;
  }
  const max = Math.max(1, ...definition.metrics.map((metric) => Math.abs(metric.value)));
  return <AbsoluteFill aria-label="受限 MetricComparison 场景" style={{ padding: "7.5%", color: palette.foreground, background: "linear-gradient(145deg,#101526,#24213f)", fontFamily: "Inter, Noto Sans SC, sans-serif" }}>
    <div style={{ fontSize: 46, fontWeight: 850, lineHeight: 1.13 }}>{definition.title}</div>
    <div style={{ position: "absolute", left: "10%", right: "10%", top: "34%", bottom: "14%", display: "grid", alignItems: "end", gridTemplateColumns: `repeat(${definition.metrics.length}, minmax(0, 1fr))`, gap: 22, borderBottom: `2px solid ${palette.accent}` }}>
      {definition.metrics.map((metric, index) => {
        const height = Math.max(5, Math.round(Math.abs(metric.value) / max * 100));
        return <div key={`${metric.label}-${index}`} style={{ ...revealStyle(localFrame, index, definition.revealFrames), height: "100%", display: "flex", flexDirection: "column", justifyContent: "end", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 24, fontWeight: 830 }}>{metric.value}</span>
          <div style={{ width: "76%", height: `${height}%`, minHeight: 10, borderRadius: "14px 14px 0 0", background: metric.value < 0 ? "#ee7d8e" : palette.accent }} />
          <span style={{ minHeight: 42, fontSize: 18, textAlign: "center", lineHeight: 1.2 }}>{metric.label}</span>
        </div>;
      })}
    </div>
  </AbsoluteFill>;
};
