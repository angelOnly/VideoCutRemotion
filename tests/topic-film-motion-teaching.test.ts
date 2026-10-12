import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
// 测试直接执行发行教学代码，避免另存一份实现漂移；仅验证给定参数的数学性质。
const guide = await readFile(new URL('../.agents/skills/motion-case-library/references/cases/motion-case-attention-programme/references/art-and-motion-teaching.md', import.meta.url), 'utf8');
const source = guide.replace(/\r\n/g, '\n').match(/```javascript\n([\s\S]*?)\n```/)![1];
const {letterStates,handoffState,lensState,hermite,progress,sampleInLens,sourceTimeAt} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const near=(a: number,b: number,eps=1e-7)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
test('参数与时域边界',()=>{
 assert.throws(()=>progress(1,0,0),RangeError);
 assert.throws(()=>letterStates(NaN),TypeError);
 near(progress(-1,0,1),0);near(progress(2,0,1),1);
});
test('字位不因显现次序改变，末态归正',()=>{
 for (const t of [-1,0,.18,.36,.55,.82,2]){
  const a=letterStates(t);assert.equal(a.map((x: any)=>x.text).join(''),'不能冷场');
  assert.ok(a.every((x: any,i: number)=>i===0||x.x>a[i-1].x));
  assert.ok(a.every((x: any)=>x.opacity>=0&&x.opacity<=1));
 }
 const middle=letterStates(.18);
 assert.ok(middle[3].opacity>0);near(middle[2].opacity,0);
 letterStates(.82).forEach((x: any)=>{near(x.rotateYDeg,0);near(x.x,x.slotX);near(x.opacity,1);});
});
test('交接中途新旧同时存在；卸载前手机已出画',()=>{
 const s=handoffState(.4);
 assert.ok(s.phone.mounted&&s.avatar.opacity>0&&s.board.revealWidth>0);
 const end=handoffState(.72);
 assert.equal(end.phone.mounted,false);assert.ok(end.phone.y-end.phone.height/2>436);
 let last=-Infinity;
 for(let t=0;t<.72;t+=.001){const y=handoffState(t).phone.y;assert.ok(y>=last);last=y;}
});
test('Hermite在端点满足位置和指定速度',()=>{
 for(const t of [0,1]){
  const s=hermite(t,0,1,0,10,2,3);
  near(s.position,t?10:0);near(s.velocity,t?3:2);
 }
});
test('镜片内部节点速度连续且非零',()=>{
 for(const t of [1.05,2.15]){
  const left=lensState(t-1e-7),right=lensState(t+1e-7);
  near(left.x,right.x,1e-4);near(left.y,right.y,1e-4);
  near(left.vx,right.vx,1e-4);near(left.vy,right.vy,1e-4);
  near(lensState(t).vy,26);assert.ok(lensState(t).vy>0);
 }
});
test('本演示路径不倒退，稳定阅读时镜圆在舞台内',()=>{
 let last=178;
 for(let t=0;t<=3.25;t+=.001){
  const s=lensState(t);assert.ok(s.y>=last-1e-9);last=s.y;
  assert.ok(s.x-s.radius>=0&&s.x+s.radius<=480);
  assert.ok(s.y-s.radius>=0&&s.y+s.radius<=436);
 }
});
test('倍率1且p=q时原点不偏移；源时钟不因转场重置',()=>{
 const p={x:310,y:270},x={x:286,y:268};
 assert.deepEqual(sampleInLens(x,p,p,1),x);
 near(sourceTimeAt(10.4,7,12),15.4);near(sourceTimeAt(10.72,7,12),15.72);
});
test('秒驱动在24、30、60fps的同一可表示时刻一致',()=>{
 for(const fps of [24,30,60]){
  const t=(fps/2)/fps;
  assert.deepEqual(handoffState(t),handoffState(.5));
 }
});
