import { createServer } from 'node:net';
import { chmodSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Private same-user IPC, not a web-auth bypass or a public HTTP listener.
// Startup only listens; no files are polled and no evaluation runs automatically.
export async function createEvaluationIpc({dataDir,version,runtime,run}) {
  const socketPath=join(dataDir,`eval-${process.pid}.sock`);
  const endpointPath=join(dataDir,'eval-endpoint.json');
  const sockets=new Set();
  const server=createServer(socket=>{
    sockets.add(socket);const controller=new AbortController();let text='',handled=false;
    socket.setEncoding('utf8');socket.setTimeout(15000,()=>socket.destroy());
    socket.on('error',()=>{});
    socket.on('close',()=>{sockets.delete(socket);controller.abort(Object.assign(new Error('评测客户端已断开'),{code:'ABORTED'}));});
    const reply=body=>{if(!socket.destroyed)socket.end(JSON.stringify(body)+'\n');};
    socket.on('data',chunk=>{
      if(handled) return;
      text+=chunk;
      if(Buffer.byteLength(text)>16384) {handled=true;reply({ok:false,code:'EVAL_INPUT_TOO_LARGE',error:'IPC 请求超过16KiB'});return;}
      if(!text.includes('\n')) return;
      handled=true;socket.setTimeout(0);
      void (async()=>{
        try {
          const request=JSON.parse(text.trim());
          if(request.op==='status' && Object.keys(request).length===1) {reply({ok:true,version,runtime,socketPath});return;}
          if(request.op!=='run' || request.version!==version) throw Object.assign(new Error('需要显式 op=run 及匹配的 version'),{code:'EVAL_VERSION_MISMATCH'});
          const {op,version:requestedVersion,...options}=request;
          reply(await run(options,controller.signal));
        } catch(e) {reply({ok:false,code:e.code||'EVAL_ERROR',error:String(e.message??e).slice(0,2000)});}
      })();
    });
  });
  await new Promise((resolve,reject)=>{
    const onError=e=>{server.off('listening',onListen);reject(e);};
    const onListen=()=>{server.off('error',onError);resolve();};
    server.once('error',onError);server.once('listening',onListen);server.listen(socketPath);
  });
  try {
    chmodSync(socketPath,0o600);
    writeFileSync(endpointPath,JSON.stringify({version,pid:process.pid,loadedAt:runtime.loadedAt,socketPath},null,2)+'\n',{mode:0o600});
    chmodSync(endpointPath,0o600);
  } catch(e) {await new Promise(resolve=>server.close(resolve));throw e;}
  server.unref();
  return async()=>{
    for(const socket of sockets)socket.destroy();
    await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    // Never remove another Host's discovery receipt. net.Server removes its own socket.
    let receipt;
    try {receipt=JSON.parse(readFileSync(endpointPath,'utf8'));} catch(e) {if(e.code!=='ENOENT')throw e;}
    if(receipt?.socketPath===socketPath && receipt?.loadedAt===runtime.loadedAt) unlinkSync(endpointPath);
  };
}
