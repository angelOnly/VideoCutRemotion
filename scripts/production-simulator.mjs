import { createServer } from 'node:http';
import { readFile,writeFile,mkdir,appendFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createHmac,timingSafeEqual,createHash } from 'node:crypto';
const root=resolve(process.env.SIMULATOR_ROOT??'.candidate/textvideo-studio-simulator'),port=Number(process.env.SIMULATOR_PORT??3411),secret=process.env.CALLBACK_SECRET;
if(!secret)throw new Error('缺少回调验签配置');await mkdir(root,{recursive:true});
const events=new Map();try{for(const row of (await readFile(join(root,'events.jsonl'),'utf8')).trim().split('\n')){const e=JSON.parse(row);events.set(e.eventId,e);}}catch{}
const server=createServer(async(req,res)=>{try{
  // 故障只由本地测试控制文件开启；无需重启生产服务，也不改业务请求。
  let fault={};try{fault=JSON.parse(await readFile(join(root,'fault-config.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const match=/^\/api\/custom-templates\/([A-Za-z0-9_-]+)\/package$/.exec(req.url??'');
  if(req.method==='GET'&&match){
    if(fault.templateStatus){await appendFile(join(root,'template-attempts.jsonl'),JSON.stringify({id:match[1],status:fault.templateStatus,at:Date.now()})+'\n');res.writeHead(fault.templateStatus).end();return;}
    const bytes=await readFile(join(root,`template-${match[1]}.zip`));
    await appendFile(join(root,'template-attempts.jsonl'),JSON.stringify({id:match[1],status:200,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),at:Date.now()})+'\n');
    res.setHeader('content-type','application/zip');res.setHeader('content-length',bytes.length);res.end(bytes);return;
  }
  if(req.method==='GET'&&req.url==='/events'){res.setHeader('content-type','application/json');res.end(JSON.stringify([...events.values()]));return;}
  if(req.method==='POST'&&/^\/ai_video_director\/getAiVideoEditing(?:Analysis)?DataCallback$/.test(req.url??'')){
    let body='';for await(const chunk of req){body+=chunk;if(body.length>2e6)throw new Error('回调过大');}
    const timestamp=String(req.headers['x-callback-timestamp']??''),received=String(req.headers['x-callback-signature']??''),signature=createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
    if(Math.abs(Date.now()/1000-Number(timestamp))>300||received.length!==signature.length||!timingSafeEqual(Buffer.from(received),Buffer.from(signature)))throw new Error('回调签名无效');
    const event=JSON.parse(body);if(event.eventId!==req.headers['x-event-id'])throw new Error('事件身份无效');
    await appendFile(join(root,'callback-attempts.jsonl'),JSON.stringify({eventId:event.eventId,verified:true,receivedAt:Date.now(),body})+'\n');
    if(fault.callbackStatus){res.writeHead(fault.callbackStatus).end();return;}
    if(fault.callbackResponse==='non-json'){res.end('故障注入：非 JSON');return;}
    if(fault.callbackResponse==='business-reject'){res.setHeader('content-type','application/json');res.end('{"status":1}');return;}
    if(!events.has(event.eventId)){await appendFile(join(root,'events.jsonl'),body+'\n');events.set(event.eventId,event);}
    // 模拟接收端已落库但响应丢失；下次同 eventId 重投不能新增业务结果。
    if(fault.callbackResponse==='drop-after-persist'){res.destroy();return;}
    res.setHeader('content-type','application/json');res.end('{"status":0}');return;
  }
  res.writeHead(404).end();
}catch(e){res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({status:1,error:String(e)}));}});
server.listen(port,'127.0.0.1',()=>console.log(`模拟平台已启动 ${server.address().port}`));
