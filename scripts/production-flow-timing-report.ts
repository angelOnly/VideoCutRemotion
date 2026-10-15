import {promises as fs} from 'node:fs';
import {join,resolve} from 'node:path';
import {productionTiming} from '../packages/production-service/src/production-timing.js';
const [directory,startedAt,endedAt]=process.argv.slice(2);
if(!directory||!startedAt||!endedAt)throw new Error('用法：tsx scripts/production-flow-timing-report.ts <原Run目录> <带时区的真实开始时间> <带时区的真实结束时间>');
if(![startedAt,endedAt].every(v=>/(Z|[+-]\d{2}:\d{2})$/.test(v)))throw new Error('开始、结束时间必须显式携带时区');
const root=resolve(directory),missing:string[]=[];
async function lines(path:string){
 let text:string;try{text=await fs.readFile(path,'utf8');}catch(e:any){if(e.code!=='ENOENT')throw e;missing.push(`缺少原始日志：${path}`);return [];}
 return text.split('\n').flatMap((line,i)=>{if(!line.trim())return [];try{return [JSON.parse(line)];}catch{throw new Error(`原始日志不完整：${path} 第 ${i+1} 行；先恢复读取，不生成伪完整报告`);}});
}
const media=await lines(join(root,'metrics/media.jsonl')),events=await lines(join(root,'logs/codex-events.jsonl'));
const report=productionTiming(Date.parse(startedAt),Date.parse(endedAt),media,events);report.diagnostics.push(...missing);
console.log(JSON.stringify({...report,sources:{root,media:'metrics/media.jsonl',events:'logs/codex-events.jsonl'}},null,2));
