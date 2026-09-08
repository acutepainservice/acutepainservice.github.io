const SHELL_CACHE='aps-rounds-shell-v1.3.6';
const RUNTIME_CACHE='aps-rounds-runtime-v1.3.6';
const SHELL=[
  './','./index.html','./app.css','./app.js','./manifest.webmanifest',
  './icon-192.png','./icon-512.png','./icon-maskable-192.png','./icon-maskable-512.png','./apple-touch-icon.png'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(SHELL_CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==SHELL_CACHE&&k!==RUNTIME_CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return; // Never cache patient/API POST requests.
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;

  if(url.pathname.endsWith('/medications.json')){
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async cache=>{
        const hit=await cache.match(req);
        if(hit)return hit;
        const res=await fetch(req);
        if(res.ok)cache.put(req,res.clone());
        return res;
      }).catch(()=>caches.match(req))
    );
    return;
  }

  if(req.mode==='navigate'){
    event.respondWith(
      fetch(req).then(res=>{
        const clone=res.clone();caches.open(SHELL_CACHE).then(c=>c.put('./index.html',clone));return res;
      }).catch(()=>caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(hit=>hit||fetch(req).then(res=>{
      if(res.ok)caches.open(SHELL_CACHE).then(c=>c.put(req,res.clone()));
      return res;
    }))
  );
});
