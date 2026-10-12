const VERSION='live-token-20261012-1';
const CACHE='alert-disaster-'+VERSION;
const ASSETS=['/','/index.html','/app.css?v='+VERSION,'/core.js?v='+VERSION,'/app.js?v='+VERSION,'/workspaces.js?v='+VERSION,'/audio-worklet.js?v='+VERSION,'/vendor/firebase-app-compat.js','/vendor/firebase-auth-compat.js','/__/firebase/init.json','/manifest.webmanifest','/icon.svg','/icon-192.png','/icon-512.png','/brand/adr-logo.jpg','/fonts/lato-400-latin.woff2','/fonts/lato-700-latin.woff2','/fonts/lato-900-latin.woff2','/fonts/ebgaramond-400-latin.woff2'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('alert-disaster-')&&name!==CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||(url.pathname.startsWith('/__/')&&url.pathname!=='/__/firebase/init.json'))return;
  if(event.request.mode==='navigate'){
    event.respondWith((async()=>{try{return await fetch(event.request);}catch{return (await caches.match('/index.html'))||Response.error();}})());return;
  }
  if(!ASSETS.includes(url.pathname+url.search))return;
  event.respondWith((async()=>{const cached=await caches.match(event.request);return cached||fetch(event.request);})());
});
