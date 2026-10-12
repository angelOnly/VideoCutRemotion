import assert from "node:assert/strict";
import test from "node:test";
import { validateMotionSource, motionHash, motionHashEngine } from "../packages/motion-work/src/compiler.js";
import { motionFixture } from "./fixtures/managed-motion.js";
import { renderManagedMotion } from "../apps/render-worker/src/motion-renderer.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";

test("自动 JSX 运行时可实际渲染无 React 导入的组件，旧身份仍可核验", {timeout:60_000}, async () => {
  const root=await mkdtemp(join(tmpdir(),"motion-auto-jsx-"));
  try {
    const source=`const Caption=({cue})=><div style={{position:'absolute',top:cue.top,left:0,width:320,height:320,background:'#00ff00'}}/>;export default props=><Caption cue={props.cue}/>;`;
    const input={...motionFixture,source,props:{cue:{top:0}},durationInFrames:2};
    const result=await renderManagedMotion(input,root);
    const png=PNG.sync.read(await readFile(join(root,'frames/frame-00000.png')));
    assert.deepEqual([...png.data.subarray(0,4)],[0,255,0,255]);
    assert.equal(result.determinism!.status,'exact');
    const previous=motionHash(input,[],'managed-motion-10');
    assert.equal(motionHashEngine(input,[],previous),'managed-motion-10');
    assert.notEqual(motionHash(input),previous);
  }finally{await rm(root,{recursive:true,force:true});}
});

const component = `const Caption=({cue}:{cue:{top:number}})=><div style={{top:cue.top}}/>;`;
test("组件 top 属性实际渲染到指定坐标，名称放行不影响局部参数", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "vfc-jsx-top-"));
  try {
    const source = `function RuleLine({top}:{top:number}){return <div style={{position:'absolute',left:0,top,width:320,height:100,background:'#00ff00'}}/>;}export default ()=> <RuleLine top={148}/>;`;
    const result = await renderManagedMotion({ ...motionFixture, source, durationInFrames: 2 }, root);
    const png = PNG.sync.read(await readFile(join(root, "frames/frame-00000.png")));
    assert.equal(png.data[(147 * png.width + 10) * 4 + 3], 0);
    const pixel = (148 * png.width + 10) * 4;
    assert.deepEqual([...png.data.subarray(pixel, pixel + 4)], [0, 255, 0, 255]);
    assert.equal(result.frameHashes.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("字幕配置通过子组件解构传参后仍识别为数据", () => {
  for (const source of [
    `${component}export default function Motion(props){return <Caption cue={props.captionCue}/>;}`,
    `${component}const cue={top:42};export default ()=><Caption cue={cue}/>;`,
    `function Caption({cue}){return <div style={{top:cue['top']}}/>;}export default props=><Caption cue={props.cue}/>;`
  ]) assert.doesNotThrow(() => validateMotionSource(source));
});

test("未知调用、扩展属性与浏览器访问不能借子组件数据证明放行", () => {
  for (const source of [
    `${component}export default ()=>Caption({cue:unknown});`,
    `${component}export default props=><Caption cue={props.cue} {...props}/>;`,
    `${component}export default props=><><Caption cue={props.cue}/><Caption cue={unknown}/></>;`,
    `${component}export default props=><Caption cue={window}/>;`,
    `${component}export default props=><Caption cue={top}/>;`,
    `${component}export default Caption;`,
    `const Caption=({cue})=><div>{cue.constructor}</div>;export default props=><Caption cue={props.cue}/>;`,
    `const Caption=({cue})=><div>{cue.top}</div>;const alias=Caption;export default props=><Caption cue={props.cue}/>;`
  ]) assert.throws(() => validateMotionSource(source), /MOTION_API_REJECTED/u);
});
