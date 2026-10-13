import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { readProductionConfig } from '../../../packages/production-service/src/config.js';
import { createProductionServer } from '../../server/src/production/routes.js';
async function main(){
  const config=readProductionConfig();await fs.mkdir(config.dataRoot,{recursive:true});
  // 一个数据根只有一个常驻服务；异常遗留锁由部署入口核查 PID 后恢复。
  const lock=join(config.dataRoot,'runtime.lock');const handle=await fs.open(lock,'wx');await handle.writeFile(JSON.stringify({pid:process.pid,startedAt:Date.now(),releaseId:config.release.releaseId}));
  let service:Awaited<ReturnType<typeof createProductionServer>>|undefined,stop=false;const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  try{service=await createProductionServer(config);
    const shutdown=()=>{stop=true;service!.runner.stop();};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
    service.app.post('/internal/shutdown',async()=>{setTimeout(shutdown,20);return {state:'stopping'};});
    await service.app.listen({port:config.port,host:config.host});await service.runner.recover();
    await Promise.all([(async()=>{while(!stop){await service!.runner.tick();await sleep(250);}})(),(async()=>{while(!stop){await service!.callbacks.tick();await sleep(250);}})()]);
  }finally{if(service)await service.close();await handle.close();await fs.unlink(lock).catch(()=>{});}
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
