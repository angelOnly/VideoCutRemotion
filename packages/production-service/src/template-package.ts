import { promises as fs, createWriteStream } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { z } from 'zod';
import { inside, regular, json, writeJson, treeDigest } from './files.js';
import { ProductionError, sha256 } from './contracts.js';

// 旧冻结工程仍可 Render；只有新的 Analysis 必须具备文字合同。
export const manifestSchema=z.object({schemaVersion:z.literal(1),templateVersion:z.string().min(1),instructions:z.array(z.string()).min(1),analysisInstructions:z.array(z.string().min(1)).min(1).optional(),entry:z.string().min(1),wholeComposition:z.string().min(1),timelineModule:z.string().min(1),publicAssetRoot:z.string().min(1),width:z.number().int().positive(),height:z.number().int().positive(),fps:z.number().positive(),voiceRefs:z.array(z.string()).default([])}).passthrough();
export type AnalysisContract={digest:string;files:Array<{path:string;sha256:string;text:string}>};
export async function readAnalysisContract(root:string,manifest:z.infer<typeof manifestSchema>):Promise<AnalysisContract>{
  if(!manifest.analysisInstructions?.length)throw new ProductionError('TEMPLATE_ANALYSIS_CONTRACT_MISSING','模板缺少 analysisInstructions 文字合同，请通过模板发布流程补齐后再提交 Analysis');
  const files:AnalysisContract['files']=[],seen=new Set<string>();let total=0;
  for(const path of manifest.analysisInstructions){
    // 只允许显式文字文件；不从源码、渲染合同或链接递归推导文字规则。
    if(isAbsolute(path)||/^[A-Za-z]:/.test(path)||path.includes('\\')||!['.md','.txt'].includes(extname(path).toLowerCase()))throw new ProductionError('TEMPLATE_ANALYSIS_PATH_INVALID',`analysisInstructions 必须指向模板内的 Markdown 或 TXT 文件：${path}`);
    let file:string;
    try{file=await regular(root,relative(root,resolve(root,'renderer',path)));}catch{throw new ProductionError('TEMPLATE_ANALYSIS_PATH_INVALID',`analysisInstructions 文件缺失或越出模板：${path}`);}
    const normalized=relative(root,file).replaceAll('\\','/');
    if(seen.has(normalized.toLowerCase()))throw new ProductionError('TEMPLATE_ANALYSIS_CONTRACT_INVALID',`analysisInstructions 重复引用：${path}`);seen.add(normalized.toLowerCase());
    const bytes=await fs.readFile(file);total+=bytes.length;
    if(total>128*1024)throw new ProductionError('TEMPLATE_ANALYSIS_CONTRACT_INVALID','analysisInstructions 文字合同合计超过 128 KiB');
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new ProductionError('TEMPLATE_ANALYSIS_CONTRACT_INVALID',`analysisInstructions 必须是 UTF-8 文字：${path}`);}
    if(!text.trim()||text.includes('\0'))throw new ProductionError('TEMPLATE_ANALYSIS_CONTRACT_INVALID',`analysisInstructions 内容为空或不是文字：${path}`);
    files.push({path:normalized,sha256:sha256(bytes),text});
  }
  return {digest:sha256(JSON.stringify({templateVersion:manifest.templateVersion,files:files.map(({path,sha256})=>({path,sha256}))})),files};
}
export function analysisTemplateInput(template:{digest:string;manifest:z.infer<typeof manifestSchema>;analysisContract:AnalysisContract}){
  const {manifest,analysisContract}=template;
  return {templateVersion:manifest.templateVersion,archiveDigest:template.digest,analysisContractDigest:analysisContract.digest,width:manifest.width,height:manifest.height,fps:manifest.fps,analysisInstructions:analysisContract.files};
}
export async function extractZip(zipPath:string,destination:string,maxBytes=1024*1024*1024) {
  await fs.mkdir(destination,{recursive:true});
  await new Promise<void>((done,fail)=>yauzl.open(zipPath,{lazyEntries:true,validateEntrySizes:true},(err,zip)=>{
    if(err||!zip)return fail(new ProductionError('ZIP_INVALID',`模板 ZIP 无法读取：${err?.message}`)); let total=0,count=0;const names=new Set<string>();
    const abort=(e:unknown)=>{zip.close();fail(e);};zip.on('error',abort);zip.on('end',done);
    zip.on('entry',entry=>{void(async()=>{
      const name=entry.fileName.replaceAll('\\','/'); const mode=(entry.externalFileAttributes>>>16)&0o170000;
      if(name.startsWith('/')||/^[A-Za-z]:/.test(name)||name.split('/').includes('..')||name.includes(':')||mode===0o120000||names.has(name.toLowerCase()))throw new ProductionError('ZIP_PATH_INVALID',`不安全或重复归档条目：${name}`);
      names.add(name.toLowerCase());total+=entry.uncompressedSize;if(total>maxBytes||++count>20000)throw new ProductionError('ZIP_LIMIT','模板解压超过限制');
      const target=inside(destination,name);if(name.endsWith('/'))await fs.mkdir(target,{recursive:true});else{
        await fs.mkdir(dirname(target),{recursive:true});const stream=await new Promise<NodeJS.ReadableStream>((yes,no)=>zip.openReadStream(entry,(e,s)=>e||!s?no(e):yes(s)));
        await pipeline(stream,createWriteStream(target,{flags:'wx'}));
      }zip.readEntry();
    })().catch(abort);});zip.readEntry();
  }));
}
export async function validateTemplate(root:string) {
  const manifestPath=await regular(root,'renderer/renderer-manifest.json'),renderer=dirname(manifestPath);
  const parsed=manifestSchema.safeParse(await json(manifestPath));
  if(!parsed.success)throw new ProductionError('TEMPLATE_MANIFEST_INVALID',`模板 manifest 字段无效：${parsed.error.issues.map(issue=>`${issue.path.join('.')}：${issue.message}`).join('；')}`);
  const manifest=parsed.data;
  for(const p of [...manifest.instructions,manifest.entry,manifest.timelineModule])await regular(root,relative(root,resolve(renderer,p)));
  const assets=inside(root,resolve(renderer,manifest.publicAssetRoot));if(!(await fs.stat(assets)).isDirectory())throw new ProductionError('TEMPLATE_ASSETS_MISSING','模板资源目录缺失');
  return manifest;
}
export async function freezeTemplate(baseUrl:string,id:string,directory:string,signal?:AbortSignal) {
  await fs.mkdir(directory,{recursive:true});const archive=join(directory,'template.zip');
  if(!(await fs.stat(archive).catch(()=>null))){
    const response=await fetch(`${baseUrl.replace(/\/$/,'')}/api/custom-templates/${encodeURIComponent(id)}/package`,{signal,redirect:'error'});
    if(!response.ok||!response.body)throw new ProductionError('TEMPLATE_DOWNLOAD_FAILED',`模板下载 HTTP ${response.status}`,502);
    const chunks:Buffer[]=[];let bytes=0;for await(const c of response.body as any){bytes+=c.length;if(bytes>256*1024*1024)throw new ProductionError('ZIP_LIMIT','模板下载超过 256 MiB');chunks.push(Buffer.from(c));}
    await fs.writeFile(`${archive}.tmp`,Buffer.concat(chunks));await fs.rename(`${archive}.tmp`,archive);
  }
  const digest=sha256(await fs.readFile(archive)),root=join(directory,'template');
  if(!(await fs.stat(root).catch(()=>null))){const staging=join(directory,`extract-${Date.now()}`);await extractZip(archive,staging);await validateTemplate(staging);await fs.rename(staging,root);}
  const manifest=await validateTemplate(root),analysisContract=await readAnalysisContract(root,manifest),sourceDigest=await treeDigest(root);await writeJson(join(directory,'template-freeze.json'),{digest,sourceDigest,manifest,analysisContract});
  return {root,digest,sourceDigest,manifest,analysisContract};
}
