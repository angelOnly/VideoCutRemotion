import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import ts from "typescript";
import type { BoundMotionFont, BoundMotionImage, BoundMotionVideo, DecodedMotionVideo, MotionSubmission } from "./schema.js";
import { motionFontProps } from "./fonts.js";
import { MotionSourceValidationError } from "./source-validation-error.js";

export const MOTION_ENGINE_VERSION = "managed-motion-13";
const forbidden = new Set(["eval", "Function", "globalThis", "window", "document", "navigator", "location", "parent", "top", "opener", "self", "fetch", "XMLHttpRequest", "WebSocket", "Worker", "SharedWorker", "process", "require", "Date", "performance", "setTimeout", "setInterval", "requestAnimationFrame", "localStorage", "sessionStorage", "indexedDB", "constructor", "__proto__", "prototype"]);
const prototypeProperties = new Set(["constructor", "__proto__", "prototype"]);
const allowedImports: Record<string, Set<string>> = {
  "@videoflowcut/motion": new Set(["TimelineVideo"]),
  react: new Set(["default", "Fragment", "createElement", "useMemo"]),
  remotion: new Set(["AbsoluteFill", "Img", "Sequence", "Series", "useCurrentFrame", "useVideoConfig", "interpolate", "interpolateColors", "spring", "Easing", "random"])
};

export const motionAllowedImports = () => Object.fromEntries(Object.entries(allowedImports).map(([module, names]) => [module, [...names]]));
function importSuggestion(name: string): string {
  const hint = ["useEffect", "useState", "delayRender", "continueRender"].includes(name)
    ? "；加载字体请使用 fontBindings（先查询 read_motion_capabilities）；动画由 useCurrentFrame 驱动" : "";
  return `仅使用 read_motion_capabilities 公布的导入${hint}`;
}

/** AST 用于依赖与确定性约束；真正的执行安全还依赖 Chromium sandbox、CSP 和网络拒绝。 */
export function validateMotionSource(source: string): void {
  const file = ts.createSourceFile("motion.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const reject = (code: string, node: ts.Node, message: string, suggestion: string, position = node.getStart(file)): never => {
    const location = file.getLineAndCharacterOfPosition(position);
    throw new MotionSourceValidationError(code, message, { line: location.line + 1, column: location.character + 1 },
      ts.SyntaxKind[node.kind], node.getText(file).slice(0, 160), suggestion);
  };
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) reject("MOTION_SOURCE_INVALID", file, ts.flattenDiagnosticMessageText(diagnostics[0].messageText, " "), "修正指定位置的 TSX 语法", diagnostics[0].start ?? 0);
  // 只绑定当前源码中的词法作用域，不读取宿主文件或解析外部依赖。
  // 同名局部变量可以用于几何计算；未绑定的浏览器全局仍须拒绝。
  const checker = ts.createProgram([file.fileName], { noLib: true, noResolve: true }, {
    getSourceFile: (name) => name === file.fileName ? file : undefined,
    getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => "",
    getDirectories: () => [], fileExists: (name) => name === file.fileName,
    readFile: (name) => name === file.fileName ? source : undefined,
    getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n"
  }).getTypeChecker();
  const isLocalValue = (node: ts.Identifier) => {
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    // 类型、接口、declare 声明不会建立运行时绑定，不能据此放行浏览器全局。
    return symbol?.declarations?.some((declaration) => {
      if (!ts.isVariableDeclaration(declaration) && !ts.isParameter(declaration) && !ts.isBindingElement(declaration)
        && !ts.isFunctionDeclaration(declaration) && !ts.isFunctionExpression(declaration)
        && !ts.isClassDeclaration(declaration) && !ts.isClassExpression(declaration)
        && !ts.isImportClause(declaration) && !ts.isImportSpecifier(declaration)) return false;
      if (ts.isFunctionDeclaration(declaration) && !declaration.body) return false;
      for (let ancestor: ts.Node | undefined = declaration; ancestor; ancestor = ancestor.parent) {
        if (ts.canHaveModifiers(ancestor) && ts.getModifiers(ancestor)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return false;
        if ((ts.isImportClause(ancestor) || ts.isImportSpecifier(ancestor)) && ancestor.isTypeOnly) return false;
      }
      return declaration.getSourceFile() === file;
    }) ?? false;
  };
  // 同名字段只对可确认的数据接收者开放，不把任意对象上的 window/fetch 当成数据。
  // Props 来自平台 JSON；普通局部常量仅沿字面量与数据展开追溯，类型断言不作为证明。
  const isDataValue = (node: ts.Expression, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node) || seen.size > 32) return false;
    const next = new Set(seen).add(node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
      || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return isDataValue(node.expression, next);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
      || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)) return isDataValue(node.operand, next);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((item) => isDataValue(ts.isSpreadElement(item) ? item.expression : item, next));
    if (ts.isObjectLiteralExpression(node)) return node.properties.every((item) => {
      if (ts.isSpreadAssignment(item)) return isDataValue(item.expression, next);
      if (ts.isShorthandPropertyAssignment(item)) return isDataValue(item.name, next);
      return ts.isPropertyAssignment(item) && !ts.isComputedPropertyName(item.name)
        && !prototypeProperties.has(item.name.text) && isDataValue(item.initializer, next);
    });
    if (ts.isPropertyAccessExpression(node)) return !prototypeProperties.has(node.name.text) && isDataValue(node.expression, next);
    if (ts.isElementAccessExpression(node)) return ts.isStringLiteralLike(node.argumentExpression)
      && !prototypeProperties.has(node.argumentExpression.text) && isDataValue(node.expression, next);
    if (!ts.isIdentifier(node)) return false;
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    const declaration = symbol?.valueDeclaration;
    if (!declaration || declaration.getSourceFile() !== file || !isLocalValue(node)) return false;
    // 解构的子组件参数沿实际 JSX 调用追溯；类型标注或同名字段不能证明数据安全。
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)
      && ts.isParameter(declaration.parent.parent) && !declaration.dotDotDotToken && !declaration.initializer) {
      const parameter = declaration.parent.parent;
      const owner = parameter.parent;
      const key = declaration.propertyName ?? declaration.name;
      if ((!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner) && !ts.isFunctionDeclaration(owner))
        || owner.parameters[0] !== parameter || !ts.isIdentifier(key)) return false;
      const binding = ts.isFunctionDeclaration(owner) ? owner : owner.parent;
      if ((!ts.isVariableDeclaration(binding) && !ts.isFunctionDeclaration(binding)) || !binding.name || !ts.isIdentifier(binding.name)) return false;
      if (ts.isVariableDeclaration(binding) && (!ts.isVariableDeclarationList(binding.parent)
        || !(binding.parent.flags & ts.NodeFlags.Const))) return false;
      const component = checker.getSymbolAtLocation(binding.name);
      let uses = 0, safe = true;
      const checkUse = (candidate: ts.Node) => {
        if (ts.isIdentifier(candidate) && candidate !== binding.name && checker.getSymbolAtLocation(candidate) === component) {
          const tag = candidate.parent;
          if (ts.isJsxClosingElement(tag)) return;
          if ((!ts.isJsxOpeningElement(tag) && !ts.isJsxSelfClosingElement(tag)) || tag.tagName !== candidate) { safe = false; return; }
          const attributes = tag.attributes.properties;
          const matches = attributes.filter((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === key.text);
          const value = matches[0];
          uses++;
          if (attributes.some(ts.isJsxSpreadAttribute) || matches.length !== 1 || !value || !ts.isJsxAttribute(value)
            || !value.initializer || !ts.isJsxExpression(value.initializer) || !value.initializer.expression
            || !isDataValue(value.initializer.expression, next)) safe = false;
        }
        ts.forEachChild(candidate, checkUse);
      };
      checkUse(file);
      return uses > 0 && safe;
    }
    if (ts.isVariableDeclaration(declaration)) return ts.isVariableDeclarationList(declaration.parent)
      && Boolean(declaration.parent.flags & ts.NodeFlags.Const) && Boolean(declaration.initializer && isDataValue(declaration.initializer, next));
    if (!ts.isParameter(declaration)) return false;
    const owner = declaration.parent;
    if (!ts.isFunctionDeclaration(owner) && !ts.isFunctionExpression(owner) && !ts.isArrowFunction(owner)) return false;
    return owner.parameters[0] === declaration && (
      ts.isFunctionDeclaration(owner) && Boolean(ts.getModifiers(owner)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword))
      || ts.isExportAssignment(owner.parent) && !owner.parent.isExportEquals);
  };
  const isDataProperty = (node: ts.PropertyAccessExpression | ts.ElementAccessExpression, name: string) =>
    !prototypeProperties.has(name) && isDataValue(node.expression);
  let hasDefault = false;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const module = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : "";
      const permitted = allowedImports[module];
      if (!permitted || !node.importClause || node.importClause.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) reject("MOTION_IMPORT_REJECTED", node, `不允许此导入：${module}`, importSuggestion(module));
      if (node.importClause!.name && module !== "react") reject("MOTION_IMPORT_REJECTED", node, "仅 React 支持 default import", "其它允许模块使用已登记的具名导入");
      if (node.importClause!.namedBindings && ts.isNamedImports(node.importClause!.namedBindings)) {
        for (const entry of node.importClause!.namedBindings.elements) if (!permitted.has((entry.propertyName ?? entry.name).text)) reject("MOTION_IMPORT_REJECTED", entry, `不允许导入：${(entry.propertyName ?? entry.name).text}；${importSuggestion((entry.propertyName ?? entry.name).text)}`, importSuggestion((entry.propertyName ?? entry.name).text));
      }
    }
    if (ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) reject("MOTION_IMPORT_REJECTED", node, "不允许转导出、require 或动态 import", "使用允许模块的静态导入并直接默认导出组件");
    if (ts.isExportAssignment(node) && !node.isExportEquals || ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) hasDefault = true;
    // 名称不等于变量读取；只豁免名称节点，属性值仍继续遍历并执行 DOM 专项检查。
    const literalPropertyName = node.parent && (ts.isPropertyAssignment(node.parent) || ts.isPropertySignature(node.parent) || ts.isJsxAttribute(node.parent)) && node.parent.name === node;
    const forbiddenIdentifier = ts.isIdentifier(node) && !literalPropertyName && forbidden.has(node.text)
      && (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
        ? !isDataProperty(node.parent, node.text) : !isLocalValue(node));
    const forbiddenElement = ts.isStringLiteralLike(node) && ts.isElementAccessExpression(node.parent)
      && node.parent.argumentExpression === node && forbidden.has(node.text) && !isDataProperty(node.parent, node.text);
    if (forbiddenIdentifier || forbiddenElement) reject("MOTION_API_REJECTED", node, `不允许未绑定的全局名称或无法确认为数据的成员访问：${node.getText(file)}`, "使用显式局部值或可追溯的数据 Props；浏览器全局、原型及外部 API 不可用");
    if (ts.isPropertyAccessExpression(node) && node.expression.getText(file) === "Math" && node.name.text === "random") reject("MOTION_NONDETERMINISTIC", node, "Math.random() 不确定", "使用 Remotion random(seed)");
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(file);
      const owner = node.parent.parent;
      const tag = ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner) ? owner.tagName : undefined;
      const declaration = tag && ts.isIdentifier(tag) ? checker.getSymbolAtLocation(tag)?.valueDeclaration : undefined;
      // 本地函数组件的 src 是数据传参，最终 Img 和函数体仍逐项检查；不能仅凭大写名称放行原生标签别名。
      const localComponent = tag && ts.isIdentifier(tag) && /^[A-Z]/u.test(tag.text)
        && declaration?.getSourceFile() === file && (ts.isFunctionDeclaration(declaration) && Boolean(declaration.body)
          || ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
          && Boolean(declaration.parent.flags & ts.NodeFlags.Const) && declaration.initializer
          && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)));
      const managedImage = name === "src" && (tag?.getText(file) === "Img" || localComponent) && node.initializer && ts.isJsxExpression(node.initializer);
      if (/^on[A-Z]/u.test(name) || ["dangerouslySetInnerHTML", "href", "srcDoc"].includes(name) || name === "src" && !managedImage) reject("MOTION_DOM_REJECTED", node, "事件、HTML 或外部资源入口不可用", "图片用 Img 和 props.assets 的受管数据；移除事件、HTML 注入及外部链接");
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (["script", "iframe", "object", "embed", "link", "meta", "style", "audio", "video", "img", "canvas", "foreignObject"].includes(node.tagName.getText(file))) reject("MOTION_DOM_REJECTED", node.tagName, "原生媒体或外部嵌入标签不可用", "使用文字、CSS、SVG 或平台登记的 Img、TimelineVideo");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!hasDefault) reject("MOTION_DEFAULT_EXPORT_REQUIRED", file, "缺少默认 React 组件", "添加 export default 组件");
  const cssAnimation = /\b(?:transition|animation)\s*:/u.exec(source);
  if (cssAnimation) reject("MOTION_NONDETERMINISTIC", file, "不能使用 CSS transition/animation", "动画由 useCurrentFrame 驱动", cssAnimation.index);
}

export function motionHash(input: MotionSubmission, images: BoundMotionImage[] = [], engineVersion = MOTION_ENGINE_VERSION, videos: BoundMotionVideo[] = [], fonts: BoundMotionFont[] = []): string {
  const hash = createHash("sha256").update(engineVersion).update(JSON.stringify(input)).update(JSON.stringify(images));
  // 无视频时不追加空数组，历史作品哈希保持原样。
  if (videos.length) hash.update(JSON.stringify(videos));
  if (fonts.length) hash.update(JSON.stringify(fonts));
  return hash.digest("hex");
}
/** 旧 Job 的输入哈希保持可核验；新提交固定新引擎，不能使历史作品版本漂移。 */
export function motionHashEngine(input: MotionSubmission, images: BoundMotionImage[], version: unknown, declared?: unknown, videos: BoundMotionVideo[] = [], fonts: BoundMotionFont[] = []): string {
  const accepted = [MOTION_ENGINE_VERSION, "managed-motion-12", "managed-motion-11", "managed-motion-10", "managed-motion-9", "managed-motion-8", "managed-motion-7", "managed-motion-6", "managed-motion-5", "managed-motion-4", "managed-motion-3"];
  const engine = accepted.find((candidate) => (declared === undefined || declared === candidate) && motionHash(input, images, candidate, videos, fonts) === version);
  if (!engine) throw new Error("MOTION_VERSION_MISMATCH");
  return engine;
}

/** esbuild 只转换用户源码，不在 Node 中求值；只有受信任依赖可由文件系统解析。 */
export async function compileMotion(input: MotionSubmission, imageData: Record<string, string> = {}, videos: Record<string, DecodedMotionVideo> = {}, fonts: BoundMotionFont[] = []): Promise<string> {
  validateMotionSource(input.source);
  const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
  const entry = `import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {Player} from '@remotion/player';import {MotionRoot} from '@videoflowcut/motion';import Motion,* as motionModule from 'motion-user';
const inputProps=${JSON.stringify({ ...input.props, assets: imageData, ...(fonts.length ? { fonts: motionFontProps(fonts) } : {}) })};
window.__readMotionEvents=()=>typeof motionModule.resolveMotionEvents==='function'?motionModule.resolveMotionEvents(inputProps,{fps:${input.fps},durationInFrames:${input.durationInFrames}}):null;
const ref=React.createRef();const root=createRoot(document.getElementById('root'));
const Root=(props)=>React.createElement(MotionRoot,null,React.createElement(Motion,props));
window.__motionSeek=async(frame)=>{if(window.__motionError)throw new Error(window.__motionError);ref.current.seekTo(frame);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await document.fonts.ready;if(window.__motionError)throw new Error(window.__motionError);};
// 字体在组件首次挂载前加载；不能让首帧或初始测量先使用后备字体。
(async()=>{try{await Promise.all(${JSON.stringify(fonts)}.map(async font=>{
 const loaded=await document.fonts.load(font.style+' '+font.weight+' 16px "'+font.family+'"');
 if(!loaded.length||loaded.some(face=>face.status!=='loaded'))throw new Error('MOTION_FONT_LOAD_FAILED: '+font.fontId);
}));}catch(error){window.__motionError='MOTION_FONT_LOAD_FAILED: '+String(error);return;}
try{flushSync(()=>root.render(React.createElement(Player,{ref,component:Root,errorFallback:({error})=>{window.__motionError=String(error);return null},inputProps,durationInFrames:${input.durationInFrames},fps:${input.fps},compositionWidth:${input.width},compositionHeight:${input.height},controls:false,autoPlay:false,loop:false,style:{width:${input.width},height:${input.height}}})));
window.__motionReady=true;}catch(error){window.__motionError=String(error);}})();`;
  const result = await build({
    stdin: { contents: entry, sourcefile: "motion-entry.tsx", loader: "tsx" }, bundle: true, write: false,
    // TSX 自动引入受信任的 JSX runtime，源码无需声明未直接使用的 React 变量。
    jsx: "automatic",
    // 浏览器依赖只看到固定构建常量，不注入任何宿主环境变量。
    platform: "browser", format: "iife", minify: true, define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) }, logLevel: "silent",
    plugins: [{ name: "motion-closed-imports", setup(builder) {
      builder.onResolve({ filter: /^@videoflowcut\/motion$/ }, () => ({ path: "bound-video", namespace: "trusted-video" }));
      builder.onLoad({ filter: /.*/, namespace: "trusted-video" }, () => ({ loader: "tsx", contents: `
import React,{createContext,useContext} from 'react';import {useCurrentFrame,Img} from 'remotion';
const ranges=${JSON.stringify(Object.fromEntries(Object.entries(videos).map(([slot, video]) => [slot, {start:video.startFrame,end:video.endFrame}])))};
const FrameContext=createContext(null);
export function MotionRoot({children}){const frame=useCurrentFrame();return <FrameContext.Provider value={frame}>{children}</FrameContext.Provider>;}
export function TimelineVideo({slot,style,fit='cover',...rest}) {
 const frame=useContext(FrameContext);
 if(Object.keys(rest).length) throw new Error('MOTION_VIDEO_PROPS: 不接受视频时间偏移');
 if(!Number.isInteger(frame)||!Object.hasOwn(ranges,slot)) throw new Error('MOTION_VIDEO_RANGE: '+slot+' frame '+frame);
 if(!['cover','contain','fill'].includes(fit)) throw new Error('MOTION_VIDEO_FIT');
 if(frame<ranges[slot].start||frame>=ranges[slot].end)return null;
 return <Img src={'https://motion.invalid/video/'+slot+'/'+frame+'.png'} style={{width:'100%',height:'100%',objectFit:fit,...style}}/>;
}` }));
      builder.onResolve({ filter: /^motion-user$/ }, () => ({ path: "motion-user", namespace: "motion" }));
      builder.onLoad({ filter: /.*/, namespace: "motion" }, () => ({ contents: input.source, loader: "tsx" }));
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.namespace === "motion" && !["react", "remotion", "react/jsx-runtime"].includes(args.path)) throw new Error("MOTION_IMPORT_REJECTED");
        if (["react", "react-dom/client", "react-dom", "@remotion/player", "remotion", "react/jsx-runtime"].includes(args.path)) return { path: require.resolve(args.path) };
        return undefined;
      });
    } }]
  });
  return result.outputFiles[0].text;
}
