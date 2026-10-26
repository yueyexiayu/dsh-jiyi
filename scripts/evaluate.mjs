#!/usr/bin/env node
import { createConnection } from 'node:net';
import { readFileSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { auditEvaluationReturn } from '../lib/eval-integrity.js';

const VERSION='0.1.14';
const help=`jiyi ${VERSION} 隔离副本批量评测（必须先重启加载同版本 Host）
仅查询状态：node scripts/evaluate.mjs --status
显式运行：node scripts/evaluate.mjs --run --input evidence/manual-eval-v018-flash-20261025.json
可选：--cases R:C01,oldU:U05 或 --cases 1,23；--seed 20261025；--concurrency 1；--timeout-ms 10000
可选：--data-dir <jiyi数据目录>（仅定位本机IPC，不修改任何配置）
结果：Host 写入 evidence/eval-runs/<时间戳>/results.json 和 summary.md；正式召回继续、抽取排队，逐写来源审计区分正常写入与污染。CLI 返回后独立检查评测会话污染并写 post-return-integrity.json；passed=false、取证或落盘失败均 exit 1。
不登录网页，不读 cookie/token；客户端断开会取消所属评测。`;

async function exchange(socketPath,request) {
  return new Promise((resolve,reject)=>{
    const socket=createConnection(socketPath);let text='';
    socket.setEncoding('utf8');
    // Per-case deadlines belong to the Host. This is only an initial IPC watchdog.
    socket.setTimeout(15000,()=>socket.destroy(new Error('IPC 连接/首帧超时')));
    socket.on('connect',()=>{socket.setTimeout(0);socket.write(JSON.stringify(request)+'\n');});
    socket.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>2*1024*1024)socket.destroy(new Error('IPC 返回超过2MiB'));});
    socket.on('error',reject);
    socket.on('end',()=>{try{resolve(JSON.parse(text));}catch(e){reject(new Error(`IPC 没有返回合法结果：${e.message}`));}});
  });
}
try {
  const args=process.argv.slice(2),options={};let mode=null,dataDir=join(process.env.DSH_HOME||join(homedir(),'.dsh'),'storages','jiyi');
  if(!args.length||args.includes('--help')) {console.log(help);} else {
    for(let i=0;i<args.length;i++) {
      const key=args[i];
      if(key==='--status'||key==='--run') {if(mode)throw Error('只能指定一个模式');mode=key;continue;}
      const value=args[++i];if(!value||value.startsWith('--'))throw Error(`缺少 ${key} 的参数`);
      if(key==='--input')options.inputPath=value;
      else if(key==='--cases')options.caseIds=value.split(',').map(id=>/^\d+$/.test(id)?Number(id):id);
      else if(key==='--seed')options.seed=Number(value);
      else if(key==='--concurrency')options.concurrency=Number(value);
      else if(key==='--timeout-ms')options.timeoutMs=Number(value);
      else if(key==='--data-dir')dataDir=resolve(value);
      else throw Error(`未知参数 ${key}`);
    }
    if(!mode)throw Error('必须显式指定 --status 或 --run');
    const endpointPath=join(dataDir,'eval-endpoint.json');
    const endpoint=JSON.parse(readFileSync(endpointPath,'utf8'));
    if(endpoint.version!==VERSION || endpoint.socketPath!==join(dataDir,`eval-${endpoint.pid}.sock`))throw Error('Host 版本/IPC路径不匹配；请先完整重启 DSH');
    const stat=lstatSync(endpoint.socketPath);
    if(!stat.isSocket()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw Error('IPC 必须是当前用户的0600 Unix socket');
    const status=await exchange(endpoint.socketPath,{op:'status'});
    if(!status.ok||status.version!==VERSION||status.runtime?.pid!==endpoint.pid||status.runtime?.loadedAt!==endpoint.loadedAt)throw Error('实际 Host 与 discovery receipt 不一致');
    if(mode==='--status')console.log(JSON.stringify(status,null,2));
    else {
      if(!options.inputPath)throw Error('--run 必须带 --input');
      const result=await exchange(endpoint.socketPath,{op:'run',version:VERSION,...options});
      if(result.runDir && result.integrity) {
        const root=realpathSync(fileURLToPath(new URL('../evidence/eval-runs/',import.meta.url)));
        const runDir=realpathSync(result.runDir);
        if(dirname(runDir)!==root)throw Error('Host 返回了非所属的评测目录');
        let audit;
        try {audit=auditEvaluationReturn({sourceDatabase:join(dataDir,'memory.sqlite'),settingsPath:join(dataDir,'settings.json'),expected:result.integrity});}
        catch(e) {audit={schemaVersion:1,at:new Date().toISOString(),window:'cli-after-host-reply',unchanged:false,error:{code:e.code||'EVAL_POST_RETURN_CHECK',message:e.message}};}
        const auditPath=join(runDir,'post-return-integrity.json');
        try {writeFileSync(auditPath,JSON.stringify(audit,null,2)+'\n',{flag:'wx',mode:0o600});result.postReturnAuditPath=auditPath;}
        catch(e) {audit={...audit,unchanged:false,passed:false,writeError:{code:e.code||'EVAL_AUDIT_WRITE',message:e.message}};}
        result.postReturnIntegrity=audit;
        if(!audit.passed) {
          result.hostStatus=result.status;result.ok=false;result.status='integrity-failed-after-return';
          result.error={code:'EVAL_POST_RETURN_INTEGRITY',message:'宿主返回后的正式库/配置或取证文件写入检查失败',hostError:result.error??null};
        }
      } else if(result.ok) throw Error('Host 成功回复缺少评测目录或完整性证明');
      console.log(JSON.stringify(result,null,2));
      if(!result.ok)process.exitCode=1;
    }
  }
} catch(e) {console.error(`jiyi eval 失败：${e.code?e.code+': ':''}${e.message}`);process.exitCode=1;}
