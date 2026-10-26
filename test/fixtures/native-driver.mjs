// Preparation-only: no network/model/Session operation occurs on import.
// Uses the observed official Client Session SDK, not a replacement Host.
export const driverVersion='jiyi-native-driver-v016';
export function installExpression(plan,expectedIndexSha256){
  if(!/^[a-f0-9]{64}$/.test(expectedIndexSha256))throw new Error('Expected actually loaded final source hash required.');
  const material={version:driverVersion,expectedVersion:'0.1.6',expectedIndexSha256,projects:plan.projects,cases:plan.cases.map(({id,project,inputs})=>({id,project,inputs}))};
  const expression=`(${install.toString().replace(/^[ \t]+/gm,'')})(${JSON.stringify(material)})`;
  if(expression.length>8000)throw new Error('Chrome expression exceeds declared tool limit.');
  return expression;
}
function install(plan){
  const remote=window.__jiyiLeadRemote,ui=window.__jiyiLeadUi;
  if(!remote?.session||!ui?.sessions)throw new Error('Declare official remote.session/uiWorkspace injection before install.');
  if(window.__jiyiV016Native)throw new Error('Native ledger already exists; never replace pending owned evidence.');
  const driver={plan,sessions:{},receipts:[]};
  const unwrap=r=>{if(!r?.ok)throw new Error(JSON.stringify(r?.error??r));return r.value;};
  const entry=id=>{const x=driver.sessions[id];if(!x)throw new Error('Unknown owned case');return x;};
  driver.readiness=async()=>{
    const response=await fetch('/api/jiyi?op=state',{cache:'no-store',credentials:'same-origin'});
    const s=await response.json();
    if(!response.ok||s.version!==plan.expectedVersion||s.runtime?.sourceFilesAtStartup?.['lib/index.js']!==plan.expectedIndexSha256)throw new Error('Actual final version/source does not match; no Native input admitted.');
    if(s.settings.relevance.provider!=='openai-codex'||s.settings.relevance.model!=='gpt-6.1-sol'||s.settings.relevance.timeoutMs!==10000||s.settings.retrieval.timeoutMs!==10000)throw new Error('Frozen model/timeout conditions changed.');
    return {version:s.version,runtime:s.runtime,active:{embedding:s.models.embedding.activeRequests,relevance:s.models.relevance.activeRequests}};
  };
  driver.create=async caseId=>{
    await driver.readiness();
    const c=plan.cases.find(x=>x.id===caseId);
    if(!c||driver.sessions[caseId])throw new Error('Absent/duplicate Native case');
    const sessionId=`session-jiyi-v016-${crypto.randomUUID()}`;
    // Mark attempted before RPC: an uncertain creation is not silently retried.
    driver.sessions[caseId]={caseId,sessionId,status:'creating',inputs:{}};
    const made=unwrap(await remote.session.create({sessionId,cwd:plan.projects[c.project].cwd}));
    if(made.sessionId!==sessionId)throw new Error('Unexpected Session reuse');
    const session=ui.sessions.manager.get(sessionId);
    await session.open();
    if(session.openState!=='open'||session.openError)throw new Error('Actual owned Session history did not open successfully.');
    driver.sessions[caseId]={...driver.sessions[caseId],session,status:'created'};
    const records=session.eventSource.getSnapshot().entries;
    const preload=records.filter(x=>x.event?.type==='user/message'&&x.event.data.source?.kind==='plugin:jiyi');
    if(preload.length)throw new Error('Unexpected memory preload before genuine input');
    const selected=unwrap(await remote.session.selectModel({sessionId,provider:'openai-codex',model:'gpt-6.1-sol'}));
    const receipt={kind:'created',caseId,sessionId,selectionResult:selected,preloadCount:0,at:new Date().toISOString()};
    driver.receipts.push(receipt);return receipt;
  };
  driver.submit=async(caseId,inputIndex=0)=>{
    await driver.readiness();
    const owned=entry(caseId),c=plan.cases.find(x=>x.id===caseId),text=c.inputs[inputIndex];
    if(typeof text!=='string'||owned.inputs[inputIndex])throw new Error('Absent/duplicate Native input');
    const requestId=crypto.randomUUID();
    const receipt={kind:'input',caseId,inputIndex,sessionId:owned.sessionId,requestId,text,at:new Date().toISOString(),admitted:false};
    owned.inputs[inputIndex]=receipt;driver.receipts.push(receipt);
    const r=unwrap(await remote.session.prompt({sessionId:owned.sessionId,requestId,mode:'queue',content:[{type:'text',text}],clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}));
    receipt.admitted=true;receipt.result=r;return receipt;
  };
  driver.snapshot=caseId=>{
    const owned=entry(caseId),snap=owned.session.eventSource.getSnapshot();
    return {caseId,sessionId:owned.sessionId,openState:owned.session.openState,running:owned.session.running,openError:owned.session.openError??null,promptError:owned.session.promptError??null,hasMore:snap.hasMore,records:snap.entries.filter(x=>x.type==='event').map(x=>x.event)};
  };
  driver.cancel=async caseId=>{
    if(caseId!=='N07-cancel-A')throw new Error('Only frozen cancellation case A may be cancelled');
    const owned=entry(caseId);
    if(owned.cancelAttempted)throw new Error('Cancellation already attempted; inspect evidence');
    owned.cancelAttempted=true;
    const result=unwrap(await remote.session.cancel({sessionId:owned.sessionId}));
    const receipt={kind:'cancel',caseId,sessionId:owned.sessionId,result,at:new Date().toISOString()};
    driver.receipts.push(receipt);return receipt;
  };
  driver.closeObservers=async()=>{
    for(const owned of Object.values(driver.sessions))if(owned.session)await owned.session.dispose();
    return {observersClosed:true,ownedCases:Object.keys(driver.sessions).length};
  };
  window.__jiyiV016Native=driver;
  return {installed:true,version:plan.version,cases:plan.cases.length,performedNetworkOrModelCalls:false};
}
