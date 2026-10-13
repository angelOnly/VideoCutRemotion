// 清单随链接保存：没有数据库，也不依赖浏览器存储。
export function validateSelection(value){
  if(!value||value.v!==1||!Array.isArray(value.ids)||value.ids.length>40||!Array.isArray(value.adopted)||typeof value.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.source_sha256))throw new Error('候选清单格式无效');
  if(value.ids.some(x=>typeof x!=='string'||!/^\d{3}-m\d{2}$/.test(x))||new Set(value.ids).size!==value.ids.length)throw new Error('候选编号无效或重复');
  if(value.adopted.some(x=>!value.ids.includes(x))||new Set(value.adopted).size!==value.adopted.length)throw new Error('采用项必须属于候选清单');
  return {v:1,source_sha256:value.source_sha256,ids:[...value.ids],adopted:[...value.adopted]};
}
export function encodeSelection(value){return new URLSearchParams({selection:JSON.stringify(validateSelection(value))}).toString();}
export function decodeSelection(input){
  if(typeof input!=='string'||input.length>16000)throw new Error('候选链接无效或过长');
  const query=input.includes('?')?input.slice(input.indexOf('?')+1):input;
  const raw=new URLSearchParams(query.split('#')[0]).get('selection');
  if(!raw)throw new Error('候选链接缺少清单');
  return validateSelection(JSON.parse(raw));
}
export function restoreSelection(input,index){
  const value=typeof input==='string'?decodeSelection(input):validateSelection(input);
  const known=new Set(index.mechanisms.map(m=>m.id));
  return {...value,unknown_ids:value.ids.filter(id=>!known.has(id)),stale:value.source_sha256!==index.source_sha256};
}
export function editSelection(value,action,id){
  const next=validateSelection(value),at=next.ids.indexOf(id);
  if(action==='add'&&at<0)next.ids.push(id);
  else if(action==='remove'){next.ids=next.ids.filter(x=>x!==id);next.adopted=next.adopted.filter(x=>x!==id);}
  else if(action==='adopt'&&at>=0)next.adopted=next.adopted.includes(id)?next.adopted.filter(x=>x!==id):[...next.adopted,id];
  else if(action==='up'&&at>0)[next.ids[at-1],next.ids[at]]=[next.ids[at],next.ids[at-1]];
  else if(action==='down'&&at>=0&&at<next.ids.length-1)[next.ids[at+1],next.ids[at]]=[next.ids[at],next.ids[at+1]];
  else if(!['add','remove','adopt','up','down'].includes(action))throw new Error('未知清单操作');
  return validateSelection(next);
}
