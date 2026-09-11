/**
 * APS Rounds v1.4.0 — durable optimistic sync engine
 *
 * Reliability order:
 *  1. persist the mutation in IndexedDB
 *  2. apply the local UI change
 *  3. send to Apps Script in the background
 *  4. delete the queue item only after server acknowledgement
 *
 * Pending operations survive app/browser closure and are retried after login,
 * reconnect, pageshow and visibility restoration.
 */
(function(global){
  'use strict';

  const DB_NAME='aps-rounds-sync-v140';
  const DB_VERSION=1;
  const STORE='operations';
  const MAX_BATCH=10;

  const state={
    configured:false,
    syncing:false,
    timer:null,
    retryMs:1200,
    config:null,
    dbPromise:null
  };

  function nowIso(){return new Date().toISOString()}
  function uuid(){
    if(global.crypto&&typeof global.crypto.randomUUID==='function')return global.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{
      const r=Math.random()*16|0,v=c==='x'?r:(r&0x3|0x8);return v.toString(16)
    })
  }
  function makeOperationId(){return 'op:'+Date.now().toString(36)+':'+uuid().replace(/-/g,'')}

  function openDb(){
    if(state.dbPromise)return state.dbPromise;
    state.dbPromise=new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,DB_VERSION);
      req.onerror=()=>reject(req.error||new Error('Could not open APS pending-sync storage.'));
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains(STORE)){
          const s=db.createObjectStore(STORE,{keyPath:'operationId'});
          s.createIndex('createdAt','createdAt',{unique:false});
          s.createIndex('coalesceKey','coalesceKey',{unique:false});
        }
      };
      req.onsuccess=()=>resolve(req.result);
    });
    return state.dbPromise;
  }

  async function all(){
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readonly');
      const req=tx.objectStore(STORE).getAll();
      req.onsuccess=()=>resolve((req.result||[]).sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))));
      req.onerror=()=>reject(req.error||new Error('Could not read APS pending changes.'));
    });
  }

  async function put(op){
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite');
      tx.objectStore(STORE).put(op);
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error||new Error('Could not save APS pending change.'));
    });
  }

  async function remove(id){
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error||new Error('Could not clear APS pending change.'));
    });
  }

  async function removeSuperseded(coalesceKey,exceptId){
    if(!coalesceKey)return;
    const items=await all();
    for(const x of items){
      if(x.operationId!==exceptId && x.coalesceKey===coalesceKey && x.state!=='sending'){
        await remove(x.operationId);
      }
    }
  }

  async function stats(){
    const items=await all();
    return {
      total:items.length,
      pending:items.filter(x=>x.state==='pending'||x.state==='sending').length,
      failed:items.filter(x=>x.state==='failed').length,
      conflicts:items.filter(x=>x.state==='conflict').length
    };
  }

  async function announce(extra={}){
    let s={total:0,pending:0,failed:0,conflicts:0};
    try{s=await stats()}catch(e){}
    const detail={...s,syncing:state.syncing,online:navigator.onLine,...extra};
    try{global.dispatchEvent(new CustomEvent('aps-sync-state',{detail}))}catch(e){}
    if(state.config&&typeof state.config.onStateChange==='function')state.config.onStateChange(detail);
  }

  function getToken(){
    return state.config
      ? (typeof state.config.getToken==='function'?state.config.getToken():state.config.token)||''
      : '';
  }

  function clientApsKey(createdAt){
    const d=createdAt instanceof Date?createdAt:new Date(createdAt||Date.now());
    const parts=new Intl.DateTimeFormat('en-CA',{
      timeZone:'Asia/Kuala_Lumpur',
      year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',
      hourCycle:'h23'
    }).formatToParts(d).reduce((a,p)=>(a[p.type]=p.value,a),{});
    return 'APS-'+parts.year+parts.month+parts.day+'-'+parts.hour+parts.minute+parts.second+'-'+uuid().replace(/-/g,'').slice(0,4).toUpperCase();
  }

  async function enqueue(input){
    if(!state.configured)throw new Error('APS sync engine is not ready.');
    const op={
      operationId:input.operationId||makeOperationId(),
      kind:String(input.kind||''),
      recordKey:String(input.recordKey||''),
      payload:input.payload||{},
      before:input.before||null,
      coalesceKey:String(input.coalesceKey||''),
      createdAt:input.createdAt||nowIso(),
      attempts:0,
      state:'pending',
      lastError:'',
      nextAttemptAt:0
    };

    // WRITE-AHEAD: durable local persistence happens before visible UI change.
    await put(op);
    await removeSuperseded(op.coalesceKey,op.operationId);

    if(state.config&&typeof state.config.onApply==='function')state.config.onApply(op);
    await announce({reason:'queued'});
    schedule(0);
    return op;
  }

  async function enqueueRegistration(patient){
    const createdAt=nowIso();
    const recordKey=clientApsKey(createdAt);
    return enqueue({
      kind:'register',
      recordKey,
      createdAt,
      payload:{patient},
      before:null,
      coalesceKey:'register:'+recordKey
    });
  }

  async function setState(ids,newState,extra={}){
    const items=await all();
    const map={};items.forEach(x=>map[x.operationId]=x);
    for(const id of ids){
      const x=map[id];if(!x)continue;
      x.state=newState;
      Object.assign(x,extra);
      await put(x);
    }
  }

  async function sendBatch(ops,{keepalive=false}={}){
    const token=getToken();
    if(!token)throw new Error('APS session is not available.');
    const payload={
      action:'batchSync',
      token,
      operations:ops.map(x=>({
        operationId:x.operationId,
        kind:x.kind,
        recordKey:x.recordKey,
        payload:x.payload,
        createdAt:x.createdAt
      }))
    };
    const res=await fetch(state.config.apiUrl,{
      method:'POST',
      redirect:'follow',
      headers:{'Content-Type':'text/plain;charset=utf-8'},
      body:JSON.stringify(payload),
      cache:'no-store',
      credentials:'omit',
      keepalive:!!keepalive
    });
    if(!res.ok)throw new Error('APS sync HTTP '+res.status);
    let out;
    try{out=await res.json()}catch(e){throw new Error('APS sync returned an unreadable response.')}
    if(!out.ok)throw new Error(out.error||'APS sync failed.');
    return out;
  }

  async function applyResponse(ops,out){
    if(!Array.isArray(out.results))throw new Error('APS sync acknowledgement is incomplete.');
    const byId={};out.results.forEach(r=>byId[r.operationId]=r);

    for(const op of ops){
      const r=byId[op.operationId];
      if(!r){
        await setState([op.operationId],'pending',{lastError:'No server acknowledgement.',nextAttemptAt:Date.now()+1800});
        continue;
      }

      if(r.ok){
        await remove(op.operationId);
        if(state.config&&typeof state.config.onConfirmed==='function')state.config.onConfirmed(op,r.result||r);
        continue;
      }

      if(r.conflict){
        op.state='conflict';op.lastError=r.error||'Confirmation required';op.conflict=r;
        await put(op);
        if(state.config&&typeof state.config.onConflict==='function')state.config.onConflict(op,r);
        continue;
      }

      if(r.retryable!==false){
        const delay=Math.min(30000,1200*Math.pow(2,Math.min(op.attempts||0,4)));
        op.state='pending';op.lastError=r.error||'Temporary synchronization error.';
        op.nextAttemptAt=Date.now()+delay;
        await put(op);
      }else{
        op.state='failed';op.lastError=r.error||'Change was not accepted by the master Sheet.';
        await put(op);
        if(state.config&&typeof state.config.onError==='function'){
          const err=new Error(op.lastError);
          err.code=r.errorCode||'';
          err.recordGone=!!r.recordGone;
          err.response=r;
          state.config.onError(op,err);
        }
      }
    }
  }

  async function flush(options={}){
    if(!state.configured||state.syncing||!navigator.onLine||!getToken()){
      await announce({reason:'blocked'});
      return;
    }

    let items=(await all()).filter(x=>
      (x.state==='pending'||x.state==='sending') &&
      (!x.nextAttemptAt||x.nextAttemptAt<=Date.now())
    );
    if(!items.length){await announce({reason:'empty'});return}
    items=items.slice(0,MAX_BATCH);

    state.syncing=true;
    await announce({reason:'sync-start'});
    const ids=items.map(x=>x.operationId);
    for(const x of items){
      x.state='sending';x.attempts=(x.attempts||0)+1;x.lastAttemptAt=nowIso();
      await put(x);
    }

    try{
      const out=await sendBatch(items,{keepalive:!!options.keepalive});
      await applyResponse(items,out);
      state.retryMs=1200;
    }catch(err){
      const msg=String(err&&err.message||err);
      for(const x of items){
        x.state='pending';x.lastError=msg;x.nextAttemptAt=Date.now()+state.retryMs;
        await put(x);
      }
      if(/session expired|session is not available/i.test(msg)){
        if(state.config&&typeof state.config.onAuthExpired==='function')state.config.onAuthExpired();
      }else{
        state.retryMs=Math.min(30000,state.retryMs*2);
        if(!options.keepalive)schedule(state.retryMs);
      }
    }finally{
      state.syncing=false;
      await announce({reason:'sync-finish'});
      if(!options.keepalive){
        const s=await stats();
        if(s.pending)schedule(250);
      }
    }
  }

  async function bestEffortFlush(){
    if(!state.configured||!navigator.onLine||state.syncing||!getToken())return;
    const items=(await all()).filter(x=>x.state==='pending').slice(0,MAX_BATCH);
    if(!items.length)return;
    // Never clear queue entries on unload. The response may not reach JS even
    // when Apps Script applied the operation. Stable IDs make the next retry safe.
    try{await sendBatch(items,{keepalive:true})}catch(e){}
  }

  async function retryAll(){
    const items=await all();
    for(const x of items){
      if(x.state!=='conflict'){
        x.state='pending';x.nextAttemptAt=0;x.lastError='';
        await put(x);
      }
    }
    schedule(0);
    await announce({reason:'manual-retry'});
  }

  async function replayPending(){
    const items=await all();
    const applicable=items.filter(x=>x.state==='pending'||x.state==='sending'||x.state==='failed'||x.state==='conflict');
    if(state.config&&typeof state.config.onReplay==='function')state.config.onReplay(applicable);
    return applicable;
  }

  async function discard(id){
    await remove(id);
    await announce({reason:'discard'});
  }

  async function discardForRecord(recordKey){
    const key=String(recordKey||'');
    if(!key)return 0;
    const items=await all();
    let removed=0;
    for(const x of items){
      if(String(x.recordKey||'')===key){
        await remove(x.operationId);
        removed++;
      }
    }
    await announce({reason:'discard-record',recordKey:key});
    return removed;
  }

  function schedule(ms=0){
    clearTimeout(state.timer);
    state.timer=setTimeout(()=>flush(),Math.max(0,ms));
  }

  function configure(config){
    if(!config||!config.apiUrl)throw new Error('APSOptimisticSync requires apiUrl.');
    state.config=config;
    if(!state.configured){
      global.addEventListener('online',()=>schedule(50));
      global.addEventListener('pageshow',()=>schedule(100));
      document.addEventListener('visibilitychange',()=>{
        if(document.visibilityState==='visible')schedule(100);
        else bestEffortFlush();
      });
      global.addEventListener('pagehide',()=>bestEffortFlush());
    }
    state.configured=true;
    setTimeout(()=>retryAll(),120);
    announce({reason:'configured'});
    return api;
  }

  const api={
    configure,enqueue,enqueueRegistration,flush,bestEffortFlush,retryAll,
    replayPending,discard,discardForRecord,list:all,stats,clientApsKey
  };
  global.APSOptimisticSync=api;
})(window);
