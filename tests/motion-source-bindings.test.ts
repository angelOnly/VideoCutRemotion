import assert from "node:assert/strict";
import test from "node:test";
import { compileMotion, validateMotionSource } from "../packages/motion-work/src/compiler.js";
import { motionFixture } from "./fixtures/managed-motion.js";

const component = (body: string) => `import React from 'react';export default function Motion(){${body}}`;

test("动效几何变量按实际作用域解析，允许局部 top 和闭包引用", async () => {
  const source = component("const p=0.5, top=626-p*200, height=200+p*200;const shape=()=> <path d={'M 120 '+top+' L 120 800'}/>;return <svg>{shape()}<text y={top+height}>总量</text></svg>;");
  validateMotionSource(source);
  assert.ok((await compileMotion({ ...motionFixture, source })).length > 100);
  for (const body of [
    "const top=10;const bounds={top};return <div style={bounds}/>;",
    "const place=(top:number)=>top+1;return <div>{place(10)}</div>;",
    "const [top]=[10];return <div>{top}</div>;",
    "const {height:top}={height:10};return <div>{top}</div>;",
    "let parent=10;return <div>{parent}</div>;"
  ]) assert.doesNotThrow(() => validateMotionSource(component(body)));
});

test("局部同名绑定不能放行其它作用域中的全局或非数据对象属性访问", () => {
  for (const body of [
    "return <div>{top}</div>;",
    "const bounds={top};return <div/>;",
    "{const top=10;}return <div>{top}</div>;",
    "const place=(top:number)=>top;return <div>{top}</div>;",
    "const local=function top(){return 10};return <div>{top}</div>;",
    "const top=10;return <div>{window.top}</div>;",
    "const top=10;return <div>{globalThis.top}</div>;",
    "const top=10;return <div>{globalThis['top']}</div>;",
    "const top=10;const holder=React;return <div>{holder.top}</div>;",
    "const top=10;const holder=React;return <div>{holder['top']}</div>;",
    "const top=10;return <div>{({}).constructor}</div>;",
    "const top=10;return <div>{fetch('https://example.com')}</div>;"
  ]) assert.throws(() => validateMotionSource(component(body)), /MOTION_API_REJECTED/u, body);
});

test("普通数据字段与平台 Props 可使用同名键，点访问和方括号一致", async () => {
  const source = `import React from 'react';const T={window:[130,154]};const DEFAULTS={window:'服务窗口',top:30};export default function Motion(props:any){const c={...DEFAULTS,...props};return <div style={{top:c.top}}>{c.window}{T.window[0]}{T['window'][1]}</div>;}`;
  assert.doesNotThrow(() => validateMotionSource(source));
  assert.ok((await compileMotion({ ...motionFixture, source, props: { window: "处理区" } })).length > 100);
  for (const body of [
    "const timing={window:[1,2],parent:'资源',fetch:'标签'};const alias=timing;return <div>{alias.window[0]}{alias['parent']}{alias.fetch}</div>;",
    "const data={window:'窗口'};const more={...data};return <div>{more.window}</div>;",
    "const data={window:'窗口'};const nested={data};return <div>{nested.data.window}</div>;"
  ]) assert.doesNotThrow(() => validateMotionSource(component(body)), body);
});

test("数据字段不能掩盖全局、未知接收者、函数、getter 和原型访问", () => {
  for (const body of [
    "const data={window:'窗口'};return <div>{window.location.href}</div>;",
    "const data={window:'窗口'};const alias=globalThis;return <div>{alias.window}</div>;",
    "const data={window:'窗口'};return <div>{this.window}</div>;",
    "const read=(value:any)=>value.window;return <div>{read({})}</div>;",
    "const data=React as {window:string};return <div>{data.window}</div>;",
    "const data={get window(){return '窗口'}};return <div>{data.window}</div>;",
    "const data={window:()=>1};return <div>{data.window()}</div>;",
    "const data={window:'窗口'};return <div>{data.constructor}</div>;",
    "const data={window:'窗口'};return <div>{data['__proto__']}</div>;",
    "const data={window:'窗口'};return <div>{data[`prototype`]}</div>;",
    "const data={window:'窗口'};return <div>{fetch('https://example.com')}</div>;",
    "const data={window:'窗口'};return <div>{Date.now()}</div>;"
  ]) assert.throws(() => validateMotionSource(component(body)), /MOTION_API_REJECTED/u, body);
});

test("类型和环境声明不能伪装成实际局部值", () => {
  for (const declaration of ["type top=number;", "interface top{}", "declare const top:number;", "declare function top():number;", "function top():number;", "declare class top{}", "declare namespace Fake{const top:number;}", "import type {useMemo as top} from 'react';", "import {type useMemo as top} from 'react';"]) {
    assert.throws(() => validateMotionSource(`${declaration}export default function Motion(){return <div>{top}</div>}`), /MOTION_API_REJECTED/u, declaration);
  }
});
