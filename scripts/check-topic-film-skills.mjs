/** 只读检查目录、引用、案例原件与发行一致性，不认证成片质量。 */
import {readFile, access, readdir} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const rootFlag=process.argv.indexOf('--skills-root');
const root=rootFlag>=0?resolve(process.argv[rootFlag+1]):join(repoRoot,'.agents','skills');
const failures=[]; let checks=0;
function check(value,message){checks++;if(!value)failures.push(message);}
async function exists(p){try{await access(p);return true;}catch{return false;}}
const text=async p=>readFile(join(root,p),'utf8');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// CASE 正文仅允许去掉 Skill 元数据、调整链接位置和空行，不能变成摘要。
const caseBody=bytes=>bytes.toString('utf8').replace(/\r\n/g,'\n').replace(/^---\n[\s\S]*?\n---\n/,'').replace(/\]\([^)]*\)/g,'](路径)').split('\n').filter(line=>line.trim()).join('\n');
async function walk(directory){const out=[];for(const e of await readdir(directory,{withFileTypes:true})){const p=join(directory,e.name);if(e.isDirectory())out.push(...await walk(p));else out.push(p);}return out;}
const all=await walk(root);
const entries=(await readdir(root,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name!=='_shared');
check(entries.length===29,'工作 Skill 应为29个');
for(const e of entries){const body=await text(e.name+'/SKILL.md');check(body.match(/^name:\s*(.+)$/m)?.[1].trim()===e.name,'工作入口身份错误 '+e.name);check(/^description:\s*\S/m.test(body),'工作入口缺少说明 '+e.name);}
const caseRoot='motion-case-library/references/cases';
const caseDirs=await readdir(join(root,caseRoot));
check(caseDirs.length===13,'完整案例应为13个');
for(const id of caseDirs){check(await exists(join(root,caseRoot,id,'CASE.md')),'案例正文缺失 '+id);check(!await exists(join(root,id)),'旧独立案例仍存在 '+id);}
for(const p of all){
 if(p.includes(join('references','cases')))check(!p.endsWith('SKILL.md')&&!p.endsWith(join('agents','openai.yaml')),'案例仍有活动Skill身份 '+p);
 if(!p.endsWith('.md'))continue;
 const body=(await readFile(p,'utf8')).replace(/```[\s\S]*?```/g,'');
 for(const m of body.matchAll(/\]\(([^)]+)\)/g)){const target=m[1].split('#')[0];if(!target||/^[a-z]+:/i.test(target))continue;check(await exists(resolve(dirname(p),decodeURIComponent(target))),'文件引用缺失 '+p+' → '+target);}
}
for(const p of ['_shared/MCP_EXECUTION_CONTRACT.md','_shared/SOURCE_REVIEW_METHOD.md','_shared/MATERIAL_TO_SCENE.md','remotion-production/references/motion-graphics-casebook.md','remotion-production/references/scene-art-and-motion.md'])check(!await exists(join(root,p)),'旧混合文件仍存在 '+p);
// 清单来自迁移前的逐文件快照，原件不得随着说明重组被改写。
const integrity=JSON.parse(await readFile(join(repoRoot,'docs/development/skills-organization/case-integrity.json'),'utf8'));
for(const item of integrity){const p=join(root,item.target);check(await exists(p),'原件缺失 '+item.target);if(await exists(p)){const bytes=await readFile(p);check(hash(item.normalization==='case-body'?caseBody(bytes):bytes)===item.sha256,'原件或正文哈希改变 '+item.target);}}
const r92=['mixed-scene-relay','active-window-focus','occlusion-condition-reveal','context-detail-observation','relation-unfold','object-type-relay'];
for(const short of r92){const id=caseRoot+'/motion-case-'+short, rec=JSON.parse(await text(id+'/case-record.json'));
 check(rec.teachingPrompt.isOriginalInputForObservedMedia===false,'原始输入与后写教学混淆 '+id);
 check(rec.teachingPrompt.status==='written_not_rendered','教学渲染状态改变 '+id);
 check(rec.validation.continuousMotionVerified===false,'连续观看状态改变 '+id);
 check(rec.reproduction.newProjectRequiresNewBindings===true,'新项目绑定边界缺失 '+id);
 for(const item of [rec.media,rec.teachingPrompt])check(hash(await readFile(join(root,id,item.path)))===item.sha256,'记录与原件不一致 '+id+'/'+item.path);
}
const attentionCase=caseRoot+'/motion-case-attention-programme';
const attention=JSON.parse(await text(attentionCase+'/case-record.json'));
check(attention.status.newTopicTransfer==='not_tested','历史认可不能代替新主题测试');
check(attention.missingDependencies.length>0&&attention.status.standaloneRerender==='not_available_from_this_package_alone','须保留重渲染缺口');
// 固定历史身份，避免连同来源账本一起重写后把新内容误认作旧案例。
const historicalIdentity={
 'assets/preview.mp4':'2e739a14560cf193d91cf9a02527210a10092f6e74c63c11306b9ada7db1ca72',
 'references/original-input.md':'8b004163c39a5f14676c7d26301d65058b7e73ebbd3c48d4e840134ec8e18965',
 'source/source.json':'45e9531c22df8fc3bb9f4607115621bd3a50f8f264e2257a1366ffeb7960de6d'
};
for(const [path,hash] of Object.entries(historicalIdentity)){
 check(createHash('sha256').update(await readFile(join(root,attentionCase,path))).digest('hex')===hash,`历史原件身份改变：${path}`);
}
for(const item of [attention.finalVideo,attention.finalSource,attention.originalInput]){
 check(historicalIdentity[item.path]===item.sha256,`案例入口与原件不一致：${item.path}`);
}
const savedSource=JSON.parse(await text(attentionCase+'/source/source.json'));
check((await text(attentionCase+'/source/Motion.tsx'))===savedSource.source,'提取源码与固定输入不一致');
// 去掉派生副本后，仍核验实际绑定、素材和原始输入的对应关系。
const materials=JSON.parse(await text(attentionCase+'/source/materials.json'));
for(const item of materials.items){
 const binding=savedSource.imageBindings?.[item.slot]??savedSource.videoBindings?.[item.slot];
 check((typeof binding==='string'?binding:binding?.assetId)===item.assetId,`素材槽位与固定输入不一致：${item.slot}`);
 if(item.included){
  check(createHash('sha256').update(await readFile(join(root,attentionCase,item.casePath))).digest('hex')===item.hash,`素材原件改变：${item.casePath}`);
 }
}
const fonts=JSON.parse(await text(attentionCase+'/source/font-bindings.json'));
check(JSON.stringify(fonts.fontBindings)===JSON.stringify(savedSource.fontBindings),'字体槽位与固定输入不一致');
for(const font of fonts.boundFonts)check(savedSource.fontBindings[font.slot]===font.fontId,`字体身份不一致：${font.slot}`);
for(const frame of JSON.parse(await text(attentionCase+'/source/keyframes.json')))check(await exists(join(root,attentionCase,frame.file)),`关键帧缺失：${frame.file}`);
// 比较完整文件集合及字节；发行适配文件由 plugin:verify 另查。
const mirror=join(repoRoot,'plugins/videoflowcut/skills');
const relative=p=>p.slice(root.length+1).replaceAll('\\','/');
const expected=new Set(all.map(relative));
for(const p of all){const rel=relative(p),dest=join(mirror,rel);check(await exists(dest),'发行副本缺失 '+rel);if(await exists(dest))check((await readFile(p)).equals(await readFile(dest)),'发行副本漂移 '+rel);}
for(const p of await walk(mirror)){const rel=p.slice(mirror.length+1).replaceAll('\\','/');check(expected.has(rel)||['_shared/SKILL.md','_shared/agents/openai.yaml'].includes(rel),'发行副本有残留 '+rel);}
console.log(JSON.stringify({kind:'静态技能与案例合同',skillsRoot:root,checks,passed:checks-failures.length,failures,limits:'不证明模型实际加载、审美、连续声画或生产运行成功'},null,2));
process.exitCode=failures.length?1:0;
