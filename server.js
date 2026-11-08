/**
 * FOR YOU Store — native Node.js starter
 * Node 18+ recommended. No external npm dependencies.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'DATA');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'store.json');
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'foryou_session';
const MAX_BODY = 8 * 1024 * 1024;
const rateMap = new Map();

for (const d of [DATA_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

const defaults = {
  settings: {
    storeName: 'FOR YOU | متجر هدايا',
    tagline: 'تابعونا راح تحتاجونا 💗 | هدايا وتوزيعات كيوت',
    deliveryBanner: 'توصيل محافظات العراق 5 آلاف 🚕 خلال 48 ساعة | اللهم صل على محمد 🌸',
    instagram: 'foryou_astore',
    closetInstagram: 'foryou_closet1',
    telegram: 't.me/foryou_astore',
    deliveryFee: 5000,
    zainCash: '07801234567',
    mastercard: '8821 **** **** 6049',
    logo: '',
    heroImage: '',
    showPrices: true,
    asiaBalance: true,
    badge: '✨ تشكيلة الموسم الوردية الجديدة',
    bannerTitle: 'أجمل الهدايا والبوكسات الكيوت نصنعها بحب خصيصاً لك',
    bannerText: 'بوكسات هياو كيوت، باقات، دبابيس، تراكات وشوية وعطور أصلية بتغليف يأخذ القلب.',
    categories: [
      { id: 'cat-box', name: 'بوكسات 🎁' },
      { id: 'cat-bags', name: 'باقات 💐' },
      { id: 'cat-tracks', name: 'التراكات 🎀' },
      { id: 'cat-perfume', name: 'عطور وعناية 💄' }
    ],
    extras: [
      { id: 'ex-1', name: 'بوكس كيوت وردي مع شريط ستان 🎀', price: 3000 },
      { id: 'ex-2', name: 'تغليف بلورة شفافة مع إضاءة LED ✨', price: 5000 },
      { id: 'ex-3', name: 'علاكة هدايا فور يو مع بطاقة إهداء 💗', price: 1500 }
    ]
  },
  users: [],
  products: [],
  orders: [],
  expenses: [],
  materials: [],
  counters: { order: 1042, product: 1, expense: 1, material: 1, user: 1 },
  sessions: {}
};

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const db = structuredClone(defaults);
    const salt = crypto.randomBytes(16).toString('hex');
    db.users.push({
      id: 'u-owner-1', name: 'المدير العام', username: 'admin123',
      role: 'owner', salt, hash: scryptHash('Aa2323@@', salt),
      mustChangePassword: true, salary: 0, commission: 0, active: true,
      createdAt: new Date().toISOString()
    });
    atomicWrite(DB_FILE, JSON.stringify(db, null, 2));
    return db;
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const k of Object.keys(defaults)) if (db[k] === undefined) db[k] = structuredClone(defaults[k]);
    return db;
  } catch {
    throw new Error('store.json is invalid; restore a backup before restarting.');
  }
}
function atomicWrite(file, content) {
  const tmp = file + '.tmp-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
let db = loadDB();
function save() { atomicWrite(DB_FILE, JSON.stringify(db, null, 2)); }
function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function safeEqual(a, b) {
  try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  catch { return false; }
}
function id(prefix='id') { return prefix + '-' + crypto.randomBytes(9).toString('base64url'); }
function code() { return `FY-${db.counters.order}-${crypto.randomBytes(2).toString('hex').toUpperCase()}${crypto.randomBytes(1).toString('hex').toUpperCase()}`; }
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function text(res, status, body, type='text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body);
}
function cookieOptions() { return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL/1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > -1) out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  const s = token && db.sessions[token];
  if (!s || s.expires < Date.now()) { if (s) delete db.sessions[token]; return null; }
  const u = db.users.find(x => x.id === s.userId && x.active);
  return u || null;
}
function requireRole(req, res, roles) {
  const user = currentUser(req);
  if (!user) { json(res, 401, { error: 'سجّل الدخول أولاً' }); return null; }
  if (!roles.includes(user.role)) { json(res, 403, { error: 'ما عندك صلاحية لهذه الصفحة' }); return null; }
  return user;
}
function rateLimit(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  const key = ip + ':' + (req.url.startsWith('/api/login') ? 'login' : 'api');
  const now = Date.now(), entry = rateMap.get(key) || { start: now, count: 0 };
  if (now - entry.start > 60_000) { entry.start = now; entry.count = 0; }
  entry.count++; rateMap.set(key, entry);
  const limit = key.endsWith(':login') ? 8 : 180;
  if (entry.count > limit) { json(res, 429, { error: 'محاولات كثيرة، انتظر دقيقة' }); return false; }
  return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; req.on('data', chunk => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_BODY) { reject(Object.assign(new Error('حجم الطلب كبير'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(Object.assign(new Error('JSON غير صالح'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function cleanUser(u) {
  return { id:u.id, name:u.name, username:u.username, role:u.role, salary:u.salary||0, commission:u.commission||0, active:u.active, mustChangePassword:!!u.mustChangePassword };
}
function publicProduct(p) {
  const settings = db.settings;
  return { ...p, wholesale: undefined, cost: undefined, price: settings.showPrices ? p.price : null };
}
function stageLabel(stage) {
  return ({uploaded:'تم الرفع', prepared:'تم التجهيز', courier:'عند شركة التوصيل', delivered:'تم التسليم', cancelled:'ملغي'})[stage] || stage;
}
function dateWithin(date, from, to) {
  const t = new Date(date).getTime(); return (!from || t >= new Date(from).getTime()) && (!to || t <= new Date(to+'T23:59:59').getTime());
}
function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const routes = {'/':'index.html','/index.html':'index.html','/login':'login.html','/login.html':'login.html','/dashboard':'dashboard.html','/dashboard.html':'dashboard.html'};
  const file = routes[pathname] || (pathname.startsWith('/uploads/') ? path.join(UPLOAD_DIR, path.basename(pathname)) : null);
  if (!file) return text(res,404,'Not found');
  const full = path.isAbsolute(file) ? file : path.join(__dirname, file);
  if (!full.startsWith(path.resolve(__dirname)) && !full.startsWith(path.resolve(UPLOAD_DIR))) return text(res,403,'Forbidden');
  if (!fs.existsSync(full)) return text(res,404,'Not found');
  const ext = path.extname(full).toLowerCase();
  const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
  res.writeHead(200, {'Content-Type':types[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'});
  fs.createReadStream(full).pipe(res);
}
async function handle(req,res) {
  if (!rateLimit(req,res)) return;
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req,res);
  if (req.method === 'GET' && p === '/api/public') {
    return json(res,200,{settings:db.settings,products:db.products.filter(x=>x.active!==false).map(publicProduct),categories:db.settings.categories,extras:db.settings.extras});
  }
  if (req.method === 'POST' && p === '/api/login') {
    const body = await readBody(req);
    const username = String(body.username||'').trim().toLowerCase(), password = String(body.password||'');
    const user = db.users.find(x=>x.username.toLowerCase()===username && x.active);
    if (!user || !safeEqual(scryptHash(password,user.salt),user.hash)) return json(res,401,{error:'اسم المستخدم أو كلمة المرور غير صحيحة'});
    const token = crypto.randomBytes(32).toString('base64url');
    db.sessions[token] = { userId:user.id, expires:Date.now()+SESSION_TTL };
    save();
    res.writeHead(200,{'Set-Cookie':`${COOKIE}=${encodeURIComponent(token)}; ${cookieOptions()}`,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    return res.end(JSON.stringify({user:cleanUser(user),redirect:'/dashboard.html'}));
  }
  if (req.method === 'POST' && p === '/api/logout') {
    const token = parseCookies(req)[COOKIE]; if (token) delete db.sessions[token]; save();
    res.writeHead(200,{'Set-Cookie':`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,'Content-Type':'application/json'}); return res.end('{"ok":true}');
  }
  if (req.method === 'GET' && p === '/api/me') {
    const u=currentUser(req); return u ? json(res,200,{user:cleanUser(u)}) : json(res,401,{error:'غير مسجل'});
  }
  if (req.method === 'GET' && p === '/api/track') {
    const track=String(url.searchParams.get('code')||'').trim().toUpperCase();
    const o=db.orders.find(x=>x.trackCode===track);
    return o ? json(res,200,{code:o.trackCode,stage:o.stage,stageLabel:stageLabel(o.stage),createdAt:o.createdAt,customerName:o.customerName}) : json(res,404,{error:'ما لقينا طلب بهذا الكود'});
  }
  if (req.method === 'POST' && p === '/api/orders') {
    const body=await readBody(req);
    const items=Array.isArray(body.items)?body.items:[];
    if (!items.length) return json(res,400,{error:'السلة فارغة'});
    const snapshots=[];
    for(const line of items){
      const product=db.products.find(x=>x.id===line.productId && x.active!==false);
      const qty=Math.max(1,Math.min(99,Number(line.qty)||1));
      if(!product) return json(res,400,{error:'منتج غير موجود'});
      if(product.stock < qty) return json(res,409,{error:`الكمية غير متوفرة: ${product.name}`});
      snapshots.push({productId:product.id,name:product.name,qty,price:Number(product.price||0),cost:Number(product.cost||product.wholesale||0),image:product.image||''});
    }
    const extras=(Array.isArray(body.extras)?body.extras:[]).map(x=>db.settings.extras.find(e=>e.id===x)).filter(Boolean).map(x=>({...x}));
    const subtotal=snapshots.reduce((a,x)=>a+x*x.qty,0), extraTotal=extras.reduce((a,x)=>a+Number(x.price||0),0);
    const order={id:id('ord'),trackCode:code(),customerName:String(body.customerName||'').slice(0,100),phone:String(body.phone||'').slice(0,30),governorate:String(body.governorate||'').slice(0,60),address:String(body.address||'').slice(0,300),note:String(body.note||'').slice(0,500),items:snapshots,extras,subtotal,extraTotal,total:subtotal+extraTotal,deliveryFee:Number(db.settings.deliveryFee||0),stage:'uploaded',createdAt:new Date().toISOString(),cancelledAt:null};
    db.counters.order++;
    for(const line of snapshots){const product=db.products.find(x=>x.id===line.productId);product.stock-=line.qty;}
    db.orders.unshift(order); save();
    return json(res,201,{order:{trackCode:order.trackCode,total:order.total,stage:order.stage},message:orderMessage(order)});
  }
  if (req.method === 'GET' && p === '/api/admin/data') {
    const user=requireRole(req,res,['owner','admin','supplier']); if(!user)return;
    const safeOrders=db.orders.map(o=> user.role==='supplier' ? {...o,items:o.items.map(i=>({...i,cost:undefined,wholesale:undefined})),subtotal:undefined,extraTotal:undefined} : o);
    return json(res,200,{user:cleanUser(user),settings:db.settings,products:user.role==='supplier'?db.products.map(x=>({...x,cost:undefined,wholesale:undefined})):db.products,orders:safeOrders,users:user.role==='owner'?db.users.map(cleanUser):[],expenses:user.role==='owner'?db.expenses:[],materials:user.role==='owner'?db.materials:[]});
  }
  if (req.method === 'POST' && p === '/api/admin/settings') {
    const user=requireRole(req,res,['owner']);if(!user)return; const b=await readBody(req);
    const allowed=['storeName','tagline','deliveryBanner','instagram','closetInstagram','telegram','deliveryFee','zainCash','mastercard','logo','heroImage','showPrices','asiaBalance','badge','bannerTitle','bannerText'];
    for(const k of allowed) if(b[k]!==undefined) db.settings[k]=b[k];
    if(Array.isArray(b.categories)) db.settings.categories=b.categories.slice(0,30).map(x=>({id:String(x.id||id('cat')),name:String(x.name||'').slice(0,60)}));
    if(Array.isArray(b.extras)) db.settings.extras=b.extras.slice(0,50).map(x=>({id:String(x.id||id('ex')),name:String(x.name||'').slice(0,100),price:Math.max(0,Number(x.price)||0)}));
    save();return json(res,200,{ok:true});
  }
  if (req.method === 'POST' && p === '/api/admin/products') {
    const user=requireRole(req,res,['owner','admin']);if(!user)return;const b=await readBody(req);
    const product={id:id('prd'),name:String(b.name||'').slice(0,120),category:String(b.category||'').slice(0,80),price:Math.max(0,Number(b.price)||0),cost:user.role==='owner'?Math.max(0,Number(b.cost)||0):0,stock:Math.max(0,Math.floor(Number(b.stock)||0)),sizes:String(b.sizes||'').slice(0,120),description:String(b.description||'').slice(0,500),image:String(b.image||'').slice(0,500),active:true,createdAt:new Date().toISOString()};
    if(!product.name)return json(res,400,{error:'اسم المنتج مطلوب'});
    db.products.unshift(product);db.counters.product++;save();return json(res,201,{product});
  }
  if (req.method === 'PATCH' && p.startsWith('/api/admin/products/')) {
    const user=requireRole(req,res,['owner','admin']);if(!user)return;const pid=p.split('/').pop(),b=await readBody(req),x=db.products.find(v=>v.id===pid);if(!x)return json(res,404,{error:'المنتج غير موجود'});
    for(const k of ['name','category','price','stock','sizes','description','image','active']) if(b[k]!==undefined)x[k]=k==='price'||k==='stock'?Math.max(0,Number(b[k])||0):b[k];
    if(user.role==='owner'&&b.cost!==undefined)x.cost=Math.max(0,Number(b.cost)||0);save();return json(res,200,{product:x});
  }
  if (req.method === 'DELETE' && p.startsWith('/api/admin/products/')) {
    const user=requireRole(req,res,['owner','admin']);if(!user)return;const pid=p.split('/').pop();db.products=db.products.filter(x=>x.id!==pid);save();return json(res,200,{ok:true});
  }
  if (req.method === 'PATCH' && p.startsWith('/api/admin/orders/')) {
    const user=requireRole(req,res,['owner','admin','supplier']);if(!user)return;const oid=p.split('/').pop(),b=await readBody(req),o=db.orders.find(x=>x.id===oid);if(!o)return json(res,404,{error:'الطلب غير موجود'});
    const next=String(b.stage||o.stage);if(!['uploaded','prepared','courier','delivered','cancelled'].includes(next))return json(res,400,{error:'حالة غير صحيحة'});
    if(next==='cancelled'&&o.stage!=='cancelled'){for(const line of o.items){const pr=db.products.find(x=>x.id===line.productId);if(pr)pr.stock+=line.qty;}o.cancelledAt=new Date().toISOString();}
    if(next!=='cancelled'&&o.stage==='cancelled')return json(res,409,{error:'لا يمكن إعادة الطلب الملغي إلى مسار التجهيز'});
    o.stage=next;o.updatedAt=new Date().toISOString();save();return json(res,200,{order:o});
  }
  if (req.method === 'POST' && p === '/api/admin/users') {
    const user=requireRole(req,res,['owner']);if(!user)return;const b=await readBody(req),username=String(b.username||'').trim().toLowerCase(),password=String(b.password||'');
    if(!username||password.length<8||!['admin','supplier'].includes(b.role))return json(res,400,{error:'اسم المستخدم وكلمة مرور 8 أحرف ودور صحيح مطلوبة'});
    if(db.users.some(x=>x.username.toLowerCase()===username))return json(res,409,{error:'اسم المستخدم موجود'});
    const salt=crypto.randomBytes(16).toString('hex'),u={id:id('usr'),name:String(b.name||username).slice(0,80),username,role:b.role,salt,hash:scryptHash(password,salt),mustChangePassword:!!b.mustChangePassword,salary:Math.max(0,Number(b.salary)||0),commission:Math.max(0,Number(b.commission)||0),active:true,createdAt:new Date().toISOString()};
    db.users.push(u);db.counters.user++;save();return json(res,201,{user:cleanUser(u)});
  }
  if (req.method === 'PATCH' && p.startsWith('/api/admin/users/')) {
    const user=requireRole(req,res,['owner']);if(!user)return;const uid=p.split('/').pop(),b=await readBody(req),u=db.users.find(x=>x.id===uid);if(!u)return json(res,404,{error:'المستخدم غير موجود'});
    if(b.active!==undefined)u.active=!!b.active;if(b.salary!==undefined)u.salary=Math.max(0,Number(b.salary)||0);if(b.commission!==undefined)u.commission=Math.max(0,Number(b.commission)||0);
    if(b.password){if(String(b.password).length<8)return json(res,400,{error:'كلمة المرور 8 أحرف على الأقل'});u.salt=crypto.randomBytes(16).toString('hex');u.hash=scryptHash(String(b.password),u.salt);u.mustChangePassword=!!b.mustChangePassword;}
    save();return json(res,200,{user:cleanUser(u)});
  }
  if (req.method === 'POST' && p === '/api/admin/expenses') {
    const user=requireRole(req,res,['owner']);if(!user)return;const b=await readBody(req),e={id:id('exp'),description:String(b.description||'').slice(0,160),category:String(b.category||'misc'),amount:Math.max(0,Number(b.amount)||0),date:String(b.date||new Date().toISOString().slice(0,10)),createdBy:user.id};if(!e.description||!e.amount)return json(res,400,{error:'الوصف والمبلغ مطلوبان'});db.expenses.unshift(e);db.counters.expense++;save();return json(res,201,{expense:e});
  }
  if (req.method === 'POST' && p === '/api/admin/materials') {
    const user=requireRole(req,res,['owner','admin']);if(!user)return;const b=await readBody(req),m={id:id('mat'),name:String(b.name||'').slice(0,100),qty:Math.max(0,Number(b.qty)||0),threshold:Math.max(0,Number(b.threshold)||0),unit:String(b.unit||'قطعة')};if(!m.name)return json(res,400,{error:'اسم المادة مطلوب'});db.materials.unshift(m);db.counters.material++;save();return json(res,201,{material:m});
  }
  if (req.method === 'PATCH' && p.startsWith('/api/admin/materials/')) {
    const user=requireRole(req,res,['owner','admin']);if(!user)return;const mid=p.split('/').pop(),b=await readBody(req),m=db.materials.find(x=>x.id===mid);if(!m)return json(res,404,{error:'المادة غير موجودة'});if(b.qty!==undefined)m.qty=Math.max(0,Number(b.qty)||0);if(b.threshold!==undefined)m.threshold=Math.max(0,Number(b.threshold)||0);save();return json(res,200,{material:m});
  }
  return json(res,404,{error:'المسار غير موجود'});
}
const server=http.createServer((req,res)=>{handle(req,res).catch(err=>{if(!res.headersSent)json(res,err.status||500,{error:err.status?err.message:'حدث خطأ داخلي'});else res.destroy();});});
server.listen(PORT,'0.0.0.0',()=>console.log(`FOR YOU running on ${PORT}; DATA_DIR=${DATA_DIR}`));
