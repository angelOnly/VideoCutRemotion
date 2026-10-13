import { promises as fs, createWriteStream } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { z } from 'zod';
import { inside, regular, json, writeJson, treeDigest } from './files.js';
import { ProductionError, sha256 } from './contracts.js';

export const manifestSchema=z.object({schemaVersion:z.literal(1),templateVersion:z.string().min(1),instructions:z.array(z.string()).min(1),entry:z.string().min(1),wholeComposition:z.string().min(1),timelineModule:z.string().min(1),publicAssetRoot:z.string().min(1),width:z.number().int().positive(),height:z.number().int().positive(),fps:z.number().positive(),voiceRefs:z.array(z.string()).default([])}).passthrough();
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
  const manifestPath=await regular(root,'renderer/renderer-manifest.json'),renderer=dirname(manifestPath),manifest=manifestSchema.parse(await json(manifestPath));
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
  const manifest=await validateTemplate(root),sourceDigest=await treeDigest(root);await writeJson(join(directory,'template-freeze.json'),{digest,sourceDigest,manifest});
  return {root,digest,sourceDigest,manifest};
}
