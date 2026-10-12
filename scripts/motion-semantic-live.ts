/** 隔离开发验收：仅写指定测试工作区，不连接生产项目或 Worker 队列。 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createApplication } from "@videocut/application";
import { ComfyUIBridgeClient } from "@videocut/bridge";
import { readRuntimeConfig } from "@videocut/project-overview";
import { processClaimedJob } from "@videocut/job-runtime";
import { loadLibraryIndex } from "../references/motion-cases/skillry/tools/library-store.mjs";
import { runMotionLibrarySearch } from "../apps/job-worker/src/motion-library.js";
import { digest } from "../packages/media-intelligence/src/index.js";

const root=resolve(process.argv[2]??".repair-validation/continuous-semantic"),app=createApplication(root);
const config=readRuntimeConfig(),bridge=new ComfyUIBridgeClient(config.bridge.apiBaseUrl);
try{
  const index=loadLibraryIndex(resolve("references/motion-cases/skillry"));
  const project=app.createProject({name:"机制语义检索隔离验收"});
  const projectId=project.snapshot.project.id;
  const request={stages:["外框不动，内部内容持续向上滚动", "前景主体继续活动，后层文字接管重点", "前一结果缩小保留，观察推向下一内容"],limit:12};
  const payload={request,source_sha256:index.source_sha256,modelConfig:{...config.semantic,apiBaseUrl:config.bridge.apiBaseUrl}};
  const submitted=app.repository.createJob({projectId,kind:"motion_library_search",payload,idempotencyKey:digest(payload)});
  console.log(JSON.stringify({root,projectId,jobId:submitted.id,count:index.count}));
  const job=app.claimNextJob(["motion_library_search"],60000)!;
  await processClaimedJob(app,job,(value)=>runMotionLibrarySearch(app,value,bridge));
  const completed=app.trackJob(job.id);
  await mkdir(root,{recursive:true});await writeFile(join(root,"semantic-live.json"),JSON.stringify(completed,null,2));
  console.log(JSON.stringify({status:completed.status,error:completed.error,diagnostics:completed.result?.diagnostics,revision:app.readProject(projectId).revision.number}));
  if(completed.status!=="succeeded")process.exitCode=1;
}finally{app.close();}
