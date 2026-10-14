import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerMotionLibraryTools } from './motion-library-tools.js';
import { registerProductionTools } from './production/speech-tools.js';
async function main(){
  const root=process.env.TEXTVIDEO_PLUGIN_ROOT;if(!root)throw new Error('缺少插件发行位置');
  const release=JSON.parse(readFileSync(join(root,'runtime/dist/manifest.json'),'utf8'));
  const server=new McpServer({name:'textvideo-studio',version:release.pluginVersion});const runtime=process.env.TEXTVIDEO_RUNTIME_URL;
  server.registerTool('read_runtime_release',{description:'核对当前 MCP 与已启动 Runtime 同版，不启动执行器。',inputSchema:{}},async()=>{try{if(!runtime)throw new Error('Runtime 地址未配置');const r=await fetch(`${runtime}/healthz`);const health=await r.json() as any;if(health.releaseId!==release.releaseId)throw new Error('MCP 与 Runtime Release 不一致');return {content:[{type:'text',text:JSON.stringify({...health,mcpReleaseId:release.releaseId,aligned:true})}]};}catch(e){return {isError:true,content:[{type:'text',text:String(e)}]};}});
  const call=async(name:string,input:unknown)=>{
    if(!runtime)throw new Error('Runtime 未配置；请通过服务启动入口启动');
    const response=await fetch(`${runtime}/internal/tools/${name}`,{method:'POST',headers:{'Content-Type':'application/json','X-Run-Id':process.env.TEXTVIDEO_RUN_ID??'','X-Run-Token':process.env.TEXTVIDEO_RUN_TOKEN??''},body:JSON.stringify(input),signal:AbortSignal.timeout(180000)});
    const data=await response.json();if(!response.ok)throw new Error(JSON.stringify(data));return data;
  };
  // 阶段来自服务鉴权后的原 Run，不能相信调用方可改的阶段环境变量。
  if(process.env.TEXTVIDEO_RUN_ID&&process.env.TEXTVIDEO_RUN_TOKEN){
    const task=await call('read_production_task',{}) as {stage:string};
    if(task.stage!=='analysis'&&task.stage!=='render')throw new Error('运行阶段无效');
    if(task.stage==='render')registerMotionLibraryTools(server,join(root,'runtime/dist/motion-library'));
    registerProductionTools(server,call,task.stage);
  }
  await server.connect(new StdioServerTransport());
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
