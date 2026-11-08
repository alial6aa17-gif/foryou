/**
 * FOR YOU Store — native Node.js server (Node 18+)
 * No npm dependencies. DATA_DIR defaults to ./data; use Railway Volume mount.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = __dirname;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024;
fs.mkdirSync(UPLOAD_DIR, {recursive:true});

const files = {
  users: path.join(DATA_DIR,'users.json'),
  products: path.join(DATA_DIR,'products.json'),
  orders: path.join(DATA_DIR,'orders.json'),
  inventory: path.join(DATA_DIR,'inventory.json'),
  expenses: path.join(DATA_DIR,'expenses.json'),
  settings: path.join(DATA_DIR,'settings.json'),
  sessions: path.join(DATA_DIR,'sessions.json'),
  rate: path.join(DATA_DIR,'rate.json')
};
const seed = {
  users: [],
  products: [],
  orders: [],
  inventory: [],
  expenses: [],
  settings: {
    storeName:'FOR YOU | فور يو', tagline:'هدايا وتوزيعات تصنع لحظات حلوة',
    banner:'توصيل لجميع محافظات العراق خلال 48 ساعة 🚕 | هدايا وتوزيعات فور يو 🌸',
    instagram:'https://www.instagram.com/foryou_astore/',
    instagramHandle:'@foryou_astore', logo:'/assets/logo.png',
    showPrices:true, zainCash:'', mastercard:'', deliveryFee:5000,
    categories:['بوكسات','باقات','تراكات','عطور','توزيعات','إكسسوارات']
  },
  sessions: {}, rate: {}
};
function atomicWrite(file, data) {
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data,null,2), {mode:0o600});
  fs.renameSync(tmp,file);
}
function readStore(name) {
  try { return JSON.parse(fs.readFileSync(files[name],'utf8')); }
  catch { atomicWrite(files[name], seed[name] ?? []); return structuredClone(seed[name] ?? []); }
}
function writeStore(name,data){ atomicWrite(files[name],data); }
const db = {};
for (const name of Object.keys(files)) db[name]=readStore(name);
if (!db.users.length) {
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync('ChangeMe-Now-123!',salt,64).toString('hex');
  db.users=[{id:'owner_'+crypto.randomBytes(4).toString('hex'),username:'owner',name:'المدير العام',role:'owner',salt,hash,defaultPassword:true,createdAt:new Date().toISOString()}];
  writeStore('users',db.users);
}
function persist(name){writeStore(name,db[name]);}
function id(prefix='id'){return prefix+'_'+crypto.randomBytes(8).toString('hex');}
function code(){return 'FY-'+Date.now().toString().slice(-4)+'-'+crypto.randomBytes(2).toString('hex').toUpperCase();}
function scrypt(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
function safeEqual(a,b){try{return crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}catch{return false;}}
function parseCookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{let i=x.indexOf('=');return [x.slice(0,i),decodeURIComponent(x.slice(i+1) || '')]}));}
function session(req){
  const token=parseCookies(req).fy_session;
  if(!token)return null;
  const sess=db.sessions[token];
  if(!sess || sess.expires<Date.now()){delete db.sessions[token];persist('sessions');return null;}
  const user=db.users.find(u=>u.id===sess.userId);
  return user?{token,user}:null;
}
function send(res,status,data,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));}
function html(res,file){const p=path.join(PUBLIC_DIR,file);if(!fs.existsSync(p)){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});fs.createReadStream(p).pipe(res);}
function body(req){return new Promise((resolve,reject)=>{let chunks=[],size=0;req.on('data',c=>{size+=c.length;if(size>MAX_BODY){reject(Object.assign(new Error('Body too large'),{status:413}));req.destroy();}else chunks.push(c);});req.on('end',()=>{try{resolve(chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{});}catch{reject(Object.assign(new Error('Invalid JSON'),{status:400}));}});req.on('error',reject);});}
function requireAuth(req,res,roles=[]){const s=session(req);if(!s){send(res,401,{error:'يلزم تسجيل الدخول'});return null;}if(roles.length&&!roles.includes(s.user.role)){send(res,403,{error:'لا تملك صلاحية الوصول'});return null;}return s;}
function rateLimit(key,limit=8,windowMs=15*60*1000){const now=Date.now();let arr=(db.rate[key]||[]).filter(t=>now-t<windowMs);if(arr.length>=limit){db.rate[key]=arr;persist('rate');return false;}arr.push(now);db.rate[key]=arr;persist('rate');return true;}
function publicProduct(p){return {id:p.id,name:p.name,description:p.description,category:p.category,image:p.image,price:db.settings.showPrices?p.price:null,priceHidden:!db.settings.showPrices,stock:p.stock,active:p.active!==false};}
function jsonSafeUser(u){return {id:u.id,username:u.username,name:u.name,role:u.role,defaultPassword:!!u.defaultPassword};}
function totalOrder(o){return (o.items||[]).reduce((s,i)=>s+(Number(i.price||0)*Number(i.qty||1)),0)+Number(o.extraPackaging||0)+Number(o.deliveryFee||0);}
function route(req,res){
  const u=new URL(req.url,'http://localhost'); const p=u.pathname;
  if(req.method==='GET'&&p==='/'){return html(res,'index.html');}
  if(req.method==='GET'&&p==='/login'){return html(res,'login.html');}
  if(req.method==='GET'&&p==='/dashboard'){return html(res,'dashboard.html');}
  if(req.method==='GET'&&p.startsWith('/uploads/')){const f=path.basename(p);const fp=path.join(UPLOAD_DIR,f);if(!fs.existsSync(fp)){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':mime(fp),'Cache-Control':'public,max-age=86400'});return fs.createReadStream(fp).pipe(res);}
  if(req.method==='GET'&&p==='/api/store'){return send(res,200,{settings:db.settings,products:db.products.filter(x=>x.active!==false).map(publicProduct),categories:db.settings.categories});}
  if(req.method==='GET'&&p==='/api/track'){const c=u.searchParams.get('code');const o=db.orders.find(x=>x.code===c);return o?send(res,200,{code:o.code,status:o.status,updatedAt:o.updatedAt}):send(res,404,{error:'لم نعثر على طلب بهذا الكود'});}
  if(req.method==='POST'&&p==='/api/login')return body(req).then(data=>{
    const ip=req.socket.remoteAddress||'unknown';if(!rateLimit('login:'+ip,7,10*60*1000))return send(res,429,{error:'محاولات كثيرة. انتظر 10 دقائق'});
    const user=db.users.find(x=>x.username===String(data.username||'').trim());
    if(!user||!safeEqual(scrypt(String(data.password||''),user.salt),user.hash))return send(res,401,{error:'اسم المستخدم أو كلمة المرور غير صحيحة'});
    const token=crypto.randomBytes(32).toString('hex');db.sessions[token]={userId:user.id,expires:Date.now()+SESSION_TTL};persist('sessions');
    return send(res,200,{user:jsonSafeUser(user),warning:!!user.defaultPassword},{'Set-Cookie':`fy_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}`});
  }).catch(e=>send(res,e.status||400,{error:e.message}));
  if(req.method==='POST'&&p==='/api/logout'){const s=session(req);if(s){delete db.sessions[s.token];persist('sessions');}return send(res,200,{ok:true},{'Set-Cookie':'fy_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
  if(req.method==='GET'&&p==='/api/me'){const s=session(req);return s?send(res,200,{user:jsonSafeUser(s.user)}):send(res,401,{error:'غير مسجل'});}
  if(req.method==='POST'&&p==='/api/order')return body(req).then(data=>{
    const items=(data.items||[]).map(x=>{const prod=db.products.find(p=>p.id===x.id&&p.active!==false);if(!prod)throw new Error('منتج غير متاح');const qty=Math.max(1,Math.min(50,Number(x.qty)||1));return {productId:prod.id,name:prod.name,qty,price:Number(prod.price||0),cost:Number(prod.cost||0)};});
    if(!items.length)throw new Error('السلة فارغة');
    const o={id:id('ord'),code:code(),customerName:String(data.customerName||'').slice(0,100),phone:String(data.phone||'').slice(0,30),address:String(data.address||'').slice(0,300),notes:String(data.notes||'').slice(0,500),items,extraPackaging:Number(data.extraPackaging||0),deliveryFee:Number(db.settings.deliveryFee||0),status:'تم الرفع',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),source:'storefront',employeeId:null,commission:0,expenses:0};
    if(!o.customerName||!o.phone||!o.address)throw new Error('أدخل الاسم ورقم الهاتف والعنوان');
    for(const item of items){const prod=db.products.find(x=>x.id===item.productId);if(prod.stock!==null&&prod.stock!==undefined){if(prod.stock<item.qty)throw new Error(`المخزون غير كافٍ: ${prod.name}`);prod.stock-=item.qty;}}
    db.orders.unshift(o);persist('products');persist('orders');return send(res,201,{order:{code:o.code,total:totalOrder(o),status:o.status},message:'تم تسجيل الطلب'});
  }).catch(e=>send(res,400,{error:e.message}));
  if(req.method==='GET'&&p.startsWith('/api/')){const s=requireAuth(req,res);if(!s)return;const role=s.user.role;
    if(p==='/api/dashboard'){const orders=db.orders;return send(res,200,{user:jsonSafeUser(s.user),orders,products:db.products,inventory:db.inventory,expenses:db.expenses,users:role==='owner'?db.users.map(jsonSafeUser):[],settings:db.settings});}
    if(p==='/api/orders'){return send(res,200,{orders:db.orders.filter(o=>role==='prep'?true:true).map(o=>role==='prep'?{...o,items:o.items.map(i=>({...i,cost:undefined}))}:o)});}
    if(p==='/api/products'){return send(res,200,{products:db.products});}
    return send(res,404,{error:'غير موجود'});
  }
  if(req.method==='POST'&&p.startsWith('/api/')){const s=requireAuth(req,res);if(!s)return;const role=s.user.role;
    return body(req).then(data=>{
      if(p==='/api/products'){if(role!=='owner')return send(res,403,{error:'المدير فقط'});const product={id:data.id||id('prd'),name:String(data.name||'').slice(0,120),description:String(data.description||'').slice(0,500),category:String(data.category||'بوكسات'),image:String(data.image||''),price:Number(data.price||0),cost:Number(data.cost||0),stock:data.stock===''?null:Number(data.stock||0),active:data.active!==false,createdAt:new Date().toISOString()};if(!product.name)return send(res,400,{error:'اسم المنتج مطلوب'});db.products.unshift(product);persist('products');return send(res,201,{product});}
      if(p==='/api/order/admin'){if(!['owner','admin','sales'].includes(role))return send(res,403,{error:'غير مخول'});const items=(data.items||[]).map(x=>{const prod=db.products.find(p=>p.id===x.id);if(!prod)throw new Error('منتج غير موجود');return {productId:prod.id,name:prod.name,qty:Math.max(1,Number(x.qty)||1),price:prod.price,cost:prod.cost};});const o={id:id('ord'),code:code(),customerName:String(data.customerName||''),phone:String(data.phone||''),address:String(data.address||''),notes:String(data.notes||''),items,extraPackaging:Number(data.extraPackaging||0),deliveryFee:Number(data.deliveryFee||0),status:'تم الرفع',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),source:'instagram',employeeId:s.user.id,commission:Number(data.commission||0),expenses:0};for(const i of items){let prod=db.products.find(p=>p.id===i.productId);if(prod.stock!==null&&prod.stock!==undefined){if(prod.stock<i.qty)throw new Error('المخزون غير كافٍ');prod.stock-=i.qty;}}db.orders.unshift(o);persist('products');persist('orders');return send(res,201,{order:o});}
      if(p==='/api/order/status'){if(!['owner','admin','prep'].includes(role))return send(res,403,{error:'غير مخول'});const o=db.orders.find(x=>x.id===data.id);if(!o)return send(res,404,{error:'الطلب غير موجود'});const statuses=['تم الرفع','تم التجهيز','عند شركة التوصيل','تم التسليم','ملغي'];if(!statuses.includes(data.status))return send(res,400,{error:'حالة غير صحيحة'});if(data.status==='ملغي'&&o.status!=='ملغي'){for(const i of o.items){const prod=db.products.find(p=>p.id===i.productId);if(prod&&prod.stock!==null&&prod.stock!==undefined)prod.stock+=i.qty;}o.commission=0;persist('products');}o.status=data.status;o.updatedAt=new Date().toISOString();persist('orders');return send(res,200,{order:o});}
      if(p==='/api/settings'){if(role!=='owner')return send(res,403,{error:'المدير فقط'});db.settings={...db.settings,...data};persist('settings');return send(res,200,{settings:db.settings});}
      if(p==='/api/expense'){if(role!=='owner')return send(res,403,{error:'المدير فقط'});const e={id:id('exp'),name:String(data.name||'مصروف'),amount:Number(data.amount||0),date:data.date||new Date().toISOString().slice(0,10),category:String(data.category||'عام')};db.expenses.unshift(e);persist('expenses');return send(res,201,{expense:e});}
      if(p==='/api/employee'){if(role!=='owner')return send(res,403,{error:'المدير فقط'});const password=String(data.password||'');if(password.length<10)return send(res,400,{error:'كلمة المرور 10 أحرف على الأقل'});const salt=crypto.randomBytes(16).toString('hex');const user={id:id('usr'),username:String(data.username||'').trim(),name:String(data.name||''),role:['admin','sales','prep'].includes(data.role)?data.role:'sales',salt,hash:scrypt(password,salt),defaultPassword:false,createdAt:new Date().toISOString()};if(!user.username||db.users.some(x=>x.username===user.username))return send(res,400,{error:'اسم المستخدم فارغ أو مستخدم مسبقاً'});db.users.push(user);persist('users');return send(res,201,{user:jsonSafeUser(user)});}
      if(p==='/api/stock'){if(role!=='owner')return send(res,403,{error:'المدير فقط'});const prod=db.products.find(x=>x.id===data.id);if(!prod)return send(res,404,{error:'المنتج غير موجود'});prod.stock=Math.max(0,Number(data.stock)||0);persist('products');return send(res,200,{product:prod});}
      if(p==='/api/upload'){if(role!=='owner')return send(res,403,{error:'المدير فقط'});const raw=String(data.data||'');const match=raw.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);if(!match)return send(res,400,{error:'الصورة يجب أن تكون PNG/JPEG/WEBP'});const bytes=Buffer.from(match[2],'base64');if(bytes.length>5*1024*1024)return send(res,413,{error:'حجم الصورة أكبر من 5MB'});const ext=match[1]==='image/jpeg'?'jpg':match[1].split('/')[1];const name=crypto.randomBytes(12).toString('hex')+'.'+ext;fs.writeFileSync(path.join(UPLOAD_DIR,name),bytes,{flag:'wx',mode:0o600});return send(res,201,{url:'/uploads/'+name});}
      return send(res,404,{error:'غير موجود'});
    }).catch(e=>send(res,400,{error:e.message}));
  }
  res.writeHead(404);res.end('Not found');
}
function mime(fp){return ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'})[path.extname(fp).toLowerCase()]||'application/octet-stream';}
const server=http.createServer((req,res)=>{try{route(req,res);}catch(e){send(res,500,{error:'خطأ داخلي'});}});
server.listen(PORT,'0.0.0.0',()=>console.log(`FOR YOU listening on ${PORT}; DATA_DIR=${DATA_DIR}`));
