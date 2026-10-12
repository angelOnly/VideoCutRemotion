import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { fetchPublicSource, publicSourceDispatcher } from "../packages/asset-acquisition/src/public-source.js";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  return (server.address() as {port:number}).port;
}

test("公开来源使用代理的已核验IP隧道、保留Host；重定向内网不发第二次请求", async t => {
  let mode="ok", requests=0;
  const received: Array<import("node:http").IncomingHttpHeaders> = [];
  const sockets=new Set<Socket>(), tunnels:string[]=[];
  const origin=createServer((req,res)=>{
    requests++;
    received.push(req.headers);
    assert.equal(req.headers.host,"source.example.test");
    if(mode==="redirect") {res.writeHead(302,{location:"http://127.0.0.1/private"});res.end();}
    else if(mode==="public-redirect" && req.url==="/") {res.writeHead(302,{location:"http://source.example.test/final"});res.end();}
    else {res.setHeader("content-type","text/plain");res.end("公开内容");}
  });
  const proxy=createServer();
  for(const server of [origin,proxy])server.on("connection",socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
  const originPort=await listen(origin);
  proxy.on("connect",(req,socket,head)=>{
    tunnels.push(req.url!);
    const upstream=connect(originPort,"127.0.0.1",()=>{socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");if(head.length)upstream.write(head);upstream.pipe(socket);socket.pipe(upstream);});
    sockets.add(upstream);upstream.on("error",()=>socket.destroy());socket.on("error",()=>upstream.destroy());
  });
  const port=await listen(proxy);
  const values={http_proxy:"",https_proxy:"",no_proxy:"",HTTP_PROXY:`http://127.0.0.1:${port}`,HTTPS_PROXY:`http://127.0.0.1:${port}`,NO_PROXY:""};
  const previous=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  t.after(()=>{
    for(const key of Object.keys(values))delete process.env[key];
    for(const [key,value] of Object.entries(previous))if(value!==undefined)process.env[key]=value;
  });
  for(const [key,value] of Object.entries(values)) {
    if(key===key.toLowerCase())delete process.env[key];else process.env[key]=value;
  }
  t.mock.method(dns,"lookup",async (hostname:string)=>[{address:hostname==="127.0.0.1"?"127.0.0.1":"8.8.8.8",family:4}]);
  syncBuiltinESMExports();
  try {
    const result=await fetchPublicSource("http://source.example.test/",100,AbortSignal.timeout(3000));
    assert.equal(result.bytes.toString(),"公开内容");
    assert.equal(result.url,"http://source.example.test/");
    assert.deepEqual(tunnels,["8.8.8.8:80"]);
    mode="redirect";
    await assert.rejects(fetchPublicSource("http://source.example.test/",100,AbortSignal.timeout(3000)),error=>(error as {code:string}).code==="SOURCE_URL_REJECTED");
    assert.equal(requests,2);
    assert.deepEqual(tunnels,["8.8.8.8:80","8.8.8.8:80"]);
    mode="ok";
    await fetchPublicSource("http://source.example.test/",100,AbortSignal.timeout(3000),{
      Referer:"https://official.example/", "User-Agent":"CaptureBrowser", Accept:"text/css", "Accept-Language":"zh-CN",
      Authorization:"Bearer private", Cookie:"session=private", Host:"private.example"
    });
    assert.equal(received[2].referer,"https://official.example/");
    assert.equal(received[2]["user-agent"],"CaptureBrowser");
    assert.equal(received[2].accept,"text/css");
    assert.equal(received[2]["accept-language"],"zh-CN");
    assert.equal(received[2].authorization,undefined);
    assert.equal(received[2].cookie,undefined);
    mode="public-redirect";
    await fetchPublicSource("http://source.example.test/",100,AbortSignal.timeout(3000),{referer:"https://official.example/private?token=secret"});
    assert.equal(received[4].referer,undefined);
    await fetchPublicSource("http://source.example.test/",100,AbortSignal.timeout(3000),{referer:"http://official.example/article?query=private"});
    assert.equal(received[6].referer,"http://official.example/");
  } finally {
    t.mock.restoreAll();syncBuiltinESMExports();
    for(const socket of sockets)socket.destroy();
    await Promise.all([origin,proxy].map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
  }
});

test("NO_PROXY保持直连，未支持固定IP的代理协议明确拒绝",async()=>{
  const origin=createServer((_req,res)=>res.end("直连"));
  const port=await listen(origin);
  const url=new URL(`http://source.example.test:${port}/`);
  // 单测连接层；正式入口仍在此前执行公网地址及端口核验。
  const agent=publicSourceDispatcher(url,{address:"127.0.0.1",family:4},{HTTP_PROXY:"http://127.0.0.1:1",HTTPS_PROXY:"http://127.0.0.1:1",NO_PROXY:"example.test"});
  try {
    assert.equal(await(await fetch(url,{dispatcher:agent,signal:AbortSignal.timeout(3000)} as RequestInit)).text(),"直连");
    assert.throws(()=>publicSourceDispatcher(url,{address:"8.8.8.8",family:4},{HTTP_PROXY:"socks5://127.0.0.1:1080"}),/HTTP\(S\)/);
  }finally{await agent.close();await new Promise<void>(resolve=>origin.close(()=>resolve()));}
});
