import test from 'node:test';
import assert from 'node:assert/strict';
import {fitSource,focusCover,sourcePoint,parentPoint,frameMapping,previewRange} from './material-math.mjs';
const eq=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const source={width:1920,height:1080},box={x:30,y:60,width:720,height:900};
test('cover maps source center to viewport center',()=>{
 const g=fitSource(source,box); const p=sourcePoint(g,{u:.5,v:.5});eq(p.x,390);eq(p.y,510);assert.ok(p.visible);
});
test('contain preserves aspect and letterboxing',()=>{
 const g=fitSource(source,box,'contain');eq(g.width,720);eq(g.height,405);eq(g.top,307.5);
});
test('fill has independent x/y scales',()=>{
 const g=fitSource(source,box,'fill');eq(g.width,720);eq(g.height,900);assert.notEqual(g.scaleX,g.scaleY);
});
test('object position 0 and 1 affect excess width',()=>{
 eq(fitSource(source,box,'cover',{x:0,y:0}).left,30);
 const g=fitSource(source,box,'cover',{x:1,y:1});eq(g.left+g.width,750);
});
test('clipped source target remains reported invisible',()=>{
 assert.equal(sourcePoint(fitSource(source,box),{u:0,v:.5}).visible,false);
});
test('focus to inner target produces intended projection',()=>{
 const g=focusCover(source,box,{u:.6,v:.5},2);const p=sourcePoint(g,{u:.6,v:.5});eq(p.x,390);eq(p.y,510);
});
test('near edge focus is clamped without inventing center',()=>{
 const g=focusCover(source,box,{u:0,v:0},1); const p=sourcePoint(g,{u:0,v:0});eq(g.left,30);eq(g.top,60);eq(p.x,30);eq(p.y,60);
});
test('parent rotation and scale use common pivot',()=>{
 const p=parentPoint({x:10,y:0},{scale:2,rotateDeg:90,translate:{x:5,y:7}});eq(p.x,5);eq(p.y,27);
});
test('Sequence重置不改变作品根视频时钟',()=>{
 const a=frameMapping({globalFrame:159,workStartFrame:100,sequenceStartFrame:0,bindingStartMs:2000,bindingEndMs:6000,fps:30});
 const b=frameMapping({globalFrame:160,workStartFrame:100,sequenceStartFrame:60,bindingStartMs:2000,bindingEndMs:6000,fps:30});
 assert.equal(b.sequenceFrame,0);assert.equal(b.boundFrame,60);eq(b.sourceMs-a.sourceMs,1000/30);
});
test('whole and detail windows can share same source frame',()=>{
 const x={globalFrame:180,workStartFrame:100,bindingStartMs:2000,bindingEndMs:6000,fps:30};
 eq(frameMapping({...x,sequenceStartFrame:0}).sourceMs,frameMapping({...x,sequenceStartFrame:60}).sourceMs);
});
test('slot beginning later maps to binding start',()=>{
 const m=frameMapping({globalFrame:150,workStartFrame:100,slotStartWorkFrame:50,sequenceStartFrame:50,bindingStartMs:2000,bindingEndMs:6000,fps:24});eq(m.sourceMs,2000);assert.equal(m.boundFrame,0);
});
test('bound range remains half-open and never silently freezes',()=>{
 assert.throws(()=>frameMapping({globalFrame:96,workStartFrame:0,bindingStartMs:0,bindingEndMs:4000,fps:24}),/outside/);
});
test('preview range converts global frames to file-relative ms',()=>{
 assert.deepEqual(previewRange({fromFrame:240,toFrame:480,fps:24},264,312),{startMs:1000,endMs:3000});
});
test('invalid target, size and preview intervals rejected',()=>{
 assert.throws(()=>fitSource({width:0,height:1080},box));
 assert.throws(()=>focusCover(source,box,{u:1.2,v:.5}));
 assert.throws(()=>previewRange({fromFrame:240,toFrame:480,fps:24},200,300));
 assert.throws(()=>focusCover(source,box,{u:.5,v:.5},.5));
});
