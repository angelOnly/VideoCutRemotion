import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadIndex,localFile} from './mechanisms.mjs';
import {queryMechanisms} from '../mechanism-search.mjs';
import {taxonomy} from '../taxonomy.mjs';
export function searchLibrary(root,request={}){return {...queryMechanisms(loadIndex(root),request),taxonomy};}
export {loadIndex as loadLibraryIndex};
export function searchLibraryIndex(index,request={},semantic={}){return {...queryMechanisms(index,request,semantic),taxonomy};}
export function libraryVideo(root,id,source_sha256){
  const index=loadIndex(root),card=queryMechanisms(index,{ids:[id],source_sha256}).cards[0];
  return localFile(root,card.document.split('/mechanisms/')[0]+'/video.mp4');
}
export function readLibraryMechanism(root,{id,part='mechanism',source_sha256,include_storyboard=true}){
  if(!/^\d{3}-m\d{2}$/.test(id)||!['mechanism','overview'].includes(part))throw new Error('资料编号或范围无效');
  const index=loadIndex(root);
  const card=queryMechanisms(index,{ids:[id],...(source_sha256?{source_sha256}:{})}).cards[0];
  const document=part==='overview'?card.overview:card.document;
  const storyboard=part==='overview'?card.overview.replace(/overview\.md$/,'storyboard.jpg'):card.storyboard;
  const body=readFileSync(localFile(root,document),'utf8');
  const result={card,source_sha256:index.source_sha256,part,document,body,
    preview_url:'http://127.0.0.1:8874/library/'+(part==='overview'?`detail.html?case=${encodeURIComponent(card.case_slug)}`:card.detail),
    video_path:resolve(root,card.document.split('/mechanisms/')[0],'video.mp4'),
    observation:'返回原机制指令与静态分镜；本工具没有播放或听取视频。'};
  if(!include_storyboard)return {result};
  const bytes=readFileSync(localFile(root,storyboard));
  if(bytes.length>10*1024*1024||bytes.length<3||bytes.readUInt16BE(0)!==0xffd8)throw new Error('分镜图缺失、过大或不是有效 JPEG');
  return {result,image:bytes.toString('base64')};
}
