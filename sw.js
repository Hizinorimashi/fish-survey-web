const CACHE = 'fish-survey-v112';   // fish_survey.html の APP_VERSION と番号を揃える
// これが揃わないとアプリが成立しないもの。install時に全部そろわなければ失敗させ、
// 中途半端なキャッシュのまま有効にしない
const CORE = [
  './fish_survey.html',
  './manifest.json',
  './leaflet.css',
  './leaflet.js',
  './vendor/leaflet-rotate.js',
  './icon-192.png',
  './icon-512.png'
];

// 地図タイルの保管場所は2つに分ける。
// - PACK: 利用者が「範囲を囲って保存」した分。上限なし・自動では消さない
// - TILE: 地図を動かして自然に溜まった分。上限つきで、あふれたら古いものから消す
// 分けておかないと、先に保存した範囲がスクロールで押し出されて消える。
const PACK_CACHE = 'fish-map-pack-v1';
const TILE_CACHE = 'fish-map-tiles-v1';
// 同じ場所に鳥・産卵床のアプリもあり、保存できる量は3つで分け合う。
// 産卵床アプリ（3000枚）より控えめにしておく。
const MAX_TILES = 2000;

// 拡張子から、返ってきた中身の種類を検査する。
// HTTP 200 でも、ログイン画面や工事中のHTMLをJSやJSONとして保存しないため。
function typeOkFor(url, res){
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (url.endsWith('.js'))  return ct.includes('javascript') || ct.includes('ecmascript');
  if (url.endsWith('.css')) return ct.includes('css');
  if (url.endsWith('.json') || url.endsWith('/manifest.json')) return ct.includes('json');
  if (url.endsWith('.png')) return ct.includes('png') || ct.includes('image');
  if (url.endsWith('.html') || url.endsWith('/')) return ct.includes('html') || ct === '';
  return true;
}
function cacheable(res, url){ return res && res.ok && res.type === 'basic' && typeOkFor(url, res); }
async function cachePut(cache, url){
  const res = await fetch(url, { cache: 'reload' });
  if (res.ok && typeOkFor(url, res)) { await cache.put(url, res.clone()); return true; }
  throw new Error('bad response for ' + url);
}
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(CORE.map(u => cachePut(c, u)));   // 1つでも失敗なら install 失敗
  })());
  self.skipWaiting();
});

// 古いキャッシュの片付けは「このアプリのもの」だけに限る。
// 同じ場所にある鳥・産卵床アプリのオフライン地図まで消さないため。
function isOwnCache(k){ return k.startsWith('fish-survey-') || k.startsWith('fish-map-'); }
function isKeepCache(k){ return k === CACHE || k === TILE_CACHE || k === PACK_CACHE; }
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => isOwnCache(k) && !isKeepCache(k)).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isTile(url){ return url.includes('cyberjapandata.gsi.go.jp'); }
// 変わらないものはキャッシュ優先。圏外でもすぐ出る
function isStaticVendor(url){
  return url.endsWith('/leaflet.js') || url.endsWith('/leaflet.css') ||
         url.endsWith('/icon-192.png') || url.endsWith('/icon-512.png');
}
// アプリ本体はネット優先で新しいものを取りに行く（ただし待ちすぎない）
function isHtmlShell(url){
  return url.endsWith('/fish_survey.html') || url.endsWith('/') || url.endsWith('/manifest.json');
}
async function handleTile(request){
  const pack = await caches.open(PACK_CACHE);
  const inPack = await pack.match(request);
  if (inPack) return inPack;
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try{
    const res = await fetch(request);
    // 地図タイルは中身の分からない応答(opaque)で返ることがある。
    // ok だけを見ていると1枚も保存されず、「動かして溜まる分」が働かない。
    // 行き先は isTile() で国土地理院に限っているので、opaque も保存してよい
    const keep = res && (res.ok || res.type === 'opaque');
    if (keep){
      const keys = await cache.keys();
      if (keys.length >= MAX_TILES){ for (let i=0;i<200;i++) await cache.delete(keys[i]); }
      await cache.put(request, res.clone());
    }
    return res;
  }catch(e){
    if (cached) return cached;
    return new Response('', { status: 408 });
  }
}

// 画面からの頼みごと（範囲の保存・容量の確認・削除）。
// 時間のかかる処理は e.waitUntil() で押さえる。押さえないと、
// 途中でこの仕組みが休止させられ、保存が尻切れになる
self.addEventListener('message', e => {
  const m = e.data || {};
  const reply = r => { try{ e.ports[0] && e.ports[0].postMessage(r); }catch(err){} };
  const run = async () => {
    if (m.type === 'savePack'){
      const pack = await caches.open(PACK_CACHE);
      let ok=0, fail=0, already=0;
      for (const url of (m.urls||[])){
        try{
          if (await pack.match(url)){ already++; ok++; continue; }
          const res = await fetch(url, { mode:'cors' });
          // 中身の分からない応答は圏外で使えないので、保存したことにしない
          if (res.ok && res.type !== 'opaque'){ await pack.put(url, res.clone()); ok++; }
          else fail++;
        }catch(err){ fail++; }
      }
      reply({ ok, fail, already, total:(m.urls||[]).length });
    } else if (m.type === 'packStats'){
      const pack = await caches.open(PACK_CACHE);
      const keys = await pack.keys();
      let bytes=0;
      for (const req of keys){
        const r = await pack.match(req);
        try{ bytes += (await r.clone().blob()).size; }catch(err){}
      }
      reply({ count: keys.length, bytes });
    } else if (m.type === 'dropPack'){
      // 消してよいURLだけを受け取り、実体を消す。
      // 一覧から消すだけだと、容量を食ったままになる。
      // 消せなかったものは黙って数から外さず、URLごと返す
      const pack = await caches.open(PACK_CACHE);
      let deleted=0; const failed=[];
      for (const url of (m.urls||[])){
        try{
          if (await pack.delete(url)) { deleted++; continue; }
          // もともと入っていなければ、消えているのと同じ
          if (!(await pack.match(url))) { deleted++; continue; }
          failed.push(url);
        }catch(err){ failed.push(url); }
      }
      reply({ deleted, failed, asked:(m.urls||[]).length });
    } else if (m.type === 'clearPacks'){
      await caches.delete(PACK_CACHE);
      reply({ ok:true });
    } else {
      reply({ error:'unknown message type' });
    }
  };
  e.waitUntil(run().catch(err => reply({ error: String(err && err.message || err) })));
});

async function networkFirst(request){
  const cache = await caches.open(CACHE);
  const netP = fetch(request).then(res => {
    if (cacheable(res, request.url)) cache.put(request, res.clone()).catch(()=>{});
    return res;
  });
  const timeoutP = new Promise(resolve => setTimeout(() => resolve('timeout'), 3500));
  try{
    const r = await Promise.race([netP, timeoutP]);
    if (r !== 'timeout' && r && r.ok) return r;
    if (r !== 'timeout' && r){
      const cachedErr = await cache.match(request);
      if (cachedErr) return cachedErr;
      return r;
    }
    const cached = await cache.match(request);
    if (cached) return cached;
    // 通信が切れずに応答だけ止まったとき、いつまでも待たない。
    // 「/」や index.html は控えに無いので、本体をそのまま返して立ち上げる
    //（監査67回目 Minor）
    if (request.mode === 'navigate'){
      const 本体 = await cache.match('./fish_survey.html');
      if (本体) return 本体;
    }
    return await netP;
  }catch(e){
    const cached = await cache.match(request);
    return cached || cache.match('./fish_survey.html');
  }
}

async function cacheFirst(request){
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try{
    const res = await fetch(request);
    if (cacheable(res, request.url)) cache.put(request, res.clone()).catch(()=>{});
    return res;
  }catch(e){
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (isTile(url)){ e.respondWith(handleTile(req)); return; }
  if (req.mode === 'navigate' || isHtmlShell(url)){ e.respondWith(networkFirst(req)); return; }
  if (isStaticVendor(url)){ e.respondWith(cacheFirst(req)); return; }
  // 自分のキャッシュだけを見る（同じ場所の別アプリのキャッシュを覗かない）
  e.respondWith(caches.open(CACHE).then(c => c.match(req)).then(cached => cached || fetch(req)));
});
