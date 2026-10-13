import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pluginRoot,deploymentEnvironment } from './production-release.mjs';
// MCP 仅桥接已启动服务，不负责启动或接管业务队列。
const child=spawn(process.execPath,[join(pluginRoot,'runtime/dist/mcp.cjs')],{env:deploymentEnvironment(),windowsHide:true,stdio:'inherit'});
child.on('exit',code=>{process.exitCode=code??1;});child.on('error',error=>{console.error(error.message);process.exitCode=1;});
