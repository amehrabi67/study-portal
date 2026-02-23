// ─────────────────────────────────────────────────────────────────────────────
//  Purdue Cognitive Fatigue Study — Multi-Portal App
//
//  Backend:  Firebase Firestore (real-time, persistent across all users)
//  Emails:   EmailJS (participant confirmation + collector notification)
//  Export:   SheetJS — 3-sheet Excel download
//
//  URL hash routing:
//    #participant  →  Student registration (shareable link)
//    #collector    →  Collector dashboard  (PIN protected)
//    #admin        →  Admin panel          (PIN protected)
//    (default)     →  Landing page
//
//  ⚠️  Before going live, paste your Firebase config into FIREBASE_CONFIG
//      and your EmailJS IDs into EMAILJS_CONFIG below.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

// ─── 🔧 YOUR CONFIG — fill these in ──────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyBgYjpQ58_0BDEpzO-rqB0vOvfINgJHiF8",
  authDomain:        "cognitive-fatigue-hrv.firebaseapp.com",
  projectId:         "cognitive-fatigue-hrv",
  storageBucket:     "cognitive-fatigue-hrv.firebasestorage.app",
  messagingSenderId: "1046914179843",
  appId:             "1:1046914179843:web:180eb15cc9ea53db257f36",
};

const EMAILJS_CONFIG = {
  serviceId:              "service_7n9kj6l",       // ← from Step 2.1
  participantTemplateId:  "participant_confirmation",
  collectorTemplateId:    "collector_notification",
  publicKey:              "GaKWcX4-kTqTYOuzt", // ← from Step 2.3
};

// ─── PINs — change before going live ─────────────────────────────────────────
const ADMIN_PIN = "0000";

// ─── Staff roster ─────────────────────────────────────────────────────────────
const STAFF_BASE = [
  { id:"s1", name:"Amirreza Mehrabi", role:"Lead Data Collector", avatar:"AM", color:"#2D6A4F", pin:"1234", email:"amehrabi@purdue.edu" },
  { id:"s2", name:"Sarah Chen",       role:"Data Collector",      avatar:"SC", color:"#1B4965", pin:"5678", email:"schen@purdue.edu"    },
  { id:"s3", name:"Marcus Rivera",    role:"Data Collector",      avatar:"MR", color:"#6B2737", pin:"9012", email:"mrivera@purdue.edu"  },
];

const DEFAULT_SLOTS = {
  s1:{ "2026-03-02":["9:00 AM","10:00 AM","2:00 PM","3:00 PM"],"2026-03-03":["11:00 AM","1:00 PM","4:00 PM"],"2026-03-05":["1:00 PM","2:00 PM","3:00 PM"],"2026-03-09":["9:00 AM","11:00 AM","2:00 PM"],"2026-03-10":["10:00 AM","1:00 PM","3:00 PM"] },
  s2:{ "2026-03-02":["10:00 AM","11:00 AM","3:00 PM"],"2026-03-03":["9:00 AM","2:00 PM","4:00 PM"],"2026-03-05":["10:00 AM","11:00 AM","1:00 PM"],"2026-03-09":["9:00 AM","10:00 AM","2:00 PM"],"2026-03-12":["10:00 AM","1:00 PM","2:00 PM"] },
  s3:{ "2026-03-03":["10:00 AM","11:00 AM","3:00 PM","4:00 PM"],"2026-03-04":["1:00 PM","2:00 PM","3:00 PM"],"2026-03-09":["11:00 AM","1:00 PM","3:00 PM"],"2026-03-11":["9:00 AM","10:00 AM","1:00 PM","2:00 PM"] },
};
const DEFAULT_CAPACITY = { s1:20, s2:18, s3:15 };

const ALL_TIMES = ["8:00 AM","9:00 AM","10:00 AM","11:00 AM","12:00 PM","1:00 PM","2:00 PM","3:00 PM","4:00 PM","5:00 PM","6:00 PM"];
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getDIM  = (y,m)=>new Date(y,m+1,0).getDate();
const getFD   = (y,m)=>new Date(y,m,1).getDay();
const fmtKey  = (y,m,d)=>`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
const fmtDisp = s=>{const[y,m,d]=s.split("-");return `${MONTHS[parseInt(m)-1]} ${parseInt(d)}, ${y}`;};
const nowISO  = ()=>new Date().toISOString();
const uid     = ()=>Math.random().toString(36).slice(2,10).toUpperCase();

// ─── Firebase abstraction ─────────────────────────────────────────────────────
// Lazy-loads Firebase SDK from CDN so no npm install needed for quick deploys.
// Falls back to localStorage if Firebase isn't configured yet (demo mode).

let _db = null;
let _fbReady = false;
const _fbQueue = [];

function isConfigured() {
  return FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";
}

async function getDB() {
  if (_db) return _db;
  if (!isConfigured()) return null;

  return new Promise((resolve) => {
    if (_fbReady) { resolve(_db); return; }
    _fbQueue.push(resolve);

    if (document.getElementById("firebase-app-script")) return;

    const loadScript = (src, id) => new Promise(res => {
      const s = document.createElement("script");
      s.src = src; s.id = id; s.onload = res;
      document.head.appendChild(s);
    });

    (async () => {
      await loadScript("https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js",     "firebase-app-script");
      await loadScript("https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js","firebase-fs-script");
      const app = window.firebase.initializeApp(FIREBASE_CONFIG);
      _db = app.firestore();
      _fbReady = true;
      _fbQueue.forEach(r => r(_db));
    })();
  });
}

// CRUD wrappers — transparent Firestore ↔ localStorage fallback
const LS = {
  get:  (k)  => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set:  (k,v)=> { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

async function fbGet(collection, docId, fallback=null) {
  const db = await getDB();
  if (!db) return LS.get(`${collection}/${docId}`) ?? fallback;
  try {
    const snap = await db.collection(collection).doc(docId).get();
    return snap.exists ? snap.data() : fallback;
  } catch { return fallback; }
}

async function fbSet(collection, docId, data) {
  const db = await getDB();
  if (!db) { LS.set(`${collection}/${docId}`, data); return; }
  try { await db.collection(collection).doc(docId).set(data, { merge: true }); } catch {}
}

async function fbAdd(collection, data) {
  const db = await getDB();
  const id = uid();
  if (!db) {
    const list = LS.get(collection) || [];
    LS.set(collection, [...list, { ...data, id }]);
    return id;
  }
  try {
    const ref = await db.collection(collection).add({ ...data, id });
    return ref.id;
  } catch { return id; }
}

async function fbList(collection) {
  const db = await getDB();
  if (!db) return LS.get(collection) || [];
  try {
    const snap = await db.collection(collection).orderBy("registeredAt","desc").get();
    return snap.docs.map(d => d.data());
  } catch { return LS.get(collection) || []; }
}

// Real-time listener (Firestore onSnapshot, falls back to noop)
function fbListen(collection, callback) {
  if (!isConfigured()) { callback(LS.get(collection) || []); return ()=>{}; }
  let unsub = ()=>{};
  getDB().then(db => {
    if (!db) { callback([]); return; }
    unsub = db.collection(collection)
      .orderBy("registeredAt","desc")
      .onSnapshot(snap => callback(snap.docs.map(d=>d.data())));
  });
  return ()=>unsub();
}

// ─── EmailJS abstraction ──────────────────────────────────────────────────────
async function loadEmailJS() {
  if (window.emailjs) return window.emailjs;
  if (EMAILJS_CONFIG.serviceId === "YOUR_SERVICE_ID") return null;
  return new Promise(res => {
    if (document.getElementById("emailjs-script")) { res(window.emailjs); return; }
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@emailjs/browser@3/dist/email.min.js";
    s.id  = "emailjs-script";
    s.onload = ()=>{ window.emailjs.init(EMAILJS_CONFIG.publicKey); res(window.emailjs); };
    document.head.appendChild(s);
  });
}

async function sendEmails(booking, form, staff) {
  const ejs = await loadEmailJS();
  if (!ejs) return; // EmailJS not configured — silent skip in demo mode

  const base = {
    participant_name:  booking.name,
    participant_email: booking.email,
    participant_age:   booking.age,
    participant_level: `${form.year} · ${form.major}`,
    participant_phone: booking.phone || "Not provided",
    collector_name:    staff.name,
    collector_email:   staff.email,
    session_date:      fmtDisp(booking.date),
    session_time:      booking.time,
    irb_number:        "IRB-2025-304",
  };

  await ejs.send(EMAILJS_CONFIG.serviceId, EMAILJS_CONFIG.participantTemplateId,
    { ...base, to_email: booking.email, to_name: booking.name });

  await ejs.send(EMAILJS_CONFIG.serviceId, EMAILJS_CONFIG.collectorTemplateId,
    { ...base, to_email: staff.email, to_name: staff.name });
}

// ─────────────────────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@300;400;500;600&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#F5F0E8;font-family:'DM Sans',sans-serif;color:#1A1A1A;min-height:100vh;}
.app{min-height:100vh;background:#F5F0E8;background-image:radial-gradient(circle at 18% 18%,rgba(45,106,79,.07) 0%,transparent 50%),radial-gradient(circle at 82% 82%,rgba(27,73,101,.07) 0%,transparent 50%);}

/* ── LANDING ── */
.landing{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:40px 20px;text-align:center;}
.landing-logo{font-size:48px;margin-bottom:14px;animation:float 3s ease-in-out infinite;}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
.landing-title{font-family:'Playfair Display',serif;font-size:clamp(24px,5vw,38px);line-height:1.2;margin-bottom:10px;max-width:540px;}
.landing-sub{font-size:13px;color:#AAA;font-weight:300;margin-bottom:44px;letter-spacing:.3px;}
.landing-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;max-width:780px;width:100%;}
.lcard{background:white;border-radius:18px;padding:32px 24px;box-shadow:0 4px 24px rgba(0,0,0,.07);cursor:pointer;transition:all .25s;border:2px solid transparent;text-align:left;}
.lcard:hover{transform:translateY(-4px);box-shadow:0 16px 44px rgba(0,0,0,.12);}
.lcard.p:hover{border-color:#2D6A4F;}.lcard.c:hover{border-color:#1B4965;}.lcard.a:hover{border-color:#6B2737;}
.lc-icon{font-size:28px;margin-bottom:12px;}
.lc-title{font-family:'Playfair Display',serif;font-size:18px;margin-bottom:5px;}
.lc-desc{font-size:12px;color:#AAA;line-height:1.6;font-weight:300;}
.lc-link{margin-top:14px;font-size:11px;color:#CCC;letter-spacing:.5px;font-weight:600;transition:color .2s;}
.lcard:hover .lc-link{color:#555;}
.url-chips{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:28px;}
.url-chip{background:rgba(0,0,0,.06);border-radius:20px;padding:6px 14px;font-size:11px;font-weight:600;letter-spacing:.3px;color:#888;font-family:'DM Mono',monospace,sans-serif;cursor:pointer;transition:all .2s;}
.url-chip:hover{background:rgba(0,0,0,.1);color:#444;}
.demo-banner{display:inline-flex;align-items:center;gap:8px;background:#FFF8EC;border:1.5px solid #F5D98B;border-radius:20px;padding:7px 16px;font-size:12px;color:#A07000;margin-bottom:28px;font-weight:500;}

/* ── HEADER ── */
.hdr{background:#1A1A1A;color:#F5F0E8;padding:24px 36px;position:relative;overflow:hidden;}
.hdr::before{content:'';position:absolute;top:-40px;right:-40px;width:160px;height:160px;border-radius:50%;background:rgba(45,106,79,.2);}
.hdr.col{background:linear-gradient(135deg,#1B4965,#0E2D3F);}.hdr.col::before{background:rgba(82,183,136,.15);}
.hdr.adm{background:linear-gradient(135deg,#3D1A24,#6B2737);}.hdr.adm::before{background:rgba(255,200,150,.1);}
.hdr-top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;}
.hdr-badge{display:inline-block;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:20px;padding:4px 14px;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;font-weight:500;}
.hdr h1{font-family:'Playfair Display',serif;font-size:clamp(17px,3vw,24px);line-height:1.2;max-width:460px;}
.hdr-sub{margin-top:5px;font-size:11px;opacity:.5;font-weight:300;}
.hdr-btns{display:flex;flex-direction:column;gap:7px;align-items:flex-end;flex-shrink:0;}
.btn-home{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#F5F0E8;border-radius:10px;padding:7px 14px;font-size:12px;cursor:pointer;font-family:'DM Sans',sans-serif;transition:all .2s;white-space:nowrap;}
.btn-home:hover{background:rgba(255,255,255,.2);}
.btn-home.ghost{opacity:.6;}
.prog-bar{background:rgba(255,255,255,.1);height:3px;margin-top:18px;border-radius:2px;overflow:hidden;}
.prog-fill{height:100%;background:linear-gradient(90deg,#2D6A4F,#52B788);border-radius:2px;transition:width .5s ease;}
.prog-steps{display:flex;gap:8px;margin-top:7px;}
.prog-step{font-size:9px;opacity:.4;letter-spacing:.5px;text-transform:uppercase;flex:1;}
.prog-step.active{opacity:1;color:#52B788;}.prog-step.done{opacity:.6;}

/* ── LAYOUT ── */
.ctn{max-width:780px;margin:0 auto;padding:36px 20px;}
.card{background:white;border-radius:16px;padding:34px;box-shadow:0 2px 20px rgba(0,0,0,.06);}
.lbl{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#2D6A4F;font-weight:600;margin-bottom:7px;}
.lbl.b{color:#1B4965;}.lbl.r{color:#6B2737;}
.ttl{font-family:'Playfair Display',serif;font-size:24px;margin-bottom:5px;line-height:1.2;}
.dsc{font-size:14px;color:#666;font-weight:300;margin-bottom:26px;line-height:1.6;}

/* ── FORMS ── */
.frow{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;}
.fg{display:flex;flex-direction:column;gap:5px;margin-bottom:14px;}
label{font-size:12px;font-weight:600;letter-spacing:.5px;color:#444;}
input,select{padding:11px 13px;border:1.5px solid #E8E4DC;border-radius:10px;font-size:14px;font-family:'DM Sans',sans-serif;background:#FAFAF8;transition:border-color .2s,box-shadow .2s;outline:none;color:#1A1A1A;width:100%;}
input:focus,select:focus{border-color:#2D6A4F;box-shadow:0 0 0 3px rgba(45,106,79,.1);background:white;}
.field-hint{font-size:11px;color:#CCC;margin-top:2px;}

/* ── CONSENT ── */
.rules-box{background:#FAFAF8;border:1.5px solid #E8E4DC;border-radius:12px;padding:22px;max-height:320px;overflow-y:auto;font-size:13px;line-height:1.8;color:#333;margin-bottom:16px;}
.rules-box::-webkit-scrollbar{width:4px;}
.rules-box::-webkit-scrollbar-thumb{background:#CCC;border-radius:2px;}
.rules-box h3{font-family:'Playfair Display',serif;font-size:16px;margin-bottom:8px;}
.rules-box h4{font-weight:600;font-size:11px;margin:12px 0 4px;text-transform:uppercase;letter-spacing:.5px;color:#2D6A4F;}
.rules-box ul{padding-left:16px;margin:5px 0;}
.rules-box li{margin-bottom:4px;}
.scroll-hint{text-align:center;font-size:11px;color:#CCC;margin-bottom:14px;}
.consent-btns{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.btn-yes{padding:15px;background:#2D6A4F;color:white;border:none;border-radius:12px;font-size:14px;font-family:'DM Sans',sans-serif;font-weight:600;cursor:pointer;transition:all .2s;}
.btn-yes:hover{background:#1F4E38;transform:translateY(-1px);}
.btn-no{padding:15px;background:white;color:#666;border:1.5px solid #E8E4DC;border-radius:12px;font-size:14px;font-family:'DM Sans',sans-serif;font-weight:500;cursor:pointer;transition:all .2s;}
.btn-no:hover{border-color:#CC5500;color:#CC5500;}

/* ── STAFF CARDS ── */
.staff-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(192px,1fr));gap:12px;margin-bottom:22px;}
.stf{background:white;border:2px solid #E8E4DC;border-radius:14px;padding:18px;cursor:pointer;transition:all .2s;position:relative;}
.stf:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.1);}
.stf.sel{border-color:var(--sc);box-shadow:0 4px 20px rgba(0,0,0,.1);}
.stf.sel::after{content:'✓';position:absolute;top:10px;right:12px;width:20px;height:20px;background:var(--sc);color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;}
.stf-av{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:white;margin-bottom:10px;}
.stf-nm{font-weight:600;font-size:13px;margin-bottom:2px;}
.stf-rl{font-size:11px;color:#AAA;margin-bottom:10px;}
.cap-wrap{height:4px;background:#F0EDE8;border-radius:3px;overflow:hidden;margin-bottom:4px;}
.cap-fill{height:100%;border-radius:3px;transition:width .4s;}
.cap-txt{font-size:10px;color:#CCC;}

/* ── CALENDAR ── */
.cal-wrap{background:white;border-radius:16px;padding:26px;box-shadow:0 2px 20px rgba(0,0,0,.06);}
.cal-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;}
.cal-ttl{font-family:'Playfair Display',serif;font-size:18px;}
.cal-nav{display:flex;gap:8px;}
.cal-nav button{width:30px;height:30px;border:1.5px solid #E8E4DC;background:white;border-radius:8px;cursor:pointer;font-size:14px;transition:all .15s;display:flex;align-items:center;justify-content:center;}
.cal-nav button:hover{background:#F5F0E8;}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:16px;}
.cal-dl{text-align:center;font-size:9px;font-weight:600;letter-spacing:1px;color:#CCC;padding:3px 0 7px;text-transform:uppercase;}
.cd{aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:9px;font-size:12px;cursor:default;color:#DDD;position:relative;transition:all .15s;}
.cd.av{background:#F5F0E8;color:#1A1A1A;cursor:pointer;font-weight:500;}
.cd.av:hover{background:var(--hc);color:white;}
.cd.sd{background:var(--sc2)!important;color:white!important;font-weight:700;box-shadow:0 4px 14px rgba(0,0,0,.2);}
.cd.hsd{background:#E8F4EF;color:#2D6A4F;cursor:pointer;font-weight:600;}
.cd.hsd:hover{background:#2D6A4F;color:white;}
.dot{position:absolute;bottom:2px;width:4px;height:4px;border-radius:50%;}
.slots-sec{margin-top:16px;padding-top:16px;border-top:1.5px solid #F0EDE8;}
.slots-lbl{font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#888;margin-bottom:10px;}
.slots-row{display:flex;flex-wrap:wrap;gap:7px;}
.slot{padding:7px 14px;background:#F5F0E8;border:1.5px solid transparent;border-radius:8px;font-size:12px;font-family:'DM Sans',sans-serif;font-weight:500;cursor:pointer;transition:all .15s;color:#444;}
.slot:hover{border-color:var(--sc3);color:var(--sc3);}
.slot.on{background:var(--sc3);color:white;border-color:transparent;}

/* ── BUTTONS ── */
.btn{padding:13px 26px;background:#1A1A1A;color:white;border:none;border-radius:12px;font-size:13px;font-family:'DM Sans',sans-serif;font-weight:600;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:7px;}
.btn:hover{background:#333;transform:translateY(-1px);}
.btn:disabled{opacity:.35;cursor:not-allowed;transform:none;}
.btn.g{background:#2D6A4F;}.btn.g:hover{background:#1F4E38;}
.btn.bl{background:#1B4965;}.btn.bl:hover{background:#143852;}
.btn.rd{background:#6B2737;}.btn.rd:hover{background:#4A1A26;}
.btn.xl{background:#1A5C35;font-size:13px;}.btn.xl:hover{background:#124026;}
.btn-bk{padding:13px 20px;background:transparent;color:#777;border:1.5px solid #E8E4DC;border-radius:12px;font-size:13px;font-family:'DM Sans',sans-serif;cursor:pointer;transition:all .2s;}
.btn-bk:hover{border-color:#999;color:#333;}
.btn-row{display:flex;justify-content:space-between;align-items:center;margin-top:26px;}

/* ── DETAIL BOX ── */
.dbox{background:#F5F0E8;border-radius:12px;padding:18px 22px;margin:14px 0;}
.dr{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #E8E4DC;font-size:13px;gap:12px;}
.dr:last-child{border-bottom:none;}
.dr span:first-child{color:#AAA;white-space:nowrap;}
.dr span:last-child{font-weight:600;text-align:right;}

/* ── SUCCESS ── */
.suc{text-align:center;padding:44px 26px;}
.suc-icon{width:72px;height:72px;background:#2D6A4F;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;margin:0 auto 16px;box-shadow:0 8px 32px rgba(45,106,79,.3);}
.suc-title{font-family:'Playfair Display',serif;font-size:28px;margin-bottom:8px;}
.email-receipt{background:#F0F7F4;border:1.5px solid #C3E0D3;border-radius:10px;padding:11px 14px;font-size:12px;color:#2D6A4F;display:flex;gap:10px;align-items:center;margin-bottom:8px;}
.email-receipt.blue{background:#EBF3F9;border-color:#B8D4E8;color:#1B4965;}
.receipt-check{margin-left:auto;font-size:16px;}

/* ── EMAIL PREVIEW ── */
.ep-toggle{width:100%;background:#FAFAF8;border:1.5px solid #E8E4DC;color:#555;padding:11px 14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;text-align:left;transition:all .2s;border-radius:10px;margin-bottom:6px;}
.ep-toggle.open{background:#1A1A1A;color:white;border-color:#1A1A1A;border-radius:10px 10px 0 0;margin-bottom:0;}
.ep-body{border:1.5px solid #E8E4DC;border-top:none;border-radius:0 0 10px 10px;padding:14px;background:white;margin-bottom:8px;}
.ep-meta{font-size:11px;color:#AAA;margin-bottom:3px;}
.ep-meta strong{color:#555;}
.ep-pre{font-family:'DM Sans',sans-serif;font-size:11.5px;color:#444;line-height:1.7;white-space:pre-wrap;background:#FAFAF8;padding:12px;border-radius:8px;border:1px solid #F0EDE8;}

/* ── PIN PAD ── */
.pin-wrap{max-width:380px;margin:0 auto;}
.pin-display{display:flex;gap:10px;justify-content:center;margin:22px 0;}
.pin-dot{width:15px;height:15px;border-radius:50%;border:2px solid #DDD;background:transparent;transition:all .2s;}
.pin-dot.filled{background:var(--pc,#1B4965);border-color:var(--pc,#1B4965);}
.pin-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;max-width:220px;margin:0 auto;}
.pk{padding:14px;background:#F5F0E8;border:1.5px solid transparent;border-radius:10px;font-size:17px;font-weight:600;cursor:pointer;transition:all .15s;font-family:'DM Sans',sans-serif;text-align:center;}
.pk:hover{background:var(--pc,#1B4965);color:white;}
.pk.del{font-size:12px;background:white;border-color:#E8E4DC;color:#888;}
.pk.del:hover{background:#CC4444;color:white;border-color:transparent;}
.pin-err{text-align:center;color:#CC4444;font-size:12px;margin-top:10px;animation:shake .3s ease;}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(6px)}}
.pin-hint{text-align:center;font-size:11px;color:#CCC;margin-top:8px;}

/* ── COLLECTOR DASHBOARD ── */
.dash-hdr{display:flex;align-items:center;gap:14px;margin-bottom:22px;}
.dash-av{width:50px;height:50px;border-radius:13px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;color:white;flex-shrink:0;}
.dash-nm{font-family:'Playfair Display',serif;font-size:20px;line-height:1.1;}
.dash-rl{font-size:12px;color:#AAA;margin-top:2px;}
.stats3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:22px;}
.stat{background:#F5F0E8;border-radius:12px;padding:14px;text-align:center;}
.stat-n{font-family:'Playfair Display',serif;font-size:24px;}
.stat-l{font-size:10px;color:#AAA;letter-spacing:.5px;text-transform:uppercase;margin-top:2px;}
.divider{height:1px;background:#F0EDE8;margin:20px 0;}
.tt{padding:7px 13px;background:#F5F0E8;border:1.5px solid transparent;border-radius:8px;font-size:12px;font-family:'DM Sans',sans-serif;font-weight:500;cursor:pointer;transition:all .15s;color:#555;}
.tt:hover{border-color:var(--tc);color:var(--tc);}
.tt.on{background:var(--tc);color:white;border-color:transparent;}
.add-row{display:flex;gap:9px;align-items:center;margin-top:14px;}
.add-row input[type=date]{flex:1;}
.btn-add{padding:11px 16px;background:#1B4965;color:white;border:none;border-radius:9px;font-size:12px;font-family:'DM Sans',sans-serif;font-weight:600;cursor:pointer;transition:all .2s;white-space:nowrap;}
.btn-add:hover{background:#143852;} .btn-add:disabled{opacity:.4;cursor:not-allowed;}
.btn-rm{background:none;border:none;cursor:pointer;color:#CCC;font-size:12px;font-family:'DM Sans',sans-serif;transition:color .15s;padding:3px 8px;border-radius:6px;}
.btn-rm:hover{color:#CC4444;background:#FFF0F0;}
.save-bar{background:#2D6A4F;color:white;border-radius:12px;padding:13px 18px;display:flex;align-items:center;justify-content:space-between;margin-top:16px;}
.btn-sv{padding:9px 20px;background:white;color:#2D6A4F;border:none;border-radius:8px;font-size:12px;font-family:'DM Sans',sans-serif;font-weight:700;cursor:pointer;}
.btn-sv:hover{background:#F5F0E8;}
.saved-toast{background:#1A1A1A;color:white;border-radius:12px;padding:12px 18px;text-align:center;font-size:13px;margin-top:12px;}
.bk-item{background:#F5F0E8;border-radius:10px;padding:12px 15px;display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;}
.bi-nm{font-weight:600;font-size:13px;}.bi-em{font-size:11px;color:#AAA;margin-top:1px;}
.bi-tm{font-size:12px;font-weight:600;color:#1B4965;text-align:right;}.bi-dt{font-size:10px;color:#CCC;margin-top:1px;text-align:right;}
.cap-ctl{display:flex;align-items:center;gap:10px;margin-top:5px;}
.cap-btn{width:30px;height:30px;border:1.5px solid #E8E4DC;background:white;border-radius:8px;cursor:pointer;font-size:15px;font-weight:600;transition:all .15s;display:flex;align-items:center;justify-content:center;}
.cap-btn:hover{background:#F5F0E8;border-color:#999;}
.cap-val{font-family:'Playfair Display',serif;font-size:22px;min-width:34px;text-align:center;}
.irb-tag{display:inline-flex;align-items:center;gap:6px;background:rgba(45,106,79,.08);border:1px solid rgba(45,106,79,.2);color:#2D6A4F;border-radius:20px;padding:5px 13px;font-size:11px;font-weight:600;letter-spacing:.5px;margin-bottom:18px;}
.live-dot{width:7px;height:7px;border-radius:50%;background:#2D6A4F;display:inline-block;margin-right:5px;animation:pulse 2s infinite;}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* ── ADMIN ── */
.tab-bar{display:flex;gap:5px;margin-bottom:20px;background:#F5F0E8;padding:5px;border-radius:12px;}
.tab{flex:1;padding:9px;text-align:center;border:none;background:transparent;border-radius:9px;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;color:#999;}
.tab.active{background:white;color:#1A1A1A;box-shadow:0 2px 8px rgba(0,0,0,.08);}
.data-table{width:100%;border-collapse:collapse;font-size:12px;}
.data-table th{background:#1A1A1A;color:white;padding:10px 12px;text-align:left;font-weight:600;letter-spacing:.3px;white-space:nowrap;}
.data-table th:first-child{border-radius:8px 0 0 8px;}.data-table th:last-child{border-radius:0 8px 8px 0;}
.data-table td{padding:10px 12px;border-bottom:1px solid #F0EDE8;color:#444;vertical-align:middle;}
.data-table tr:last-child td{border-bottom:none;}.data-table tr:hover td{background:#FAFAF8;}
.badge{display:inline-block;padding:3px 8px;border-radius:5px;font-size:10px;font-weight:600;letter-spacing:.3px;}
.badge.green{background:#E0F2E9;color:#1F6B3A;}.badge.blue{background:#E0EEF7;color:#1B4965;}.badge.red{background:#F9E0E4;color:#6B2737;}
.stat-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:22px;}
.stat-card{background:white;border-radius:12px;padding:18px;box-shadow:0 2px 12px rgba(0,0,0,.05);}
.sc-num{font-family:'Playfair Display',serif;font-size:28px;margin-bottom:4px;}
.sc-lbl{font-size:10px;color:#AAA;text-transform:uppercase;letter-spacing:.5px;}
.export-bar{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:18px;gap:12px;flex-wrap:wrap;}
.empty-state{text-align:center;padding:44px;color:#CCC;font-size:13px;font-style:italic;}
.table-wrap{overflow-x:auto;}
.firebase-badge{display:inline-flex;align-items:center;gap:6px;background:#FFF3E0;border:1px solid #FFB74D;color:#E65100;border-radius:20px;padding:4px 12px;font-size:11px;font-weight:600;margin-bottom:14px;}

@media(max-width:700px){
  .frow,.consent-btns{grid-template-columns:1fr;}
  .staff-grid{grid-template-columns:1fr 1fr;}.card{padding:22px;}.ctn{padding:22px 14px;}
  .landing-cards{grid-template-columns:1fr;}.stats3,.stat-cards{grid-template-columns:1fr 1fr;}
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Shared hook — loads all data from Firebase/localStorage, provides live sync
// ─────────────────────────────────────────────────────────────────────────────
function useStudyData() {
  const [slots,    setSlots]    = useState(null);
  const [capacity, setCap]      = useState(null);
  const [bookings, setBookings] = useState([]);
  const [loading,  setLoading]  = useState(true);

  // Initial load
  useEffect(() => {
    (async () => {
      const s = await fbGet("config","staffSlots",    DEFAULT_SLOTS);
      const c = await fbGet("config","staffCapacity", DEFAULT_CAPACITY);
      setSlots(s); setCap(c);
      setLoading(false);
    })();
  }, []);

  // Live bookings listener
  useEffect(() => {
    const unsub = fbListen("bookings", data => setBookings(data));
    return unsub;
  }, []);

  const saveSlots = useCallback(async (staffId, newSlots) => {
    setSlots(prev => {
      const upd = { ...prev, [staffId]: newSlots };
      fbSet("config", "staffSlots", upd);
      return upd;
    });
  }, []);

  const saveCap = useCallback(async (staffId, val) => {
    setCap(prev => {
      const upd = { ...prev, [staffId]: val };
      fbSet("config", "staffCapacity", upd);
      return upd;
    });
  }, []);

  const addBooking = useCallback(async (bk) => {
    const id = await fbAdd("bookings", bk);
    return id;
  }, []);

  return { slots, capacity, bookings, loading, saveSlots, saveCap, addBooking };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────
function CalNav({ month, year, onChange }) {
  return (
    <div className="cal-nav">
      <button onClick={()=>onChange(month===0?11:month-1, month===0?year-1:year)}>‹</button>
      <button onClick={()=>onChange(month===11?0:month+1, month===11?year+1:year)}>›</button>
    </div>
  );
}

function PinPad({ onSuccess, pinColor="#1B4965", hint, title="Enter Your PIN", subtitle="" }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState(false);
  function press(d) {
    if (pin.length>=4) return;
    const next = pin+d; setPin(next); setErr(false);
    if (next.length===4) {
      if (onSuccess(next)) setPin("");
      else { setErr(true); setTimeout(()=>setPin(""),700); }
    }
  }
  return (
    <div className="pin-wrap">
      <div className="lbl" style={{textAlign:"center",color:pinColor,marginBottom:6}}>{subtitle || "Authentication"}</div>
      <div className="ttl" style={{textAlign:"center",marginBottom:5}}>{title}</div>
      {subtitle==="" && <div className="dsc" style={{textAlign:"center"}}>Enter your 4-digit PIN to continue.</div>}
      <div className="pin-display" style={{"--pc":pinColor}}>
        {[0,1,2,3].map(i=><div key={i} className={`pin-dot ${pin.length>i?"filled":""}`}/>)}
      </div>
      <div className="pin-pad" style={{"--pc":pinColor}}>
        {[1,2,3,4,5,6,7,8,9].map(n=><button key={n} className="pk" onClick={()=>press(String(n))}>{n}</button>)}
        <div/>
        <button className="pk" onClick={()=>press("0")}>0</button>
        <button className="pk del" onClick={()=>{setPin(p=>p.slice(0,-1));setErr(false);}}>⌫</button>
      </div>
      {err && <div className="pin-err">Incorrect PIN. Try again.</div>}
      {hint && <div className="pin-hint">{hint}</div>}
    </div>
  );
}

function EmailPreviews({ booking, form, staff }) {
  const [open, setOpen] = useState(null);
  if (!booking) return null;
  const configured = EMAILJS_CONFIG.serviceId !== "YOUR_SERVICE_ID";

  const emails = {
    student:{
      to: booking.email,
      subject:"✅ Study Registration Confirmed – IRB-2025-304",
      body:`Dear ${booking.name},

Thank you for registering for the Cognitive Fatigue & Test Performance Study at Purdue University.

YOUR SESSION DETAILS
────────────────────────────────────
  Data Collector : ${booking.collector}
  Session 1      : ${fmtDisp(booking.date)} at ${booking.time}
  Session 2      : 3 days after Session 1 (same time slot)
  Location       : Purdue University – TBD (we will follow up)
  Compensation   : $10–$54 Amazon gift card or cash
${booking.phone?`\n  We may send reminders to ${booking.phone}.\n`:""}
────────────────────────────────────
Please arrive 5 minutes early for sensor setup. If you need to reschedule or withdraw, contact us at any time.

  Amirreza Mehrabi   amehrabi@purdue.edu
  Prof. Jason Morphew   jmorphew@purdue.edu

Best regards,
Study Management Team
Purdue University · IRB-2025-304`,
    },
    staff:{
      to: staff?.email,
      subject:`📋 New Booking – ${fmtDisp(booking.date)} at ${booking.time}`,
      body:`Hi ${booking.collector},

A new participant has just booked a session with you.

PARTICIPANT DETAILS
────────────────────────────────────
  Name    : ${booking.name}
  Email   : ${booking.email}
  Age     : ${booking.age}
  Level   : ${form.year} · ${form.major}${booking.phone?`\n  Phone   : ${booking.phone}`:""}
  Reg. ID : ${booking.id}
────────────────────────────────────
SESSION
  Date    : ${fmtDisp(booking.date)}
  Time    : ${booking.time}
────────────────────────────────────

Please confirm your materials are ready for this session.

Best,
Study Management System
Purdue University · IRB-2025-304`,
    },
  };

  return (
    <div style={{maxWidth:460,margin:"18px auto 0",textAlign:"left"}}>
      {!configured && (
        <div style={{background:"#FFF8EC",border:"1.5px solid #F5D98B",borderRadius:10,padding:"10px 14px",fontSize:11,color:"#A07000",marginBottom:12}}>
          ⚠️ EmailJS not configured — emails are simulated. See SETUP_GUIDE.md to enable real sending.
        </div>
      )}
      <div style={{fontSize:11,color:"#CCC",textAlign:"center",marginBottom:8,letterSpacing:.5}}>SENT EMAIL PREVIEWS</div>
      {["student","staff"].map(k=>{
        const e=emails[k], isOpen=open===k;
        return (
          <div key={k}>
            <button className={`ep-toggle ${isOpen?"open":""}`} onClick={()=>setOpen(isOpen?null:k)}>
              <span>{k==="student"?"📧 Confirmation to participant":"📋 Notification to "+booking.collector}</span>
              <span style={{fontSize:10,opacity:.7}}>{isOpen?"▲ hide":"▼ preview"}</span>
            </button>
            {isOpen&&(
              <div className="ep-body">
                <div className="ep-meta">TO: <strong>{e.to}</strong></div>
                <div className="ep-meta" style={{marginBottom:10}}>SUBJECT: <strong>{e.subject}</strong></div>
                <pre className="ep-pre">{e.body}</pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PARTICIPANT PORTAL
// ─────────────────────────────────────────────────────────────────────────────
function ParticipantPortal({ data, onHome }) {
  const { slots, capacity, bookings, addBooking, loading } = data;
  const [step,     setStep]    = useState(1);
  const [form,     setForm]    = useState({firstName:"",lastName:"",email:"",age:"",year:"",major:"",phone:""});
  const [selStaff, setSelStaff]= useState(null);
  const [calYear,  setCalYear] = useState(2026);
  const [calMonth, setCalMon]  = useState(2);
  const [selDate,  setSelDate] = useState(null);
  const [selTime,  setSelTime] = useState(null);
  const [booking,  setBooking] = useState(null);
  const [sending,  setSending] = useState(false);

  const staff      = selStaff ? STAFF_BASE.find(s=>s.id===selStaff) : null;
  const staffSlots = (slots&&staff) ? (slots[staff.id]||{}) : {};
  const availDates = Object.keys(staffSlots).filter(d=>staffSlots[d]?.length>0);
  const dim=getDIM(calYear,calMonth), fd=getFD(calYear,calMonth);
  const getBooked  = id => bookings.filter(b=>b.staffId===id).length;
  const STEPS=["Profile","Consent","Schedule","Confirm"], PCT=[0,25,60,80,100];
  const F = (k,v)=>setForm(f=>({...f,[k]:v}));

  if (loading) return <div className="ctn" style={{textAlign:"center",paddingTop:80,color:"#AAA"}}>Loading…</div>;

  return (
    <>
      <div className="hdr">
        <div className="hdr-top">
          <div>
            <div className="hdr-badge">Purdue University · IRB-2025-304</div>
            <h1>Cognitive Fatigue & Test Performance Study</h1>
            <div className="hdr-sub">Participant Registration Portal</div>
          </div>
          <div className="hdr-btns"><button className="btn-home" onClick={onHome}>← Home</button></div>
        </div>
        {step<5&&step!=="declined"&&(
          <>
            <div className="prog-bar"><div className="prog-fill" style={{width:`${PCT[step]}%`}}/></div>
            <div className="prog-steps">{STEPS.map((l,i)=><div key={l} className={`prog-step ${step===i+1?"active":step>i+1?"done":""}`}>{l}</div>)}</div>
          </>
        )}
      </div>

      <div className="ctn">
        {/* ── Step 1: Profile ── */}
        {step===1&&(
          <div className="card">
            <div className="lbl">Step 1 of 4</div>
            <div className="ttl">Your Information</div>
            <div className="dsc">Complete the fields below to begin the screening process.</div>
            <div className="frow">
              <div className="fg"><label>First Name *</label><input value={form.firstName} onChange={e=>F("firstName",e.target.value)} placeholder="e.g. Jordan"/></div>
              <div className="fg"><label>Last Name *</label><input value={form.lastName} onChange={e=>F("lastName",e.target.value)} placeholder="e.g. Smith"/></div>
            </div>
            <div className="frow">
              <div className="fg"><label>Purdue Email *</label><input type="email" value={form.email} onChange={e=>F("email",e.target.value)} placeholder="yourname@purdue.edu"/></div>
              <div className="fg"><label>Age * <span style={{fontWeight:300,color:"#CCC"}}>(18–30)</span></label><input type="number" min="18" max="30" value={form.age} onChange={e=>F("age",e.target.value)} placeholder="e.g. 22"/></div>
            </div>
            <div className="frow">
              <div className="fg">
                <label>Academic Level *</label>
                <select value={form.year} onChange={e=>F("year",e.target.value)}>
                  <option value="">Select…</option>
                  <option>Freshman</option><option>Sophomore</option><option>Junior</option><option>Senior</option><option>Graduate Student</option>
                </select>
              </div>
              <div className="fg"><label>Major *</label><input value={form.major} onChange={e=>F("major",e.target.value)} placeholder="e.g. Psychology"/></div>
            </div>
            <div className="fg">
              <label>Phone Number <span style={{fontWeight:300,color:"#CCC"}}>(optional)</span></label>
              <input type="tel" value={form.phone} onChange={e=>F("phone",e.target.value)} placeholder="(765) 555-0123"/>
              <span className="field-hint">May be used for session reminders.</span>
            </div>
            <div className="btn-row" style={{justifyContent:"flex-end"}}>
              <button className="btn g" disabled={!form.firstName||!form.lastName||!form.email||!form.age||!form.year||!form.major} onClick={()=>setStep(2)}>Continue →</button>
            </div>
          </div>
        )}

        {/* ── Step 2: Consent ── */}
        {step===2&&(
          <div className="card">
            <div className="irb-tag">🔒 IRB Approved · Voluntary & Confidential</div>
            <div className="lbl">Step 2 of 4</div>
            <div className="ttl">Study Overview & Consent</div>
            <div className="dsc">Please read carefully before responding below.</div>
            <div className="rules-box">
              <h3>Cognitive Fatigue & Test Performance Study</h3>
              <h4>Purpose</h4>
              <p>Understand how cognitive fatigue impacts test performance among Purdue students aged 18–30.</p>
              <h4>What You Will Do</h4>
              <ul>
                <li>Complete <strong>two in-person exam sessions</strong>, 3 days apart.</li>
                <li>Each session takes approximately <strong>40–70 minutes</strong>.</li>
                <li>Complete short surveys before/after each exam (energy, focus, motivation).</li>
                <li>Wear a <strong>Polar H10 biometric sensor</strong> during both exams.</li>
                <li>Some participants will read a <strong>10-minute educational content</strong> between sessions.</li>
              </ul>
              <h4>Total Time</h4><p>Up to <strong>130 minutes</strong> total across both sessions.</p>
              <h4>Compensation</h4><p>Amazon gift card or cash: <strong>$10–$54</strong> based on participation and performance.</p>
              <h4>Eligibility</h4>
              <ul>
                <li>Purdue undergraduate or graduate student</li>
                <li>Age 18–30</li>
                <li>Able to attend both in-person sessions</li>
              </ul>
              <h4>Confidentiality</h4>
              <p>All data is collected and stored confidentially. Participation is voluntary — you may withdraw at any time without penalty.</p>
              <h4>Contact</h4>
              <p>Amirreza Mehrabi — <strong>amehrabi@purdue.edu</strong><br/>Prof. Jason Morphew — <strong>jmorphew@purdue.edu</strong></p>
            </div>
            <p className="scroll-hint">↑ Scroll to read the complete overview</p>
            <p style={{fontSize:13,color:"#555",marginBottom:14,fontWeight:500}}>Do you agree to participate in this study?</p>
            <div className="consent-btns">
              <button className="btn-yes" onClick={()=>setStep(3)}>✓ Yes, I agree to participate</button>
              <button className="btn-no"  onClick={()=>setStep("declined")}>✗ No, I decline</button>
            </div>
          </div>
        )}

        {/* ── Step 3: Schedule ── */}
        {step===3&&(
          <>
            <div style={{marginBottom:20}}>
              <div className="lbl">Step 3 of 4</div>
              <div className="ttl">Choose Your Data Collector</div>
              <div className="dsc">Select a data collector, then pick an available date and time.</div>
            </div>
            <div className="staff-grid">
              {STAFF_BASE.map(s=>{
                const booked=getBooked(s.id), cap=capacity?.[s.id]??20;
                const pct=Math.min(100,Math.round((booked/cap)*100));
                const avCount=Object.values(slots?.[s.id]||{}).reduce((n,a)=>n+a.length,0);
                const isSel=selStaff===s.id;
                return (
                  <div key={s.id} className={`stf ${isSel?"sel":""}`} style={{"--sc":s.color}}
                    onClick={()=>{setSelStaff(s.id);setSelDate(null);setSelTime(null);}}>
                    <div className="stf-av" style={{background:s.color}}>{s.avatar}</div>
                    <div className="stf-nm">{s.name}</div>
                    <div className="stf-rl">{s.role}</div>
                    <div className="cap-wrap"><div className="cap-fill" style={{width:`${pct}%`,background:s.color,opacity:.65}}/></div>
                    <div className="cap-txt">{cap-booked} of {cap} spots · {avCount} open slots</div>
                  </div>
                );
              })}
            </div>

            {staff&&(
              <div className="cal-wrap">
                <div className="cal-hdr">
                  <div className="cal-ttl">{MONTHS[calMonth]} {calYear}</div>
                  <CalNav month={calMonth} year={calYear} onChange={(m,y)=>{setCalMon(m);setCalYear(y);}}/>
                </div>
                <div className="cal-grid">
                  {DAYS.map(d=><div key={d} className="cal-dl">{d}</div>)}
                  {Array.from({length:fd},(_,i)=><div key={`e${i}`} className="cd"/>)}
                  {Array.from({length:dim},(_,i)=>{
                    const d=i+1, ds=fmtKey(calYear,calMonth,d);
                    const isAv=availDates.includes(ds), isSel=selDate===ds;
                    return (
                      <div key={d} className={`cd ${isAv?"av":""} ${isSel?"sd":""}`}
                        style={{"--hc":staff.color,"--sc2":staff.color}}
                        onClick={()=>{if(isAv){setSelDate(ds);setSelTime(null);}}}>
                        {d}
                        {isAv&&!isSel&&<span className="dot" style={{background:staff.color}}/>}
                      </div>
                    );
                  })}
                </div>
                {selDate&&(
                  <div className="slots-sec">
                    <div className="slots-lbl">Available times — {fmtDisp(selDate)}</div>
                    <div className="slots-row">
                      {staffSlots[selDate]?.map(t=>(
                        <button key={t} className={`slot ${selTime===t?"on":""}`} style={{"--sc3":staff.color}} onClick={()=>setSelTime(t)}>{t}</button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="btn-row">
                  <button className="btn-bk" onClick={()=>setStep(2)}>← Back</button>
                  <button className="btn g" disabled={!selDate||!selTime} onClick={()=>setStep(4)}>Review Booking →</button>
                </div>
              </div>
            )}
            {!staff&&<div className="btn-row"><button className="btn-bk" onClick={()=>setStep(2)}>← Back</button></div>}
          </>
        )}

        {/* ── Step 4: Confirm ── */}
        {step===4&&(
          <div className="card">
            <div className="lbl">Step 4 of 4</div>
            <div className="ttl">Confirm Your Session</div>
            <div className="dsc">Review everything carefully before submitting.</div>
            <div className="dbox">
              <div className="dr"><span>Participant</span><span>{form.firstName} {form.lastName}</span></div>
              <div className="dr"><span>Email</span><span>{form.email}</span></div>
              <div className="dr"><span>Age</span><span>{form.age}</span></div>
              <div className="dr"><span>Academic Level</span><span>{form.year} · {form.major}</span></div>
              {form.phone&&<div className="dr"><span>Phone</span><span>{form.phone}</span></div>}
              <div className="dr"><span>Data Collector</span><span>{staff?.name}</span></div>
              <div className="dr"><span>Session 1 Date</span><span>{selDate&&fmtDisp(selDate)}</span></div>
              <div className="dr"><span>Session 1 Time</span><span>{selTime}</span></div>
              <div className="dr"><span>Session 2</span><span>3 days later, same time</span></div>
              <div className="dr"><span>Location</span><span>Purdue University (TBD)</span></div>
            </div>
            <div style={{background:"#F0F7F4",border:"1.5px solid #C3E0D3",borderRadius:10,padding:"11px 14px",marginBottom:18,fontSize:12,color:"#2D6A4F",display:"flex",gap:8,alignItems:"flex-start"}}>
              <span>✉️</span>
              <span>A confirmation will be sent to <strong>{form.email}</strong> and <strong>{staff?.name}</strong> will be notified.</span>
            </div>
            <p style={{fontSize:12,color:"#CCC",marginBottom:22,lineHeight:1.6}}>By confirming, you agree to participate in both sessions. You may withdraw at any time.</p>
            <div className="btn-row">
              <button className="btn-bk" onClick={()=>setStep(3)}>← Back</button>
              <button className="btn g" disabled={sending} onClick={async()=>{
                setSending(true);
                const bk = {
                  id:uid(), registeredAt:nowISO(),
                  name:`${form.firstName} ${form.lastName}`,
                  firstName:form.firstName, lastName:form.lastName,
                  email:form.email, age:form.age,
                  year:form.year, major:form.major, phone:form.phone||"",
                  staffId:staff.id, collector:staff.name, collectorEmail:staff.email,
                  date:selDate, time:selTime,
                };
                await addBooking(bk);
                await sendEmails(bk, form, staff).catch(()=>{});
                setBooking(bk);
                setSending(false);
                setStep(5);
              }}>
                {sending?<><span style={{display:"inline-block",animation:"spin 1s linear infinite",marginRight:6}}>⟳</span>Sending…</>:"✓ Confirm & Send Emails"}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: Success ── */}
        {step===5&&(
          <div className="card">
            <div className="suc">
              <div className="suc-icon">✓</div>
              <div className="suc-title">You're Registered!</div>
              <p style={{color:"#888",fontSize:14,marginTop:8}}>Thank you, {form.firstName}! Your session is confirmed and saved.</p>
              <div style={{maxWidth:460,margin:"18px auto 0"}}>
                <div className="email-receipt">
                  <span style={{fontSize:16}}>✉️</span>
                  <div><div style={{fontWeight:600}}>Confirmation sent to you</div><div style={{opacity:.7,marginTop:1,fontSize:11}}>{form.email}</div></div>
                  <span className="receipt-check">✓</span>
                </div>
                <div className="email-receipt blue">
                  <span style={{fontSize:16}}>📋</span>
                  <div><div style={{fontWeight:600}}>Notification sent to {staff?.name}</div><div style={{opacity:.7,marginTop:1,fontSize:11}}>Your data collector has been informed</div></div>
                  <span className="receipt-check">✓</span>
                </div>
              </div>
              <div className="dbox" style={{maxWidth:460,margin:"14px auto"}}>
                <div className="dr"><span>Registration ID</span><span style={{fontFamily:"monospace",fontSize:12}}>{booking?.id}</span></div>
                <div className="dr"><span>Data Collector</span><span>{booking?.collector}</span></div>
                <div className="dr"><span>Session 1</span><span>{booking?.date&&fmtDisp(booking.date)} at {booking?.time}</span></div>
                <div className="dr"><span>Session 2</span><span>3 days after Session 1</span></div>
                {booking?.phone&&<div className="dr"><span>Phone on file</span><span>{booking.phone}</span></div>}
                <div className="dr"><span>Compensation</span><span>$10–$54</span></div>
              </div>
              {booking?.phone&&<div style={{background:"#FFF8EC",border:"1.5px solid #F5D98B",borderRadius:9,padding:"9px 14px",fontSize:11,color:"#A07000",maxWidth:460,margin:"0 auto 12px",textAlign:"left"}}>📱 Session reminders may be sent to <strong>{booking.phone}</strong>.</div>}
              <p style={{fontSize:12,color:"#CCC",marginTop:8}}>Questions? <strong>amehrabi@purdue.edu</strong> · <strong>jmorphew@purdue.edu</strong></p>
              <EmailPreviews booking={booking} form={form} staff={staff}/>
            </div>
          </div>
        )}

        {/* ── Declined ── */}
        {step==="declined"&&(
          <div className="card">
            <div style={{textAlign:"center",padding:"48px 28px"}}>
              <div style={{fontSize:40,marginBottom:16}}>🙏</div>
              <div className="ttl">Thank You for Your Time</div>
              <p style={{color:"#888",fontSize:14,marginTop:10,lineHeight:1.7,maxWidth:360,margin:"10px auto 0"}}>We respect your decision. Please reach out if you change your mind.</p>
              <p style={{fontSize:12,color:"#CCC",marginTop:18}}>Contact: <strong>amehrabi@purdue.edu</strong></p>
              <button className="btn-bk" style={{marginTop:22}} onClick={()=>setStep(2)}>← Go Back</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COLLECTOR PORTAL
// ─────────────────────────────────────────────────────────────────────────────
function CollectorPortal({ data, onHome }) {
  const { slots, capacity, bookings, saveSlots, saveCap, loading } = data;
  const [loggedIn, setLoggedIn] = useState(null);
  const [calYear,  setCalYear]  = useState(2026);
  const [calMonth, setCalMon]   = useState(2);
  const [selDate,  setSelDate]  = useState(null);
  const [newDate,  setNewDate]  = useState("");
  const [dirty,    setDirty]    = useState(false);
  const [saved,    setSaved]    = useState(false);

  const col       = loggedIn ? STAFF_BASE.find(s=>s.id===loggedIn) : null;
  const colSlots  = (slots&&col) ? (slots[col.id]||{}) : {};
  const colCap    = (capacity&&col) ? (capacity[col.id]||20) : 20;
  const colBks    = bookings.filter(b=>b.staffId===loggedIn);

  function toggleTime(ds,t) {
    const cur=colSlots[ds]||[];
    const upd=cur.includes(t)?cur.filter(x=>x!==t):[...cur,t].sort((a,b)=>{
      const toM=x=>{const[h,r]=x.split(":");const[,ap]=r.split(" ");return((parseInt(h)%12)+(ap==="PM"?12:0))*60;};
      return toM(a)-toM(b);
    });
    saveSlots(col.id,{...colSlots,[ds]:upd});
    setDirty(true);setSaved(false);
  }
  function removeDate(ds){const{[ds]:_,...rest}=colSlots;saveSlots(col.id,rest);if(selDate===ds)setSelDate(null);setDirty(true);setSaved(false);}
  function addDate(){if(!newDate||newDate in colSlots)return;saveSlots(col.id,{...colSlots,[newDate]:[]});setSelDate(newDate);setNewDate("");setDirty(true);setSaved(false);}
  function adjCap(d){const n=Math.max(colBks.length,colCap+d);saveCap(col.id,n);setDirty(true);setSaved(false);}

  const dim=getDIM(calYear,calMonth),fd=getFD(calYear,calMonth);
  const totalSlots=Object.values(colSlots).reduce((n,a)=>n+a.length,0);

  if (loading) return <div className="ctn" style={{textAlign:"center",paddingTop:80,color:"#AAA"}}>Loading…</div>;

  if (!loggedIn) return (
    <>
      <div className="hdr col">
        <div className="hdr-top">
          <div><div className="hdr-badge">Data Collector Portal</div><h1>Manage Your Availability</h1><div className="hdr-sub">Purdue University · IRB-2025-304</div></div>
          <div className="hdr-btns"><button className="btn-home" onClick={onHome}>← Home</button></div>
        </div>
      </div>
      <div className="ctn">
        <div className="card" style={{maxWidth:380,margin:"0 auto"}}>
          <PinPad
            pinColor="#1B4965"
            hint="PINs: 1234 · 5678 · 9012 (demo)"
            onSuccess={p=>{const f=STAFF_BASE.find(s=>s.pin===p);if(f){setLoggedIn(f.id);return true;}return false;}}
          />
        </div>
      </div>
    </>
  );

  return (
    <>
      <div className="hdr col">
        <div className="hdr-top">
          <div><div className="hdr-badge">Data Collector Portal</div><h1>Availability Dashboard</h1><div className="hdr-sub">Purdue University · IRB-2025-304</div></div>
          <div className="hdr-btns">
            <button className="btn-home" onClick={onHome}>← Home</button>
            <button className="btn-home ghost" onClick={()=>{setLoggedIn(null);setSelDate(null);setDirty(false);setSaved(false);}}>Sign Out</button>
          </div>
        </div>
      </div>
      <div className="ctn">
        <div className="card">
          <div className="dash-hdr">
            <div className="dash-av" style={{background:col.color}}>{col.avatar}</div>
            <div>
              <div className="dash-nm">{col.name}</div>
              <div className="dash-rl">{col.role}</div>
              <div style={{fontSize:11,color:"#AAA",marginTop:2}}>{col.email}</div>
            </div>
            {isConfigured()&&<div style={{marginLeft:"auto",fontSize:11,color:"#2D6A4F"}}><span className="live-dot"/>Live sync</div>}
          </div>

          <div className="stats3">
            <div className="stat"><div className="stat-n">{colBks.length}</div><div className="stat-l">Booked</div></div>
            <div className="stat"><div className="stat-n" style={{color:"#2D6A4F"}}>{colCap-colBks.length}</div><div className="stat-l">Remaining</div></div>
            <div className="stat"><div className="stat-n">{totalSlots}</div><div className="stat-l">Open Slots</div></div>
          </div>

          <div className="slots-lbl">Total Capacity</div>
          <div className="cap-ctl">
            <button className="cap-btn" onClick={()=>adjCap(-1)}>−</button>
            <div className="cap-val">{colCap}</div>
            <button className="cap-btn" onClick={()=>adjCap(1)}>+</button>
            <span style={{fontSize:11,color:"#CCC",marginLeft:4}}>max participants</span>
          </div>
          <div className="divider"/>

          <div className="slots-lbl" style={{marginBottom:12}}>Set Available Dates & Times</div>
          <div className="cal-hdr">
            <div className="cal-ttl">{MONTHS[calMonth]} {calYear}</div>
            <CalNav month={calMonth} year={calYear} onChange={(m,y)=>{setCalMon(m);setCalYear(y);}}/>
          </div>
          <div className="cal-grid">
            {DAYS.map(d=><div key={d} className="cal-dl">{d}</div>)}
            {Array.from({length:fd},(_,i)=><div key={`e${i}`} className="cd"/>)}
            {Array.from({length:dim},(_,i)=>{
              const d=i+1,ds=fmtKey(calYear,calMonth,d);
              const has=ds in colSlots,hasT=has&&colSlots[ds].length>0,isSel=selDate===ds;
              return (
                <div key={d} className={`cd ${has?"hsd":""} ${isSel?"sd":""}`}
                  style={{"--hc":col.color,"--sc2":col.color}}
                  onClick={()=>setSelDate(isSel?null:ds)}>
                  {d}{hasT&&!isSel&&<span className="dot" style={{background:col.color}}/>}
                </div>
              );
            })}
          </div>

          {selDate&&(
            <div className="slots-sec">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div className="slots-lbl" style={{marginBottom:0}}>{fmtDisp(selDate)}</div>
                <button className="btn-rm" onClick={()=>removeDate(selDate)}>✕ Remove date</button>
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:7}}>
                {ALL_TIMES.map(t=>{
                  const on=(colSlots[selDate]||[]).includes(t);
                  return <button key={t} className={`tt ${on?"on":""}`} style={{"--tc":col.color}} onClick={()=>toggleTime(selDate,t)}>{t}</button>;
                })}
              </div>
            </div>
          )}

          <div className="divider"/>
          <div className="slots-lbl" style={{marginBottom:10}}>Add a New Available Date</div>
          <div className="add-row">
            <input type="date" value={newDate} onChange={e=>setNewDate(e.target.value)} min="2026-01-01"/>
            <button className="btn-add" disabled={!newDate||newDate in colSlots} onClick={addDate}>+ Add Date</button>
          </div>
          {newDate&&colSlots[newDate]!==undefined&&<div style={{fontSize:11,color:"#E08030",marginTop:7}}>Already added — select it on the calendar above to edit.</div>}
          {dirty&&<div className="save-bar"><div style={{fontSize:13,fontWeight:500}}>Unsaved changes</div><button className="btn-sv" onClick={()=>{setSaved(true);setDirty(false);}}>Save</button></div>}
          {saved&&!dirty&&<div className="saved-toast">✓ Availability saved{isConfigured()?" to Firebase":""}</div>}
        </div>

        <div className="card" style={{marginTop:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
            <div><div className="lbl b">Upcoming Sessions</div><div className="ttl">Your Bookings</div></div>
            <div style={{fontSize:12,color:"#AAA"}}>{colBks.length} total</div>
          </div>
          {colBks.length>0 ? colBks.map(b=>(
            <div key={b.id} className="bk-item">
              <div>
                <div className="bi-nm">{b.name}</div>
                <div className="bi-em">{b.email}{b.phone?` · ${b.phone}`:""}</div>
                <div style={{fontSize:10,color:"#CCC",marginTop:2}}>Age {b.age} · {b.year} · {b.major}</div>
              </div>
              <div>
                <div className="bi-tm">{b.time}</div>
                <div className="bi-dt">{fmtDisp(b.date)}</div>
                <div style={{fontSize:10,color:"#CCC",marginTop:2,textAlign:"right"}}>ID: {b.id}</div>
              </div>
            </div>
          )):<div style={{color:"#CCC",fontSize:12,fontStyle:"italic",textAlign:"center",padding:28}}>No bookings yet.</div>}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN PORTAL
// ─────────────────────────────────────────────────────────────────────────────
function AdminPortal({ data, onHome }) {
  const { slots, capacity, bookings, loading } = data;
  const [loggedIn, setLoggedIn] = useState(false);
  const [tab,      setTab]      = useState("overview");

  // ── Excel export ──────────────────────────────────────────────────────────
  function exportExcel() {
    const wb = XLSX.utils.book_new();
    const ts = new Date().toLocaleString();

    // ── Sheet 1: Participant Registrations ──
    const p_rows = bookings.map((b,i) => ({
      "#":                i+1,
      "Registration ID":  b.id,
      "Registered At":    b.registeredAt ? new Date(b.registeredAt).toLocaleString() : "",
      "First Name":       b.firstName  || b.name?.split(" ")[0] || "",
      "Last Name":        b.lastName   || b.name?.split(" ").slice(1).join(" ") || "",
      "Email":            b.email,
      "Age":              b.age,
      "Academic Level":   b.year,
      "Major":            b.major,
      "Phone":            b.phone || "",
    }));
    const ws1 = XLSX.utils.json_to_sheet(p_rows.length ? p_rows : [{"No registrations yet":""}]);
    ws1["!cols"] = [4,14,20,12,14,28,5,16,22,15].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws1, "Participant Registrations");

    // ── Sheet 2: Session Bookings ──
    const b_rows = bookings.map((b,i) => ({
      "#":                i+1,
      "Registration ID":  b.id,
      "Participant Name": b.name,
      "Email":            b.email,
      "Data Collector":   b.collector,
      "Collector Email":  b.collectorEmail,
      "Session 1 Date":   b.date,
      "Session 1 Time":   b.time,
      "Session 2 Date":   (() => {
        try { const d=new Date(b.date); d.setDate(d.getDate()+3); return d.toISOString().slice(0,10); } catch { return ""; }
      })(),
      "Session 2 Time":   b.time,
      "Registered At":    b.registeredAt ? new Date(b.registeredAt).toLocaleString() : "",
    }));
    const ws2 = XLSX.utils.json_to_sheet(b_rows.length ? b_rows : [{"No bookings yet":""}]);
    ws2["!cols"] = [4,14,22,26,22,26,14,10,14,10,20].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws2, "Session Bookings");

    // ── Sheet 3: Collector Availability ──
    const a_rows = [];
    STAFF_BASE.forEach(s => {
      const ss = slots?.[s.id] || {};
      Object.entries(ss).sort().forEach(([date,times]) => {
        a_rows.push({
          "Collector":       s.name,
          "Collector Email": s.email,
          "Date":            date,
          "Date (Readable)": fmtDisp(date),
          "Available Times": times.join(", "),
          "Slot Count":      times.length,
          "Capacity":        capacity?.[s.id] ?? 20,
          "Booked":          bookings.filter(b=>b.staffId===s.id).length,
          "Remaining":       (capacity?.[s.id]??20) - bookings.filter(b=>b.staffId===s.id).length,
        });
      });
    });
    const ws3 = XLSX.utils.json_to_sheet(a_rows.length ? a_rows : [{"No availability set":""}]);
    ws3["!cols"] = [22,26,12,22,40,10,10,8,10].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws3, "Collector Availability");

    // ── Sheet 4: Summary ──
    const s_rows = STAFF_BASE.map(s => {
      const booked = bookings.filter(b=>b.staffId===s.id).length;
      const cap    = capacity?.[s.id] ?? 20;
      const days   = Object.keys(slots?.[s.id]||{}).length;
      const open   = Object.values(slots?.[s.id]||{}).reduce((n,a)=>n+a.length,0);
      return {
        "Collector":      s.name,
        "Email":          s.email,
        "Capacity":       cap,
        "Total Booked":   booked,
        "Remaining":      cap-booked,
        "Fill Rate":      cap>0?`${Math.round((booked/cap)*100)}%`:"—",
        "Available Days": days,
        "Open Slots":     open,
      };
    });
    // Add totals row
    s_rows.push({
      "Collector":"TOTAL","Email":"",
      "Capacity":   s_rows.reduce((n,r)=>n+(r["Capacity"]||0),0),
      "Total Booked":s_rows.reduce((n,r)=>n+(r["Total Booked"]||0),0),
      "Remaining":  s_rows.reduce((n,r)=>n+(r["Remaining"]||0),0),
      "Fill Rate":"","Available Days":"","Open Slots":s_rows.reduce((n,r)=>n+(r["Open Slots"]||0),0),
    });
    const ws4 = XLSX.utils.json_to_sheet(s_rows);
    ws4["!cols"] = [22,26,10,13,10,10,14,11].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, ws4, "Summary");

    XLSX.writeFile(wb, `study-data-${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  if (loading) return <div className="ctn" style={{textAlign:"center",paddingTop:80,color:"#AAA"}}>Loading…</div>;

  if (!loggedIn) return (
    <>
      <div className="hdr adm">
        <div className="hdr-top">
          <div><div className="hdr-badge">Administration</div><h1>Admin Dashboard</h1><div className="hdr-sub">Full Data Access · IRB-2025-304</div></div>
          <div className="hdr-btns"><button className="btn-home" onClick={onHome}>← Home</button></div>
        </div>
      </div>
      <div className="ctn">
        <div className="card" style={{maxWidth:380,margin:"0 auto"}}>
          <PinPad
            pinColor="#6B2737"
            hint="Demo admin PIN: 0000"
            subtitle="Administration Access"
            title="Enter Admin PIN"
            onSuccess={p=>{if(p===ADMIN_PIN){setLoggedIn(true);return true;}return false;}}
          />
        </div>
      </div>
    </>
  );

  const totalBooked = bookings.length;
  const totalCap    = Object.values(capacity||DEFAULT_CAPACITY).reduce((a,b)=>a+b,0);
  const totalSlots  = STAFF_BASE.reduce((n,s)=>n+Object.values(slots?.[s.id]||{}).reduce((x,a)=>x+a.length,0),0);
  const fillRate    = totalCap>0?Math.round((totalBooked/totalCap)*100):0;

  return (
    <>
      <div className="hdr adm">
        <div className="hdr-top">
          <div>
            <div className="hdr-badge">Administration</div>
            <h1>Admin Dashboard</h1>
            <div className="hdr-sub">Full Data Access · IRB-2025-304</div>
          </div>
          <div className="hdr-btns">
            <button className="btn-home" onClick={onHome}>← Home</button>
            <button className="btn-home ghost" onClick={()=>setLoggedIn(false)}>Sign Out</button>
          </div>
        </div>
      </div>

      <div className="ctn">
        {isConfigured()&&<div className="firebase-badge">🔥 Firebase connected — data is live</div>}

        {/* KPI cards */}
        <div className="stat-cards">
          <div className="stat-card"><div className="sc-num">{totalBooked}</div><div className="sc-lbl">Registrations</div></div>
          <div className="stat-card"><div className="sc-num">{totalCap}</div><div className="sc-lbl">Total Capacity</div></div>
          <div className="stat-card"><div className="sc-num" style={{color:"#2D6A4F"}}>{totalCap-totalBooked}</div><div className="sc-lbl">Spots Remaining</div></div>
          <div className="stat-card"><div className="sc-num">{fillRate}%</div><div className="sc-lbl">Fill Rate</div></div>
        </div>

        {/* Excel export */}
        <div style={{marginBottom:20,display:"flex",justifyContent:"flex-end"}}>
          <button className="btn xl" onClick={exportExcel}>
            ⬇ Download Excel — All Data
          </button>
        </div>

        {/* Tabs */}
        <div className="tab-bar">
          {[["overview","📊 Overview"],["participants","🎓 Participants"],["bookings","📅 Bookings"],["availability","📋 Availability"]].map(([k,l])=>(
            <button key={k} className={`tab ${tab===k?"active":""}`} onClick={()=>setTab(k)}>{l}</button>
          ))}
        </div>

        {/* ── Tab: Overview ── */}
        {tab==="overview"&&(
          <div className="card">
            <div className="lbl r">Per-Collector Summary</div>
            <div className="ttl" style={{marginBottom:20}}>Study Overview</div>
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr><th>Collector</th><th>Email</th><th>Capacity</th><th>Booked</th><th>Remaining</th><th>Fill</th><th>Days</th><th>Slots</th></tr></thead>
                <tbody>
                  {STAFF_BASE.map(s=>{
                    const booked=bookings.filter(b=>b.staffId===s.id).length;
                    const cap=capacity?.[s.id]??20;
                    const fill=cap>0?Math.round((booked/cap)*100):0;
                    const days=Object.keys(slots?.[s.id]||{}).length;
                    const open=Object.values(slots?.[s.id]||{}).reduce((n,a)=>n+a.length,0);
                    return (
                      <tr key={s.id}>
                        <td><span style={{display:"inline-flex",alignItems:"center",gap:7}}>
                          <span style={{background:s.color,color:"white",borderRadius:6,width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,fontWeight:700,flexShrink:0}}>{s.avatar}</span>
                          {s.name}
                        </span></td>
                        <td style={{color:"#888"}}>{s.email}</td>
                        <td>{cap}</td>
                        <td><span className="badge green">{booked}</span></td>
                        <td>{cap-booked}</td>
                        <td>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <div style={{width:50,height:5,background:"#F0EDE8",borderRadius:3,overflow:"hidden"}}>
                              <div style={{width:`${fill}%`,height:"100%",background:s.color,opacity:.7,borderRadius:3}}/>
                            </div>
                            <span style={{fontSize:11,color:"#888"}}>{fill}%</span>
                          </div>
                        </td>
                        <td>{days}</td>
                        <td>{open}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Tab: Participants ── */}
        {tab==="participants"&&(
          <div className="card">
            <div className="export-bar">
              <div><div className="lbl r">All Registrations</div><div className="ttl">{bookings.length} Participant{bookings.length!==1?"s":""}</div></div>
            </div>
            {bookings.length===0
              ? <div className="empty-state">No participants have registered yet.</div>
              : <div className="table-wrap"><table className="data-table">
                  <thead><tr><th>#</th><th>Name</th><th>Email</th><th>Age</th><th>Level</th><th>Major</th><th>Phone</th><th>Registered</th></tr></thead>
                  <tbody>
                    {bookings.map((b,i)=>(
                      <tr key={b.id}>
                        <td style={{color:"#CCC"}}>{i+1}</td>
                        <td style={{fontWeight:600}}>{b.name}</td>
                        <td style={{color:"#666"}}>{b.email}</td>
                        <td>{b.age}</td>
                        <td><span className="badge blue">{b.year}</span></td>
                        <td>{b.major}</td>
                        <td>{b.phone||<span style={{color:"#DDD"}}>—</span>}</td>
                        <td style={{color:"#AAA",fontSize:11}}>{b.registeredAt?new Date(b.registeredAt).toLocaleDateString():"—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
            }
          </div>
        )}

        {/* ── Tab: Bookings ── */}
        {tab==="bookings"&&(
          <div className="card">
            <div className="export-bar">
              <div><div className="lbl r">Session Assignments</div><div className="ttl">{bookings.length} Booking{bookings.length!==1?"s":""}</div></div>
            </div>
            {bookings.length===0
              ? <div className="empty-state">No bookings yet.</div>
              : <div className="table-wrap"><table className="data-table">
                  <thead><tr><th>#</th><th>Participant</th><th>Data Collector</th><th>Session 1</th><th>Session 2</th><th>Reg. ID</th></tr></thead>
                  <tbody>
                    {bookings.map((b,i)=>{
                      const s2=new Date(b.date);s2.setDate(s2.getDate()+3);
                      return (
                        <tr key={b.id}>
                          <td style={{color:"#CCC"}}>{i+1}</td>
                          <td><div style={{fontWeight:600}}>{b.name}</div><div style={{fontSize:11,color:"#AAA"}}>{b.email}</div></td>
                          <td>
                            <div style={{display:"flex",alignItems:"center",gap:6}}>
                              {(()=>{const s=STAFF_BASE.find(x=>x.id===b.staffId);return s?<span style={{background:s.color,color:"white",borderRadius:5,padding:"2px 7px",fontSize:10,fontWeight:700}}>{s.avatar}</span>:null;})()}
                              <span>{b.collector}</span>
                            </div>
                          </td>
                          <td><div style={{fontWeight:600}}>{fmtDisp(b.date)}</div><div style={{fontSize:11,color:"#888"}}>{b.time}</div></td>
                          <td><div style={{fontWeight:600}}>{fmtDisp(s2.toISOString().slice(0,10))}</div><div style={{fontSize:11,color:"#888"}}>{b.time}</div></td>
                          <td style={{fontFamily:"monospace",fontSize:11,color:"#AAA"}}>{b.id}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
            }
          </div>
        )}

        {/* ── Tab: Availability ── */}
        {tab==="availability"&&(
          <div className="card">
            <div className="lbl r" style={{marginBottom:7}}>Collector Schedules</div>
            <div className="ttl" style={{marginBottom:22}}>All Availability</div>
            {STAFF_BASE.map(s=>{
              const ss=slots?.[s.id]||{}, dates=Object.keys(ss).sort();
              return (
                <div key={s.id} style={{marginBottom:30}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                    <div style={{background:s.color,color:"white",borderRadius:10,width:38,height:38,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,flexShrink:0}}>{s.avatar}</div>
                    <div>
                      <div style={{fontWeight:600,fontSize:15}}>{s.name}</div>
                      <div style={{fontSize:11,color:"#AAA"}}>{s.role} · {s.email}</div>
                    </div>
                    <div style={{marginLeft:"auto",fontSize:11,color:"#AAA",textAlign:"right"}}>
                      {dates.length} days · {Object.values(ss).reduce((n,a)=>n+a.length,0)} slots<br/>
                      <span style={{color:"#2D6A4F",fontWeight:600}}>{bookings.filter(b=>b.staffId===s.id).length} booked</span>
                    </div>
                  </div>
                  {dates.length===0
                    ? <div style={{fontSize:12,color:"#CCC",fontStyle:"italic"}}>No availability set.</div>
                    : <div className="table-wrap"><table className="data-table">
                        <thead><tr><th>Date</th><th>Available Times</th><th>Slots</th></tr></thead>
                        <tbody>
                          {dates.map(ds=>(
                            <tr key={ds}>
                              <td style={{fontWeight:600,whiteSpace:"nowrap"}}>{fmtDisp(ds)}</td>
                              <td style={{color:"#555"}}>{ss[ds].join(" · ")||<span style={{color:"#DDD"}}>No times set</span>}</td>
                              <td>{ss[ds].length}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table></div>
                  }
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT — Hash routing
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [route, setRoute] = useState(()=>window.location.hash.replace("#","")||"home");
  const data = useStudyData();

  useEffect(()=>{
    const h=()=>setRoute(window.location.hash.replace("#","")||"home");
    window.addEventListener("hashchange",h);
    return ()=>window.removeEventListener("hashchange",h);
  },[]);

  function go(r){ window.location.hash=r; setRoute(r); }

  return (
    <>
      <style>{CSS}</style>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div className="app">
        {route==="home"&&(
          <div className="landing">
            <div className="landing-logo">🧠</div>
            <div className="landing-title">Cognitive Fatigue Research Study</div>
            <div className="landing-sub">Purdue University · IRB-2025-304 · Prof. Jason Morphew</div>
            {!isConfigured()&&(
              <div className="demo-banner">
                ⚡ Demo mode — Add Firebase config to enable persistence & real emails
              </div>
            )}
            <div className="landing-cards">
              <div className="lcard p" onClick={()=>go("participant")}>
                <div className="lc-icon">🎓</div>
                <div className="lc-title">Participant</div>
                <div className="lc-desc">Register for the study, review the consent form, and book your session with a data collector.</div>
                <div className="lc-link">yoursite.com/#participant →</div>
              </div>
              <div className="lcard c" onClick={()=>go("collector")}>
                <div className="lc-icon">📋</div>
                <div className="lc-title">Data Collector</div>
                <div className="lc-desc">Log in with your PIN to manage your availability calendar and view incoming bookings.</div>
                <div className="lc-link">yoursite.com/#collector →</div>
              </div>
              <div className="lcard a" onClick={()=>go("admin")}>
                <div className="lc-icon">🔐</div>
                <div className="lc-title">Admin</div>
                <div className="lc-desc">View all participant data, monitor registrations in real-time, and download the full Excel report.</div>
                <div className="lc-link">yoursite.com/#admin →</div>
              </div>
            </div>
            <div className="url-chips">
              <span className="url-chip" onClick={()=>go("participant")}>#participant</span>
              <span className="url-chip" onClick={()=>go("collector")}>#collector</span>
              <span className="url-chip" onClick={()=>go("admin")}>#admin</span>
            </div>
          </div>
        )}
        {route==="participant" && <ParticipantPortal data={data} onHome={()=>go("home")}/>}
        {route==="collector"   && <CollectorPortal   data={data} onHome={()=>go("home")}/>}
        {route==="admin"       && <AdminPortal       data={data} onHome={()=>go("home")}/>}
      </div>
    </>
  );
}
