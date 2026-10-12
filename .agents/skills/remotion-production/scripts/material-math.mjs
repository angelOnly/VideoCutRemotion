/**
 * Development-only geometry/time reference. Not a registered effect or runtime API.
 * Source coordinates must be measured on the upright, SAR-corrected source.
 * Production authors inline only required pure helpers into permitted managed code.
 */
const finite = (name, value) => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
};
const positive = (name, value) => {
  finite(name, value);
  if (value <= 0) throw new RangeError(`${name} must be > 0`);
  return value;
};
const unit = (name, value) => {
  finite(name, value);
  if (value < 0 || value > 1) throw new RangeError(`${name} must be in [0,1]`);
  return value;
};
const checkBox = (box) => {
  finite('box.x',box.x); finite('box.y',box.y);
  positive('box.width',box.width); positive('box.height',box.height);
};
export function fitSource(source, box, mode='cover', position={x:.5,y:.5}) {
  positive('source.width',source.width); positive('source.height',source.height); checkBox(box);
  unit('position.x',position.x); unit('position.y',position.y);
  if (!['cover','contain','fill'].includes(mode)) throw new RangeError('unsupported fit');
  const rx=box.width/source.width, ry=box.height/source.height;
  const scale=mode==='contain'?Math.min(rx,ry):Math.max(rx,ry);
  const scaleX=mode==='fill'?rx:scale, scaleY=mode==='fill'?ry:scale;
  const width=source.width*scaleX, height=source.height*scaleY;
  return {box:{...box}, width, height, scaleX, scaleY,
    left:box.x+(box.width-width)*position.x,
    top:box.y+(box.height-height)*position.y};
}
export function focusCover(source, box, target, zoom=1, anchor={x:.5,y:.5}) {
  const base=fitSource(source,box,'cover');
  unit('target.u',target.u);unit('target.v',target.v);
  unit('anchor.x',anchor.x);unit('anchor.y',anchor.y);
  finite('zoom',zoom);if(zoom<1)throw new RangeError('cover zoom must be >= 1');
  const width=base.width*zoom,height=base.height*zoom;
  const ox=Math.max(box.width-width,Math.min(0,anchor.x*box.width-target.u*width));
  const oy=Math.max(box.height-height,Math.min(0,anchor.y*box.height-target.v*height));
  return {...base,width,height,scaleX:base.scaleX*zoom,scaleY:base.scaleY*zoom,
    left:box.x+ox,top:box.y+oy};
}
export function sourcePoint(geometry, point) {
  unit('point.u',point.u);unit('point.v',point.v);
  const x=geometry.left+point.u*geometry.width,y=geometry.top+point.v*geometry.height;
  const b=geometry.box;
  return {x,y,visible:x>=b.x&&x<=b.x+b.width&&y>=b.y&&y<=b.y+b.height};
}
/** Apply one shared parent transform: scale, then rotate, then translate. */
export function parentPoint(point, {pivot={x:0,y:0},scale=1,rotateDeg=0,translate={x:0,y:0}}={}) {
  for(const [n,v] of Object.entries({x:point.x,y:point.y,px:pivot.x,py:pivot.y,
    scale,rotateDeg,tx:translate.x,ty:translate.y}))finite(n,v);
  if(scale<=0)throw new RangeError('scale must be > 0');
  const r=rotateDeg*Math.PI/180, x=(point.x-pivot.x)*scale,y=(point.y-pivot.y)*scale;
  return {x:pivot.x+x*Math.cos(r)-y*Math.sin(r)+translate.x,
    y:pivot.y+x*Math.sin(r)+y*Math.cos(r)+translate.y};
}
export function frameMapping({globalFrame,workStartFrame,sequenceStartFrame=0,
  slotStartWorkFrame=0,bindingStartMs,bindingEndMs,fps}) {
  for(const [n,v] of Object.entries({globalFrame,workStartFrame,sequenceStartFrame,slotStartWorkFrame})){
    if(!Number.isInteger(v)||v<0)throw new RangeError(`${n} must be a nonnegative integer`);
  }
  positive('fps',fps);finite('bindingStartMs',bindingStartMs);positive('bindingEndMs',bindingEndMs);
  if(bindingStartMs<0||bindingEndMs<=bindingStartMs)throw new RangeError('invalid source range');
  const workFrame=globalFrame-workStartFrame, sequenceFrame=workFrame-sequenceStartFrame;
  // 视频取作品根帧；Sequence重置仅影响布局时钟。
  const boundFrame=workFrame-slotStartWorkFrame;
  const sourceMs=bindingStartMs+boundFrame*1000/fps;
  if(workFrame<0||sequenceFrame<0||boundFrame<0||sourceMs>=bindingEndMs-1e-8)
    throw new RangeError('frame outside mounted sequence or bound source');
  return {workFrame,sequenceFrame,boundFrame,sourceMs};
}
/** Preview file time uses file origin, not the global project origin. */
export function previewRange({fromFrame,toFrame,fps},startFrame,endFrame){
  positive('fps',fps);
  for(const [n,v] of Object.entries({fromFrame,toFrame,startFrame,endFrame}))
    if(!Number.isInteger(v)||v<0)throw new RangeError(`${n} must be a nonnegative integer`);
  if(toFrame<=fromFrame||endFrame<=startFrame||startFrame<fromFrame||endFrame>toFrame)
    throw new RangeError('review outside preview');
  return {startMs:(startFrame-fromFrame)*1000/fps,endMs:(endFrame-fromFrame)*1000/fps};
}
