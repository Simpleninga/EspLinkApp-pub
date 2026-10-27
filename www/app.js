"use strict";
// 小芽 App v2（2026-10-14 按用户反馈重做）。走服务器 8003 的 /ws（WebSocket，一条文本帧 = 一行 JSON），hello 带 app:2。
// 不再跟遥控器共用屏幕栈、不再模拟按键：页面自己画，数据靠请求 q{id, op} → r{id, d | err}，有变化服务器推 ev{w}（协议见 server.py「手机 App v2」一节）。
//   主页：Claude / 小智 / AI 日报三张卡，底下「呼叫小芽」（没有音量、按键说明、命令面板、唤醒词）
//   Claude、小智：微信式对话气泡，回复按 Markdown 排版；底下是通用输入栏（打字 / 按住说话 / + 图片文件），小芽通话里也是同一个
//   小芽：像微信通话——呼叫后全屏，左上角收起成悬浮小窗（可拖、停靠两边、甩到边上收成一条），点小窗回全屏，挂断结束
// 音频：上传 rec 是 16k IMA ADPCM（不带 fmt）；朗读看 hello 的 spk：1 = 16k ADPCM（a16），2 = 不压缩的 24k 16 位 PCM（p24，2026-10-22 起，见 p24Ok）。
// 2026-10-14 第三版（用户反馈 iOS 收不到音 / 没声音 / 键盘挡输入框、要后台运行和通知、两台设备各管各的、要登录）：
//   · 安装包 v3 带原生模块 Link（安卓 Java、iOS Swift，见 app/android … LinkPlugin.java、app/ios/App/App/Link.swift）：
//     长连接、录音、朗读、后台保活、系统通知都在原生里，锁屏 / 切到后台小芽照样通话。没有 Link（旧安装包、浏览器里测）就走下面的网页版老路子
//   · 要先登录（账号密码换一个令牌，存在 cfg.token）；安装包里不再带服务器密钥
//   · 只有一个悬浮框：小芽通话收起时的悬浮球（原来的「正在朗读」条和提示条去掉了）。2026-10-16 起没在通话时它也不出来报提示：
//     用户「新对话已打开」「朗读」都弹一长条，App 里的弹窗都不要。成功了界面自己会变；出错就地一行字（hint）；在念就顶栏一个「停止朗读」
//   · 服务器按设备号（DEV_ID，每台装好随机生成）把朗读、提示、小芽的动作只回给发起的那台
// 🔴 iOS 只有「点一下」（touchend / click）才算用户手势，按下（pointerdown）不算：网页版声音通道没在点击里打开过，
//    按住说话就录到 0 秒（2026-10-13 日志里 iPhone 按住说话全是「The audio is empty」）。所以网页版每次点击都顺手把 AudioContext 唤醒。

const $ = s => document.querySelector(s);
let cfg = { token: "", user: "", servers: [] };
try { cfg = Object.assign(cfg, window.ESP_CONFIG || {}, JSON.parse(localStorage.getItem("cfg") || "{}")); } catch (e) { cfg = Object.assign(cfg, window.ESP_CONFIG || {}); }
const CAP = window.Capacitor;
const PLATFORM = (CAP && CAP.getPlatform && CAP.getPlatform()) || "web";
const DEV_ID = (() => {                              // 每台手机一个设备号：服务器按它把朗读、提示只回给这台
  let id = null;
  try { id = localStorage.getItem("devId"); } catch (e) { /* 没有存储 */ }
  if (!id) { id = PLATFORM + "-" + Math.random().toString(36).slice(2, 8); try { localStorage.setItem("devId", id); } catch (e) { /* 没有存储 */ } }
  return id;
})();
const DEV_LABEL = PLATFORM === "ios" ? "iPhone" : PLATFORM === "android" ? "安卓" : "浏览器";
function saveCfg() { try { localStorage.setItem("cfg", JSON.stringify({ servers: cfg.servers, token: cfg.token, user: cfg.user })); } catch (e) { /* 没有存储 */ } }
const HOSTS = {};
const EASE = "cubic-bezier(.32,.72,0,1)";
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return null; }

// 原生插件（@capacitor/app 管安卓返回键，@capacitor/haptics 管震动）：没装 / 在浏览器里跑就当没有
function plug(name) {
  try {
    if (!CAP || !CAP.isNativePlatform || !CAP.isNativePlatform() || !CAP.isPluginAvailable(name)) return null;
    return CAP.registerPlugin(name);
  } catch (e) { return null; }
}
const Hap = plug("Haptics"), AppP = plug("App"), Bars = plug("SystemBars"), Kbd = plug("Keyboard");
const Link = plug("Link");                           // 安装包 v3 的原生模块：长连接 + 录音 + 朗读 + 后台 + 通知
let bgOn = store("bgOn") !== "0", noteOn = store("noteOn") !== "0";   // 后台运行、通知：默认都开
// 自动朗读：小芽、小智的回复要不要自己念出来（服务器按 op ar 记着，见 server.py auto_read）。默认关——
// 2026-10-16 用户开着小芽通话口述，每句都被念回来打断。日报、「只念这条」、长按朗读这些点了才念的不受它管
let autoRead = store("autoRead") === "1";
function hap(k) {
  try {
    if (Hap) Hap.impact({ style: k === "medium" ? "MEDIUM" : k === "heavy" ? "HEAVY" : "LIGHT" }).catch(() => {});
    else if (navigator.vibrate) navigator.vibrate(k === "medium" ? 12 : 7);
  } catch (e) { /* 震不了就算了 */ }
}

// ---------------------------------------------------------------- 图标（24 格，描边）
const ICONS = {
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  chev: '<path d="M9.5 6l6 6-6 6"/>',
  down: '<path d="M6 9.5l6 6 6-6"/>',
  mic: '<rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>',
  micOff: '<path d="M15 10V6a3 3 0 0 0-5.6-1.5M9 9v2.5a3 3 0 0 0 5 2.2"/><path d="M5.5 11.5a6.5 6.5 0 0 0 10.9 4.8M18.5 11.5a6.4 6.4 0 0 1-.5 2.5M12 18v2.5M4 4l16 16"/>',
  kbd: '<rect x="3" y="6" width="18" height="12.5" rx="3"/><path d="M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01M7 13.5h.01M17 13.5h.01M9.5 14.5h5"/>',
  claude: '<path d="M12 3.5v17M4.6 7.75l14.8 8.5M4.6 16.25l14.8-8.5"/>',
  chat: '<path d="M20 11.5c0 4-3.6 7-8 7-1.1 0-2.2-.2-3.1-.5L4.5 19.5l1.2-3.4C4.6 14.8 4 13.2 4 11.5c0-4 3.6-7 8-7s8 3 8 7z"/>',
  news: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 9h8M8 12.5h8M8 16h5"/>',
  sliders: '<path d="M4 7.5h9M17.5 7.5H20M4 16.5h3M11.5 16.5H20"/><circle cx="15.2" cy="7.5" r="2.2"/><circle cx="9.2" cy="16.5" r="2.2"/>',
  layers: '<path d="M12 4l8.5 4.2L12 12.4 3.5 8.2 12 4z"/><path d="M3.5 12.2l8.5 4.2 8.5-4.2M3.5 16l8.5 4.2 8.5-4.2"/>',
  compose: '<path d="M12 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V12"/><path d="M17.3 4.3l2.4 2.4L12 14.4l-3.2.8.8-3.2 7.7-7.7z"/>',
  plus: '<circle cx="12" cy="12" r="8.6"/><path d="M12 8v8M8 12h8"/>',
  plain: '<path d="M12 5.5v13M5.5 12h13"/>',
  play: '<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2A.8.8 0 0 0 8 5.8z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.5"/>',
  check: '<path d="M5.5 12.5l4 4L18.5 7.5"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>',
  speak: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6M18.2 6.5a7.8 7.8 0 0 1 0 11"/>',
  speakOff: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  term: '<path d="M5 7.5l4 4-4 4M11.5 16.5H19"/>',
  file: '<path d="M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M13 3.5V8.5h5"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.7"/><path d="M20.5 15.5L16 11l-8.5 8.5"/>',
  camera: '<path d="M4 8.5a2 2 0 0 1 2-2h2.2l1.6-2.2h4.4l1.6 2.2H18a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.6"/>',
  folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4.2l2 2.3h6.8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  pencil: '<path d="M14.5 5.5l4 4L9 19H5v-4l9.5-9.5z"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z"/>',
  spark: '<path d="M12 4c.5 3.9 2.6 6 6.5 6.5-3.9.5-6 2.6-6.5 6.5-.5-3.9-2.6-6-6.5-6.5C9.4 10 11.5 7.9 12 4z"/>',
  list: '<path d="M9 7h11M9 12h11M9 17h11M4.5 7h.1M4.5 12h.1M4.5 17h.1"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 6.8"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
  phone: '<path d="M6.6 3.6h2.5l1.5 4-2.1 1.3a11 11 0 0 0 6.6 6.6l1.3-2.1 4 1.5v2.5a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.8a2 2 0 0 1 2-2.2z"/>',
  hang: '<path d="M2.6 13.4c5.3-5 13.5-5 18.8 0 .5.5.5 1.2.1 1.7l-1.6 1.9c-.4.4-1 .5-1.5.2l-2.6-1.4a1.2 1.2 0 0 1-.6-1.2l.2-1.7a11.6 11.6 0 0 0-6.8 0l.2 1.7c.1.5-.2 1-.6 1.2L5.6 17.2c-.5.3-1.1.2-1.5-.2l-1.6-1.9c-.4-.5-.4-1.2.1-1.7z"/>',
  home: '<path d="M4.5 10.5L12 4.5l7.5 6V19a1 1 0 0 1-1 1h-4v-5.5h-5V20h-4a1 1 0 0 1-1-1v-8.5z"/>',
  gauge: '<path d="M4.6 16.5a8 8 0 1 1 14.8 0"/><path d="M12 13.5l3.2-4"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3.2"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h9"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  book: '<path d="M5 4.5h9.5a3 3 0 0 1 3 3V19.5H8a3 3 0 0 1-3-3z"/><path d="M5 16.5a3 3 0 0 1 3-3h9.5M9 8h5"/>',
  repeat: '<path d="M17 4.5l2.5 2.5L17 9.5"/><path d="M19.5 7H8a3.5 3.5 0 0 0-3.5 3.5v1M7 19.5L4.5 17 7 14.5"/><path d="M4.5 17H16a3.5 3.5 0 0 0 3.5-3.5v-1"/>',
  power: '<path d="M12 3.5v8"/><path d="M7.2 6.6a7.5 7.5 0 1 0 9.6 0"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 7.5V2.5"/><path d="M15 7.5V2.5"/><path d="M18 9.5v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4v-4z"/>',
  download: '<path d="M12 4.5v10M7.5 10.5l4.5 4.5 4.5-4.5M5 19.5h14"/>',
  minus: '<path d="M5.5 12h13"/>',
  vtop: '<path d="M6.5 5h11M12 19.5V9M7.5 13.5L12 9l4.5 4.5"/>',
  vbot: '<path d="M6.5 19h11M12 4.5V15M7.5 10.5l4.5 4.5 4.5-4.5"/>',
};
const FILLED = new Set(["play", "stop", "hang"]);
function ico(n) { return `<svg class="ic${FILLED.has(n) ? " fill" : ""}" viewBox="0 0 24 24">${ICONS[n] || ICONS.spark}</svg>`; }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
const LOGO = '<span class="orb sprout"><i></i></span>';
const PIX = '<span class="pix">' + "<i></i>".repeat(9) + "</span>";

function reltime(ts) {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return "刚刚";
  if (d < 3600) return Math.floor(d / 60) + " 分钟前";
  if (d < 86400) return Math.floor(d / 3600) + " 小时前";
  if (d < 172800) return "昨天";
  const t = new Date(ts * 1000);
  return `${t.getMonth() + 1}月${t.getDate()}日`;
}
function fsize(n) { return n < 1024 ? n + " B" : n < 1 << 20 ? Math.round(n / 1024) + " KB" : n < 1 << 30 ? (n / 1048576).toFixed(1) + " MB" : (n / 1073741824).toFixed(1) + " GB"; }
function mmss(ms) { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
const host = () => (Link && srvName) || cfg.servers[srv % cfg.servers.length];
const fileUrl = id => `http://${host()}/app/f?key=${encodeURIComponent(cfg.token)}&id=${encodeURIComponent(id)}`;

// ---------------------------------------------------------------- 回复里的服务器路径（2026-10-27）
// 认出 /root/…、~/… （行内代码里还认 app/www/app.js 这种带斜杠的相对路径，按 /root 算：Claude 就在 /root 里干活），
// 先当普通文字摆着，服务器（op fsstat）确认真的存在了才变成可点的链接（免得 /api/foo 之类被误认）。点了 = App 里直接看（见 ACT.path）
const PATH_SEG = "[\\w.@+\\-\\u3400-\\u9fff]";
const PATH_RE = new RegExp(`(^|[\\s（(\\[「『“"';：:，,、=])((?:~)?\\/${PATH_SEG}+(?:\\/${PATH_SEG}+)*\\/?)`, "g");
const pathMemo = new Map();                          // 绝对路径 → { m: {t: f|d, size, mtime} | null, at }：存在的记 10 分钟，不存在的 20 秒（Claude 可能马上就写出来）
const pathAbs = p => p.startsWith("~/") ? "/root" + p.slice(1) : p;
function pathGet(p) {
  const e = pathMemo.get(p);
  if (!e) return undefined;
  if (Date.now() - e.at > (e.m ? 600000 : 20000)) { pathMemo.delete(p); return undefined; }
  return e.m;
}
function pathTag(tag, p, shown) {
  const m = pathGet(p);
  return `<${tag} class="pth${m ? " ok" : ""}" data-p="${esc(p)}"${m ? ` data-act="path:${esc(p)}"` : ""}>${shown}</${tag}>`;
}
function pathify(html) {                             // 已转义的 HTML 里，标签和链接之外的文字中的路径
  return html.split(/(<a\b[^>]*>[\s\S]*?<\/a>|<[^>]+>)/).map((seg, i) => i % 2 ? seg : seg.replace(PATH_RE, (all, pre, p) => {
    const tail = (p.match(/[.\-]+$/) || [""])[0];     // 句末的点 / 横线不算路径
    p = p.slice(0, p.length - tail.length);
    return p.length < 2 ? all : pre + pathTag("span", pathAbs(p).replace(/(.)\/+$/, "$1"), p) + tail;
  })).join("");
}
function codePath(c) {                               // 行内代码整个就是一个路径？是就返回绝对路径
  c = c.trim();
  if (!c || c.length > 300 || /\s/.test(c)) return "";
  const t = c.replace(/:\d+(?::\d+)?$/, "");         // /root/a.py:12 这种带行号的
  if (/^~?\/[\w.@+\-\u3400-\u9fff/]+$/.test(t)) return pathAbs(t).replace(/\/+$/, "");
  if (/^[\w.\-\u3400-\u9fff]+(\/[\w.\-\u3400-\u9fff]+)+\/?$/.test(t)) return "/root/" + t.replace(/\/+$/, "");
  return "";
}
let pathTimer = 0;
function pathScan() {
  clearTimeout(pathTimer);
  pathTimer = setTimeout(async () => {
    const els = [...document.querySelectorAll("#stage .pth:not([data-v])")];
    if (!els.length) return;
    const need = [...new Set(els.map(e => e.dataset.p).filter(p => pathGet(p) === undefined))].slice(0, 80);
    if (need.length) {
      if (!online) return;
      try {
        const r = await q("fsstat", { paths: need });
        need.forEach(p => pathMemo.set(p, { m: r[p] || null, at: Date.now() }));
      } catch (e) { return; }
    }
    document.querySelectorAll("#stage .pth:not([data-v])").forEach(e => {
      const m = pathGet(e.dataset.p);
      if (m === undefined) return;
      e.dataset.v = "1";
      if (m) { e.classList.add("ok"); e.dataset.act = "path:" + e.dataset.p; }
    });
    if (need.length === 80) pathScan();               // 一次最多问 80 个，还有的接着问
  }, 120);
}
if (window.MutationObserver) new MutationObserver(pathScan).observe($("#stage"), { childList: true, subtree: true });

// ---------------------------------------------------------------- Markdown（自己写的小解析器：标题、列表、引用、代码块、表格、分割线、加粗斜体、行内代码、链接）
function mdInline(s) {
  const codes = [];
  s = String(s).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return "\u0001" + (codes.length - 1) + "\u0002"; });
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[^"=>\w])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]。，；：！？）」』])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "<b>$1</b>").replace(/__(?=\S)([^\n]*?\S)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1<i>$2</i>");
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, "<s>$1</s>");
  s = pathify(s);
  return s.replace(/\u0001(\d+)\u0002/g, (_, k) => { const p = codePath(codes[k]); return p ? pathTag("code", p, esc(codes[k])) : `<code>${esc(codes[k])}</code>`; });
}
const MD_LIST = /^(\s*)([-*+•]|\d{1,3}[.)、])\s+(.*)$/;
const MD_BLOCK = /^\s*(```|~~~|#{1,6}\s|>|([-*_])(\s*\2){2,}\s*$)/;
function md(src) {
  const L = String(src || "").replace(/\r/g, "").replace(/\t/g, "    ").split("\n");
  const out = [];
  let i = 0;
  while (i < L.length) {
    const l = L[i];
    let m = l.match(/^\s*(```|~~~)\s*([\w+#.-]*)/);
    if (m) {                                         // 代码块（流式输出时可能还没收尾，读到底为止）
      const buf = [];
      i++;
      while (i < L.length && !L[i].trim().startsWith(m[1])) buf.push(L[i++]);
      i++;
      out.push(`<pre>${m[2] ? `<span class="lang">${esc(m[2])}</span>` : ""}<button class="cp" data-act="copycode">复制</button><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    if ((m = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) { out.push(`<div class="mh mh${m[1].length}">${mdInline(m[2])}</div>`); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (l.includes("|") && i + 1 < L.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(L[i + 1])) {
      const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => mdInline(c.trim()));
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < L.length && L[i].includes("|") && L[i].trim()) rows.push(cells(L[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map(c => `<th>${c}</th>`).join("")}</tr></thead><tbody>` +
        rows.map(r => `<tr>${head.map((_, k) => `<td>${r[k] || ""}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>");
      continue;
    }
    if (/^\s{0,3}>/.test(l)) {
      const buf = [];
      while (i < L.length && /^\s{0,3}>/.test(L[i])) buf.push(L[i++].replace(/^\s{0,3}>\s?/, ""));
      out.push(`<blockquote>${md(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (MD_LIST.test(l)) {
      const items = [];
      while (i < L.length) {
        const x = L[i].match(MD_LIST);
        if (x) { items.push({ ind: x[1].length, ord: /\d/.test(x[2]), num: parseInt(x[2], 10) || 1, text: x[3] }); i++; continue; }
        if (L[i].trim() && /^\s+/.test(L[i]) && items.length) { items[items.length - 1].text += "\n" + L[i].trim(); i++; continue; }
        if (!L[i].trim() && i + 1 < L.length && MD_LIST.test(L[i + 1])) { i++; continue; }   // 列表项之间空一行也算一个列表
        break;
      }
      out.push(mdList(items, 0, items[0].ind)[0]);
      continue;
    }
    const buf = [];
    while (i < L.length && L[i].trim() && !MD_BLOCK.test(L[i]) && !(buf.length && MD_LIST.test(L[i]))) buf.push(L[i++]);
    if (!buf.length) buf.push(L[i++]);
    out.push(`<p>${buf.map(mdInline).join("<br>")}</p>`);
  }
  return out.join("");
}
function mdList(items, k, base) {
  const ord = items[k].ord;
  let h = ord ? `<ol${items[k].num > 1 ? ` start="${items[k].num}"` : ""}>` : "<ul>";
  while (k < items.length && items[k].ind >= base) {
    if (items[k].ind > base + 1 && h.endsWith("</li>")) {          // 缩进更深：挂在上一项下面
      const [sub, nk] = mdList(items, k, items[k].ind);
      h = h.slice(0, -5) + sub + "</li>";
      k = nk;
      continue;
    }
    h += `<li>${items[k].text.split("\n").map(mdInline).join("<br>")}</li>`;
    k++;
  }
  return [h + (ord ? "</ol>" : "</ul>"), k];
}

// ---------------------------------------------------------------- 连接
let ws = null, srv = 0, heard = false, lastRx = 0, pingSeq = 0, online = false, statusText = "";
let linkUp = false, linkStarted = false;

// 有原生 Link：连接交给它（断了自己重连、换地址、心跳，切到后台也连着）；没有就用网页的 WebSocket
function connect() {
  if (!cfg.token) { showLogin(); return; }
  if (Link) {
    if (linkStarted) return;
    linkStarted = true;
    status("正在连接");
    Link.start({ servers: cfg.servers.join(","), token: cfg.token, hello: JSON.stringify(helloMsg()) }).catch(e => { linkStarted = false; status(e.message || "原生模块出错"); });
    return;
  }
  if (ws) return;
  status("正在连接 " + hostName(host()));
  heard = false;
  const w = ws = new WebSocket(`ws://${host()}/ws?key=${encodeURIComponent(cfg.token)}`);
  const giveUp = setTimeout(() => { if (!heard) w.close(); }, 6000);
  w.onopen = () => w.send(JSON.stringify(helloMsg()));
  w.onmessage = e => { heard = true; lastRx = Date.now(); let m; try { m = JSON.parse(e.data); } catch (x) { return; } onMsg(m); };
  w.onclose = () => {
    clearTimeout(giveUp);
    if (ws !== w) return;
    ws = null;
    if (!heard) srv++;               // 连上了却一个字没回 / 连不上：换下一个地址（先北京中转再直连硅谷）
    onDown();
    if (document.visibilityState === "visible" && cfg.token) setTimeout(connect, heard ? 500 : 1500);
  };
}
// 朗读能收 p24 才报 spk:2：网页版自己解；原生壳只有 iOS 安装包 v5 起会（热更新的界面可能跑在老壳上，老壳收到 p24 就没声音）
function p24Ok() { return !Link || (PLATFORM === "ios" && window.SHELL_V >= 5); }
function helloMsg() { return { t: "hello", id: DEV_ID, token: cfg.token, spk: p24Ok() ? 2 : 1, app: 2, label: DEV_LABEL }; }
function disconnect() {                              // 退出登录 / 换服务器
  if (Link) { linkStarted = false; Link.stop().catch(() => {}); }
  if (ws) { const w = ws; ws = null; w.close(); }
  onDown();
}
function onDown() {
  setOnline(false);
  for (const [, p] of waiting) { clearTimeout(p.tm); p.rej(new Error("连接断了")); }
  waiting.clear();
  pttEnd(true);
  live = null;                       // 服务器那头的常开收音跟着连接没了；通话还算开着，连回来自动接上
  if (!Link) spStop(false);
  status("连接断开，正在重连");
}
function hostName(h) { return HOSTS[String(h).split(":")[0]] || h; }
function tx(o) {
  if (Link) {
    if (!linkUp) return false;
    Link.send({ s: JSON.stringify(o) }).catch(() => {});
    return true;
  }
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(o));
  return true;
}
setInterval(() => {
  if (Link || !ws || ws.readyState !== 1) return;   // 原生 Link 自己发心跳
  tx({ t: "ping", seq: ++pingSeq });
  if (Date.now() - lastRx > 15000) ws.close();      // 服务器每 5 秒发一个 ka，15 秒没动静 = 线路卡住了
}, 5000);
if (Link) {
  Link.addListener("msg", e => { let m; try { m = JSON.parse(e.s); } catch (x) { return; } onMsg(m); });
  Link.addListener("conn", e => {
    srvName = e.host || srvName;
    if (e.on) { linkUp = true; return; }             // 连上了，等服务器的 hello 再算在线
    if (linkUp || online) { linkUp = false; onDown(); }
    if (e.why) status(e.why);
  });
  Link.addListener("lv", e => { for (const v of e.v || []) { lvQ.push(v); if (ptt) ptt.got++; } if (lvQ.length > 40) lvQ.splice(0, lvQ.length - 40); });
  Link.addListener("sp", e => { nSpeak = !!e.on; xyUpd(); flUpd(); });
  Link.addListener("live", e => { if (!e.on && call.on) callEnd(e.why === "hang" ? "已挂断" : cname() + "已挂断"); });   // 小芽自己退 / 锁屏、通知上点了挂断
  Link.addListener("aec", e => { if (call.on && call.aec !== !!e.on) { call.aec = !!e.on; callCfg(); xyUpd(); } });   // 通话中插拔耳机：能不能边念边听变了
  Link.addListener("ctl", e => {                      // 锁屏 / 通知 / 灵动岛上点了关麦、关声音
    if (!call.on) return;
    call.muted = !!e.mute;
    soundOff = !!e.sound;
    xyUpd(); sndUpd();
  });
  Link.addListener("resume", e => {                  // 从后台回来：中间的推送没给网页，整页重拉；通话状态以原生为准
    nSpeak = !!e.sp;
    if (call.on && !e.live) callEnd();
    if (online) onConnected();
  });
}
let srvName = "";

// 切到后台：原生版开着「后台运行」就什么都不停（通话、朗读照常，系统通知报结果）；
// 网页版 WebView 会被挂起：录音、常开收音先停（通话还算开着），回到前台重连后接着听
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { connect(); if (online) liveStart(); return; }
  pttEnd(true);
  if (Link && bgOn) return;
  liveStop(0);
  closeMic();
});

let qSeq = 0;
const waiting = new Map();
function q(op, args) {
  return new Promise((res, rej) => {
    const id = ++qSeq;
    // id 是这次请求的流水号，放最后免得被参数盖掉（2026-10-15：xz_switch 带的对话编号也叫 id，回话对不上号，等 30 秒报「服务器没回应」）
    if (!tx(Object.assign({ t: "q", op }, args || {}, { id }))) return rej(new Error("还没连上服务器"));
    const tm = setTimeout(() => { waiting.delete(id); rej(new Error("服务器没回应")); }, 30000);
    waiting.set(id, { res, rej, tm });
  });
}

function onMsg(m) {
  switch (m.t) {
    case "hello":
      checkUi();
      avBoot();                                        // 小水母头像的大小表（连上才拿得到；拿不到就定时重试）
      if (m.login) { needLogin(""); break; }         // 拿旧的设备密钥连的（旧安装包带的）：服务器只让下载新界面
      if (m.user && m.user !== cfg.user) { cfg.user = m.user; saveCfg(); }
      srvCall = m.call || 0;                         // 服务器认不认「打给小智 / 说话打断」（老服务器没有这个字段，小智页就先不出电话按钮）
      { const pg = curPage(); if (pg && pg.key === "xz") chrome(pg); }
      setOnline(true); onConnected();
      break;
    case "auth": needLogin(m.err || "请重新登录"); break;
    case "nav": if (m.to && PAGES[m.to] && (!curPage() || curPage().key !== m.to)) { if (!$("#xy").hidden) xyMin(); if (Object.values(PAGE_OF).includes(m.to)) goSection(m.to); else go(m.to); } break;
    case "note": onNote(m); break;                   // 只发给这台的结果（App 在后台时原生模块弹系统通知）：前台就在悬浮球上报一声
    case "r": {
      const w = waiting.get(m.id);
      if (w) { waiting.delete(m.id); clearTimeout(w.tm); if (m.err) w.rej(new Error(m.err)); else w.res(m.d); }
      break;
    }
    case "ev": onEv(m); break;
    case "asr": onAsr(m); break;
    case "asr_err": onAsrErr(m); break;
    case "toast": serverToast(m.text); break;
    case "bye": status(m.why || "服务器要断开"); break;
    case "snd": beep(m.k); break;
    case "sp_start": spStart(m); break;
    case "sp": spData(m); break;
    case "rec_stop": if (call.on) callEnd("小芽已挂断"); break;   // 说了「退出小芽」/ 小芽自己退出
    case "sp_cut": spCut(); break;                   // 有人开口打断了：服务器让这台马上停念（缓冲里还没放的也不放）
    // cfg / ka / pong / ack / sp_mark / sp_end 不用管；view 是给遥控器的，v2 不收
  }
}
function setOnline(on) {
  online = on;
  document.body.classList.toggle("offline", !on);
  if (on) status("");
  updConn();
}
function status(s) { statusText = s; updConn(); }
function updConn() {
  const t = online ? "已连接 · " + hostName(host()) : statusText || "未连接";
  document.querySelectorAll(".conn-t").forEach(e => { e.textContent = t; });
}
function onConnected() {
  const pg = curPage();
  if (pg && pg.def.load) pg.def.load(pg);
  if (xyPage() && xyPage() !== pg) hxLoad();          // 小芽在栈里（不是当前页）：重连后也把对话补齐
  homeTiles();
  q("ar", { on: autoRead }).catch(() => {});
  quotaLoad();
  liveStart();
}

// 服务器广播的提示：遥控器专用的说法（按哪个键、说哪句唤醒词）在手机上没意义，去掉
function serverToast(t) {
  const lines = String(t || "").split("\n").filter(l => l.trim() && !/最左键|确认键|长按|主页「|说「|按键/.test(l));
  if (!lines.length) return;
  // 小芽的短话服务器也会弹成提示（给遥控器看的）：首页对话 / 通话字幕里已经有了，别再弹一遍
  if (hx.msgs && hx.msgs.slice(-4).some(x => x.r === "ai" && (x.text || "").trim() === String(t).trim())) return;
  // 「已换成…」「正在取日报…」这类状态是给遥控器屏幕看的，手机上界面自己会变；只把出了问题的说一声
  if (/失败|出错|没听|没回|取不到|没配|忙|做完一个|没在|没有|空的|再说一次|再试/.test(t)) hint(lines.join("\n"));
}

// ---------------------------------------------------------------- 界面热更新（壳在 boot.js）
// 连上服务器就问一次 /app/bundle：服务器 git 里提交的界面跟手机上跑的不一样就下载存起来，闲下来重新载入换上
let uiCheckedAt = 0, uiReload = false;
async function checkUi() {
  if (Date.now() - uiCheckedAt < 30000) return;
  uiCheckedAt = Date.now();
  try {
    const r = await fetch(`http://${host()}/app/bundle?key=${encodeURIComponent(cfg.token)}&have=${encodeURIComponent(window.UI_VER || "")}`, { cache: "no-store" });
    if (!r.ok) return;
    const b = await r.json();
    if (b.same || !b.v || !b.js || b.v === window.UI_VER || b.v === store("ui_bad")) return;
    store("ui_bundle", JSON.stringify(b));
    try { localStorage.removeItem("ui_booting"); } catch (e) { /* 没有存储 */ }
    uiReload = true;
  } catch (e) { /* 拉不到就用现在这版 */ }
}
setInterval(() => {
  if (!uiReload || ptt || pttHeld || call.on || speaking() || sheetKind || document.activeElement && document.activeElement.tagName === "TEXTAREA") return;
  uiReload = false;
  location.reload();
}, 500);
setInterval(avBoot, 4000);                             // 小水母大小表：没拉到就定时再试（function 在后面定义）

// ---------------------------------------------------------------- 出错提示：就地一行字，不弹框（2026-10-16 用户：除了小芽通话的悬浮球，App 里的弹窗都不要）
// 成功了不提示（界面自己会变）。出错时：开着弹层写在弹层标题下面（near 给了就写在它后面），小芽通话全屏时写在通话状态行，
// 否则写在底栏（输入栏）上面一行；几秒后自己消失
const hintEl = el('<div class="hint" role="status"></div>');
let hintTm = 0;
function hint(text, near) {
  text = String(text || "").trim();
  if (!text) return;
  if (call.on && call.ui === "full" && !$("#xy").hidden) { xyFlash(text.replace(/\n/g, " ")); return; }
  const head = sheetKind && $("#sheetBody .sh-head");
  if (near) near.after(hintEl);
  else if (head) head.after(hintEl);
  else if (sheetKind) $("#sheetBody").prepend(hintEl);
  else bar.prepend(hintEl);
  hintEl.textContent = text;
  hintEl.classList.add("on");
  barSize();
  clearTimeout(hintTm);
  hintTm = setTimeout(() => { hintEl.classList.remove("on"); hintEl.remove(); barSize(); }, 3500 + Math.min(4000, text.length * 80));
}
// 页面数据拉不到：还没有数据就把转圈换成「重试」；有旧数据就留着旧的，底下说一声
function loadErr(pg, e) {
  if (pg.data) { hint(e.message); return; }
  pg.el.innerHTML = `<div class="empty"><div class="e-ic">${ico("x")}</div><b>没加载出来</b><span>${esc(e.message)}</span><button class="btn" data-act="reload">重试</button></div>`;
}

// ---------------------------------------------------------------- 页面栈（全在本地）
const PAGES = {};
const stack = [];
const stage = $("#stage");
const curPage = () => stack[stack.length - 1];

function newPage(key, p) {
  const pg = { key, p: p || {}, def: PAGES[key], el: el(`<section class="page${PAGES[key].cls ? " " + PAGES[key].cls : ""}"></section>`), data: null, raw: [], stick: true };
  pg.el.addEventListener("scroll", () => {
    pg.stick = pg.el.scrollHeight - pg.el.scrollTop - pg.el.clientHeight < 80;
    if (pg === curPage()) onScroll();
  }, { passive: true });
  stage.appendChild(pg.el);
  return pg;
}
// 一级页（2026-10-27）：侧栏里的各项（小芽、日报、文件…）。栈底永远是 Claude；一级页之上才是它们的下一层。
// opt.sec = 这是一级页（返回键 / 边缘右滑 = 划出侧栏，不弹回 Claude）；opt.replace = 换掉当前的一级页，不叠在它上面
function go(key, p, opt) {
  closeDrawer(); closeSheet(); closePop();
  settle();
  const old = curPage(), pg = newPage(key, p);
  if (opt && opt.sec) pg.sec = true;
  stack.push(pg);
  draw(pg);
  chrome(pg);
  if (old) slide(old.el, pg.el, 1, 0, () => {
    if (opt && opt.replace && old !== stack[0]) { const i = stack.indexOf(old); if (i > 0) stack.splice(i, 1); old.el.remove(); }
    else old.el.classList.add("off");
  });
  if (pg.def.load) pg.def.load(pg);
  return pg;
}
// 侧栏点一项：栈收成 [Claude, 这一项]。点 Claude = 回栈底；点的就是当前这项 = 只收起侧栏
function goSection(key, p) {
  closeDrawer();
  const cur = curPage();
  if (key === "claude") {
    while (stack.length > 2) stack.splice(1, 1)[0].el.remove();
    if (stack.length === 2) popPage();
    return;
  }
  if (cur && cur.sec && cur.key === key && stack.length === 2) return;
  while (stack.length > 2) stack.splice(1, 1)[0].el.remove();
  go(key, p, { sec: true, replace: true });
}
// 返回：一级页上 = 划出侧栏（高亮当前这项），其余 = 回上一层
function back() {
  if (stack.length < 2) return false;
  const cur = curPage();
  if (cur.def.onBack && cur.def.onBack(cur)) return true;          // 页面自己先处理（浏览器：先收起标签总览 / 联想）
  if (cur.sec) {
    if (!dwOn) { hap("light"); openDrawer(); }
    return true;
  }
  return popPage();
}
function popPage() {
  if (stack.length < 2) return false;
  closeSheet(); closePop();
  settle();
  const old = stack.pop(), pg = curPage();
  if (old.pdf) old.pdf.destroy().catch(() => {});
  if (old.def.onLeave) old.def.onLeave(old);
  pg.el.classList.remove("off");
  chrome(pg);
  slide(old.el, pg.el, -1, 0, () => old.el.remove());
  if (pg.def.onShow) pg.def.onShow(pg);
  return true;
}
// 换页动画还没播完又换页：先把上一段直接做完再开始。不然后一段的动画会被前一段收尾时一起取消掉，
// 该删的页面删不掉、当前页反被藏起来（2026-10-15 测出来：刚滑进「历史会话」就点了一条，返回后那页一直盖在屏上）
let slideEnd = null;
function settle() { if (slideEnd) slideEnd(); }
function slide(oldEl, newEl, dir, from, done) {
  settle();
  const w = stage.clientWidth, a = from || 0;
  const upper = dir > 0 ? newEl : oldEl, lower = dir > 0 ? oldEl : newEl;
  upper.style.zIndex = 3; lower.style.zIndex = 1;
  upper.style.boxShadow = "0 0 40px rgba(0,0,0,.28)";
  const opt = { duration: 440 * (1 - a / w * .6), easing: EASE, fill: "forwards" };
  const fin = () => { [oldEl, newEl].forEach(e => { e.style.zIndex = ""; e.style.boxShadow = ""; e.style.transform = ""; e.style.opacity = ""; }); done && done(); };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { fin(); return; }
  let an;
  if (dir > 0) {
    an = newEl.animate([{ transform: `translateX(${w}px)` }, { transform: "translateX(0)" }], opt);
    oldEl.animate([{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${-w * .3}px)`, opacity: .4 }], opt);
  } else {
    an = oldEl.animate([{ transform: `translateX(${a}px)` }, { transform: `translateX(${w}px)` }], opt);
    const pr = a / w;
    newEl.animate([{ transform: `translateX(${-w * .3 * (1 - pr)}px)`, opacity: .4 + .6 * pr }, { transform: "translateX(0)", opacity: 1 }], opt);
  }
  const end = () => { slideEnd = null; oldEl.getAnimations().forEach(x => x.cancel()); newEl.getAnimations().forEach(x => x.cancel()); fin(); };
  slideEnd = end;
  an.onfinish = end;
}

// 画一页：整页重画，滚动位置照旧（对话页贴着底的话继续贴底）
function draw(pg) {
  pg.raw = [];
  const keep = pg.el.scrollTop, stick = pg.stick;
  const open = [...pg.el.querySelectorAll("details[open][data-k]")].map(d => d.dataset.k);
  pg.el.innerHTML = pg.def.html(pg);
  open.forEach(k => { const d = pg.el.querySelector(`details[data-k="${k}"]`); if (d) d.open = true; });
  if (pg.def.thread && stick) pg.el.scrollTop = pg.el.scrollHeight;
  else pg.el.scrollTop = keep;
  if (pg === curPage()) { chrome(pg); onScroll(); }
  updConn();
  tickTimers();
}
function chrome(pg) {
  const d = pg.def, b = document.body;
  b.dataset.ctx = d.ctx || "";
  b.classList.toggle("at-home", stack.length <= 1 || !!pg.sec);   // 一级页左上角是 ☰（划出侧栏），下一层才是 ←
  b.classList.toggle("solid", !!d.solid);
  $("#navTitle").textContent = d.title ? d.title(pg) : "";
  $("#navSub").innerHTML = d.sub ? d.sub(pg) : "";
  updConn();
  $("#navMid").dataset.act = d.midAct || "";
  if (!d.midAct) delete $("#navMid").dataset.act;
  $("#navRight").innerHTML = navRightHtml(pg);
  setBar(pg);
}
// 顶栏右边：在念（没在通话）时最前面多一个「停止」，原来的按钮（自动朗读开关等）都不动
function navRightHtml(pg) {
  const r = pg.def.right ? pg.def.right(pg) : "";
  if (!speaking() || call.on) return r;
  return `<button class="nav-spk" data-act="spstop" aria-label="停止朗读"><span class="eq"><i></i><i></i><i></i></span>停止</button>` + r;
}
function onScroll() {
  const pg = curPage();
  document.body.classList.toggle("scrolled", !!pg && pg.el.scrollTop > 36);
}
function stickBottom(pg) { if (pg && pg.stick) pg.el.scrollTop = pg.el.scrollHeight; }

// 底栏：输入栏 / 呼叫小芽 / 操作按钮
const bar = $("#bar");
function setBar(pg) {
  const kind = pg.def.bar || "";
  if (kind === "composer") {
    if (cmpMain.el.parentNode !== bar) { bar.innerHTML = ""; bar.appendChild(cmpMain.el); }
    cmpMain.setTo(pg.def.to);
  } else if (kind === "call") {
    bar.innerHTML = callBtnHtml();
  } else if (kind === "acts") {
    bar.innerHTML = `<div class="acts">${(pg.def.acts(pg) || []).map(a =>
      `<button class="act ${a.cls || ""}" data-act="${a.act}">${ico(a.icon)}<span>${esc(a.label)}</span></button>`).join("")}</div>`;
  } else bar.innerHTML = "";
  bar.dataset.kind = kind;
  barSize();
}
function barSize() { document.documentElement.style.setProperty("--bar-h", bar.offsetHeight + "px"); }
if (window.ResizeObserver) new ResizeObserver(() => { barSize(); stickBottom(curPage()); }).observe(bar);

// 键盘：iOS 弹键盘时网页本身不缩，按可见区域把整个界面（和小芽通话层）抬到键盘上面
function fitKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  const was = document.body.classList.contains("kb");
  document.documentElement.style.setProperty("--kb", kb + "px");
  document.body.classList.toggle("kb", kb > 60);
  if (window.scrollY || document.documentElement.scrollTop) window.scrollTo(0, 0);
  if (was !== kb > 60) setTimeout(() => stickBottom(curPage()), 60);
}
if (window.visualViewport) {
  visualViewport.addEventListener("resize", fitKeyboard);
  visualViewport.addEventListener("scroll", fitKeyboard);
}

// ---------------------------------------------------------------- 对话气泡（三家共用）
const WHO = {
  claude: { av: () => ico("claude"), name: "Claude" },
  xz: { av: () => ico("chat"), name: "小智" },
  xy: { av: () => LOGO, name: "小芽" },
  oc: { av: () => ico("spark"), name: "OpenCode" },
  ocb: { av: () => ico("spark"), name: "opencode—百度" },
};
function attHtml(files) {
  if (!files || !files.length) return "";
  const imgs = files.filter(f => f.kind === "image"), docs = files.filter(f => f.kind !== "image");
  return `<div class="att${imgs.length > 1 ? " many" : ""}">` +
    imgs.map(f => `<img src="${esc(f.url || fileUrl(f.id))}" loading="lazy" data-act="img" alt="">`).join("") +
    docs.map(f => `<button class="fcard" data-act="fopen:${esc(f.id)}" data-name="${esc(f.name)}" data-size="${f.size || 0}"><span class="f-ic">${ico("file")}</span><span><b>${esc(f.name)}</b><span>${fsize(f.size || 0)}</span></span></button>`).join("") + "</div>";
}
function msgHtml(pg, m, who, cont) {
  if (m.r === "me") {
    const i = pg.raw.push(m.text) - 1;
    return `<div class="m me">${attHtml(m.files)}${m.text ? `<div class="bub" data-i="${i}">${esc(m.text)}</div>` : ""}</div>`;
  }
  if (m.r === "err") return `<div class="m note err">${esc(m.text)}</div>`;
  const i = pg.raw.push(m.text) - 1;
  return `<div class="m ai${cont ? " cont" : ""}"><span class="av">${WHO[who].av()}</span><div class="bub md" data-i="${i}" data-who="${who}">${md(m.text)}</div></div>`;
}
function pendHtml(pg, p, who) {
  const body = p.st === "asr" ? '<span class="typing"><i></i><i></i><i></i></span>' : esc(p.text);
  return `<div class="m me pend">${attHtml(p.files)}${p.st === "asr" || p.text ? `<div class="bub">${body}</div>` : ""}</div>`;
}
function emptyHtml(icon, title, sub) {
  return `<div class="empty"><div class="e-ic">${ico(icon)}</div><b>${esc(title)}</b><span>${esc(sub)}</span></div>`;
}
const LOADING = '<div class="loading"><span class="spin"></span></div>';

// 发出去还没回到对话里的话（打的字、正在识别的语音）：先摆一个半透明气泡，服务器那边有了就去掉
const pends = { claude: [], xz: [], xy: [], oc: [], ocb: [] };
let pendSeq = 0;
function addPend(to, p) { p.k = ++pendSeq; p.t = Date.now(); pends[to].push(p); redrawThread(to); return p; }
function dropPend(to, k) { pends[to] = pends[to].filter(p => p.k !== k); redrawThread(to); }
function prunePends(to, msgs) {                     // 服务器的对话里已经有这句了：去掉对应的临时气泡
  const mine = msgs.filter(m => m.r === "me").slice(-8).map(m => (m.text || "").trim());
  pends[to] = pends[to].filter(p => p.st === "asr" || (!mine.includes((p.text || "").trim()) && Date.now() - p.t < 120000));
}
function redrawThread(to) {
  if (to === "xy") return hxRedraw(true);
  const pg = curPage();
  if (pg && pg.def.to === to) draw(pg);
}

// ---------------------------------------------------------------- 主页 = 小芽（方案 C，2026-10-15）
// 小芽就是 Hermes：对话直接读 Hermes 的会话（q hx/history），变化听 ev{w: "hx"}；Claude / 小智 / 日报在左边抽屉里（顶栏左上角按钮 / 左边缘右滑）。
// 打字发的回复只显示不念，按住说话的才念（服务器按 mode 分）。小芽通话（全屏 + 悬浮球）照旧，顶栏电话按钮进。
const hx = { sid: null, msgs: null, busy: false, err: "" };
async function hxLoad() {
  try {
    const d = await q("hx", { hop: "history", a: {} });
    Object.assign(hx, { sid: d.sid, msgs: d.msgs || [], busy: !!d.busy, err: "" });
    prunePends("xy", hx.msgs);
  } catch (e) { hx.err = e.message; }
  hxRedraw(true);
}
function xyPage() { return stack.find(p => p.key === "home") || null; }      // 小芽页（侧栏里的一级页）；不在栈里就是 null，对话数据留在 hx 里
function hxRedraw(stick) {
  const pg = xyPage();
  if (!pg) return;
  if (stick) pg.stick = true;
  if (pg === curPage()) draw(pg); else pg.dirty = true;
}
function onHxEv(m) {
  if (call.on && call.to === "xy" && (m.k === "me" || m.k === "ai" || m.k === "ask")) {     // 通话字幕
    call.cap = m.k === "me" ? { me: m.text } : { me: call.cap.me, ai: m.k === "ask" ? (m.show || m.text) : m.text };
    capUpd();
  }
  const L = hx.msgs;
  if (!L) return;
  if (m.k === "me") { L.push({ r: "me", text: m.text, files: m.files }); prunePends("xy", [{ r: "me", text: m.text }]); hxRedraw(true); return; }
  if (m.k === "cron") { L.push({ r: "cron", name: m.name, text: m.text, t: Date.now() / 1000 }); hxRedraw(true); return; }
  if (m.k === "ai") L.push({ r: "ai", text: m.text });
  else if (m.k === "ask") { L.forEach(x => { if (x.r === "ask") x.live = false; }); L.push({ r: "ask", text: m.show || m.text, live: true }); }
  else if (m.k === "file") L.push({ r: "file", f: m.f, name: m.name, path: m.path, caption: m.caption });
  else if (m.k === "busy") {
    hx.busy = !!m.on;
    if (!m.on) L.forEach(x => { if (x.r === "ask" && x.live) { x.live = false; x.done = x.done || "已处理"; } });
  } else if (m.k === "tool") {
    const t = m.id && [...L].reverse().find(x => x.r === "tool" && x.id === m.id);
    if (m.ph === "start") { if (!t) L.push({ r: "tool", id: m.id, name: m.name, args: m.args, run: true }); }
    else if (t) Object.assign(t, { res: m.r, ok: m.ok, run: false });
    else L.push({ r: "tool", id: m.id, name: m.name, res: m.r, ok: m.ok });
  }
  hxRedraw();
}
const HX_TOOL = {
  terminal: ["term", "运行命令"], process_manage: ["term", "管理进程"], execute_code: ["term", "跑脚本"], esp_python: ["term", "设备服务里跑 Python"],
  read_file: ["file", "读文件"], write_file: ["pencil", "写文件"], patch: ["pencil", "改文件"], search_files: ["search", "找文件"],
  memory: ["book", "记忆"], session_search: ["search", "翻聊天记录"], skills_list: ["layers", "看技能"], skill_view: ["layers", "看技能"], skill_manage: ["layers", "改技能"],
  cronjob_manage: ["clock", "定时任务"], todo_list: ["list", "待办"], delegate_task: ["spark", "派子任务"],
  doubao_search: ["globe", "联网搜索"], stock_quote: ["gauge", "查行情"], get_status: ["gauge", "查状态"], open_news: ["news", "打开日报"], resume_news: ["news", "接着听日报"],
  set_volume: ["speak", "调音量"], stop_speaking: ["speakOff", "停止朗读"], go_home: ["home", "回主页"], ask_claude: ["claude", "交给 Claude"],
  show_claude_reply: ["claude", "看 Claude 回复"], exit_assistant: ["phone", "退出小芽"],
};
function toolArg(args) {                              // 工具卡片标题上带一点参数：命令 / 文件 / 搜什么…
  let a = args;
  try { a = typeof args === "string" ? JSON.parse(args) : args; } catch (e) { return String(args || "").replace(/^\{"\w+":\s*"?/, "").slice(0, 60); }
  if (!a || typeof a !== "object") return "";
  if (a.file_path || a.filePath) return String(a.file_path || a.filePath).split("/").pop();
  const v = a.command || a.pattern || a.path || a.query || a.url || a.stock || a.task || a.skill || a.name || a.code || a.content || a.prompt || a.description || a.action || "";
  return String(v).split("\n")[0].slice(0, 60);
}
function prettyArgs(args) { try { return JSON.stringify(typeof args === "string" ? JSON.parse(args) : args, null, 1); } catch (e) { return String(args || ""); } }
function toolPath(args) {                            // 写 / 改 / 读文件这类工具的目标路径（绝对路径才算）
  let a = args;
  try { a = typeof args === "string" ? JSON.parse(args) : args; } catch (e) { return ""; }
  const v = a && typeof a === "object" ? a.file_path || a.filePath || a.path : "";
  return typeof v === "string" && /^(~\/|\/)/.test(v) ? pathAbs(v) : "";
}
function toolHtml(m, names, run, k) {
  const [ic, verb] = names[m.name] || ["spark", m.name || "工具"];
  const arg = m.args ? toolArg(m.args) : "";
  const tp = m.args ? toolPath(m.args) : "";
  const cut = !run && m.res === null;                 // Claude 的卡片：没在跑也没有结果 = 中途被停了（小芽的卡片 res 是空串，不算）
  const mark = run ? '<span class="spin xs"></span>' : m.ok === false ? `<span class="t-bad">${ico("x")}</span>` : cut ? '<span class="t-cut">没做完</span>' : "";
  return `<details class="m tool${run ? " run" : ""}"${k != null ? ` data-k="t${k}"` : ""}><summary>${ico(ic)}<span>${esc(verb)}${arg ? " · " + esc(arg) : ""}</span>${mark}</summary>` +
    (tp ? `<div class="t-file">${pathTag("span", tp, esc(tp))}</div>` : "") +
    (m.args && m.args !== "{}" ? `<pre>${esc(prettyArgs(m.args))}</pre>` : "") + (m.res ? `<pre class="res${m.ok === false ? " bad" : ""}">${esc(m.res)}</pre>` : "") +
    (cut ? '<div class="t-cutnote">中途停了，没有结果</div>' : "") + "</details>";
}
function hxToolHtml(m, k) { return toolHtml(m, HX_TOOL, m.run, k); }
function thinkHtml(m, k) {                           // 思考过程：默认收着，标题带第一句
  return `<details class="m think" data-k="k${k}"><summary>${ico("spark")}<b>思考</b><span>${esc(String(m.text).split("\n")[0].slice(0, 60))}</span></summary>` +
    `<div class="think-t">${esc(m.text)}</div></details>`;
}
function hxAskHtml(m) {
  const body = String(m.text || "").replace(/\n?说「确认」或「取消」\s*$/, "");
  return `<div class="m ask"><div class="ask-b"><div class="ask-h">${ico("term")}<b>小芽要执行一条有风险的命令</b></div><pre>${esc(body)}</pre>` +
    (m.live ? '<div class="ask-acts"><button class="btn" data-act="hxok:deny">取消</button><button class="btn danger" data-act="hxok:once">确认执行</button></div>'
      : `<div class="ask-done">${esc(m.done || "已处理")}</div>`) + "</div></div>";
}
function hxFileHtml(m, i) {
  const inner = m.f ? attHtml([m.f]) : `<button class="fcard" data-act="hxf:${i}"><span class="f-ic">${ico("file")}</span><span><b>${esc(m.name || "文件")}</b><span>点开取回</span></span></button>`;
  return `<div class="m ai"><span class="av">${LOGO}</span><div class="bub file-b">${inner}${m.caption ? `<div class="cap">${esc(m.caption)}</div>` : ""}</div></div>`;
}
// 定时任务送到的提醒（2026-10-15）：Hermes 写回对话（cron.mirror_delivery），实时送到时服务器推 ev{w: hx, k: cron}
function hxCronHtml(m) {
  const t = m.t ? new Date(m.t * 1000) : null;
  const hm = t ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` : "";
  return `<div class="m cronc"><div class="cron-b"><div class="cron-h">${ico("clock")}<b>${esc(m.name || "定时提醒")}</b><span>${esc(hm)}</span></div>` +
    (m.text ? `<div class="cron-t">${esc(m.text)}</div>` : "") + "</div></div>";
}
function hxItemHtml(pg, m, i, cont) {
  if (m.r === "me") {
    const files = (m.files || []).filter(f => f.id), lost = (m.files || []).filter(f => !f.id);
    return msgHtml(pg, { r: "me", text: m.text, files }, "xy") + lost.map((f, k) => hxFileHtml({ name: f.name, path: f.path }, i + ":" + k)).join("");
  }
  if (m.r === "ai") return msgHtml(pg, m, "xy", cont);
  if (m.r === "tool") return hxToolHtml(m, i);
  if (m.r === "ask") return hxAskHtml(m);
  if (m.r === "file") return hxFileHtml(m, i);
  if (m.r === "cron") return hxCronHtml(m);
  return "";
}
// 左边抽屉（2026-10-15，用户：入口原来在对话上面一排，往下翻就被淹没了）：Claude 在忙 / 有新回复时左上角按钮带个点
// 2026-10-27 起栈底是 Claude，小芽是侧栏第一项；当前所在的一级页高亮（返回键划出侧栏时一眼看到自己在哪）
let tiles = null;                                    // op home 的数据：Claude 忙不忙、日报几条（侧栏和左上角的点用）
function secKey() { const s = stack.find(p => p.sec); return s ? s.key : "claude"; }
function drawerHtml(d) {
  const c = (d && d.claude) || {}, busy = c.busy > 0, at = secKey();
  const row = (k, ic, name, sub, dot, to) => `<button class="row${(to || PAGE_OF[k]) === at ? " on" : ""}" style="--c:var(--${k});--cs:var(--${k}-soft)" data-act="dwgo:${to || PAGE_OF[k]}">` +
    `<span class="r-ic">${ico(ic)}</span><span class="r-main"><span class="r-t">${name}</span><span class="r-s">${esc(sub)}</span></span>` +
    `${dot ? '<span class="dot"></span>' : ""}<span class="chev">${ico("chev")}</span></button>`;
  return `<div class="dw-head"><b>小芽</b><span class="conn-t"></span></div><div class="group">` +
    row("xy", "spark", "小芽", "你的管家 · 说话办事") +
    row("claude", "claude", "Claude", busy ? (c.busy > 1 ? `${c.busy} 个会话在忙` : "正在工作") : c.unread ? "有新回复" : "待命", busy || c.unread) +
    row("oc", "spark", "OpenCode", "免费模型") + row("oc", "spark", "opencode—百度", "百度云 · 免费模型", false, "ocb") +
    row("xz", "chat", "小智", "AI 对话") + row("news", "news", "日报", d && d.news && d.news.n ? `今天 ${d.news.n} 条` : "今日要闻") +
    row("plg", "plug", "插座", "BroadLink · 家里") + row("fs", "folder", "文件", "硅谷服务器 · 只读") + row("sys", "layers", "系统", "运营看板 · 工具") +
    (IAB && !BR.broken ? row("br", "globe", "浏览器", "地址栏 · 标签页 · 书签") : "") + "</div>";
}
let dwOn = false;
function drawerUpd() {
  const d = tiles, c = (d && d.claude) || {};
  $("#navMenu").classList.toggle("dot", c.busy > 0 || !!c.unread);
  if (dwOn) { $("#dwPanel").innerHTML = drawerHtml(d); updConn(); }
}
function openDrawer() {
  if (dwOn) return;
  dwOn = true;
  $("#dwPanel").innerHTML = drawerHtml(tiles);
  updConn();
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  $("#drawer").classList.add("on");
}
function closeDrawer() {
  if (!dwOn) return;
  dwOn = false;
  $("#drawer").classList.remove("on");
}
PAGES.home = {
  ctx: "xy", bar: "composer", to: "xy", solid: true, thread: true,
  title: () => "小芽",
  sub: () => '<span class="conn-t"></span>',
  right: () => arBtnHtml() + `<button class="nav-btn${call.on && call.to === "xy" ? " on" : ""}" data-act="call:xy" aria-label="小芽通话">${ico("phone")}</button>` +
    `<button class="nav-btn" data-act="xymenu" aria-label="更多">${ico("more")}</button>`,
  async load() { await hxLoad(); },
  html(pg) {
    const L = hx.msgs;
    let body;
    if (!L) body = hx.err ? emptyHtml("spark", "连不上小芽", hx.err) : LOADING;
    else if (!L.length && !pends.xy.length && !hx.busy) body = emptyHtml("spark", "跟小芽说说话", "打字或按住说话都行。她是你的管家：查东西、动手办事、定时提醒、记住你的习惯；要她把回复念出来，点右上角的喇叭");
    else body = `<div class="thread">${threadHtml(L.slice(-160), (m, k, cont) => hxItemHtml(pg, m, L.length - Math.min(160, L.length) + k, cont))}` +
      pends.xy.map(p => pendHtml(pg, p)).join("") +
      (hx.busy ? `<div class="m ai"><span class="av">${LOGO}</span><div class="bub"><span class="typing"><i></i><i></i><i></i></span></div></div>` : "") + "</div>";
    return body;
  },
};
async function homeTiles() {
  try { tiles = await q("home"); if (!tiles.claude.busy) { cBusy.clear(); bgSync(); } } catch (e) { /* 没连上：先空着 */ }
  drawerUpd();
}
const PAGE_OF = { xy: "home", claude: "claude", xz: "xz", news: "news", oc: "oc", plg: "plug", fs: "files", sys: "systems", br: "browser" };
function arBtnHtml() {
  return `<button class="nav-btn ar${autoRead ? " lit" : ""}" data-act="artog" aria-label="自动朗读" aria-pressed="${autoRead}">${ico(autoRead ? "speak" : "speakOff")}</button>`;
}
function setAutoRead(on) {                           // 首页 / 小智右上角的喇叭、通话页的「声音」、设置里的开关都是它
  autoRead = on;
  store("autoRead", on ? "1" : "0");
  q("ar", { on }).catch(() => {});
  if (!on && speaking()) spStop(true);
  const pg = curPage();
  if (pg && (pg.key === "home" || pg.key === "xz")) chrome(pg);
  const t = document.querySelector('.sw-row[data-act="artog"] .sw');
  if (t) t.classList.toggle("on", on);
  sndUpd(); xyUpd();
}
function callBtnHtml() {
  if (call.on) return `<button class="callbtn on" data-act="call:${call.to}">${call.to === "xz" ? '<span class="orb sprout xz"><i></i></span>' : LOGO}<span class="cb-t"><b>${cname()}通话中</b><em class="call-t">${mmss(Date.now() - call.t0)} · 点这里回到通话</em></span><span class="cb-ic">${ico("phone")}</span></button>`;
  return `<button class="callbtn" data-act="call:xy">${LOGO}<span class="cb-t"><b>呼叫小芽</b><em>你的语音助手，说话就行</em></span><span class="cb-ic">${ico("phone")}</span></button>`;
}
function openXyMenu() {
  openSheet("xymenu", `<div class="sh-head"><b>小芽</b><span>你的个人管家（Hermes）</span></div><div class="group">` +
    [["hxnew", "compose", "新话题", "开一段新对话，之前的还在历史里"],
     ["xymodels", "spark", "模型", "谁来说话：DeepSeek、通义，或 OpenCode 的免费档"],
     ["xygo:xysess", "layers", "历史对话", "翻看、搜索以前的对话，还能接着聊"],
     ["xygo:xymem", "book", "记忆", "小芽记住的关于你的事、她自己的笔记"],
     ["xygo:xyskills", "spark", "技能", "她会的现成本事，可以单个关掉"],
     ["xygo:xycron", "clock", "定时任务", "到点她自己去办的事"],
     ["settings", "sliders", "连接与设置", "服务器地址、后台运行、通知、账号"]]
      .map(([a, ic, t, sub]) => `<button class="row" data-act="${a}"><span class="r-ic">${ico(ic)}</span><span class="r-main"><span class="r-t">${t}</span><span class="r-s">${sub}</span></span><span class="chev">${ico("chev")}</span></button>`).join("") + "</div>");
}

// 小芽的模型单（2026-10-17）：ds / qwen 原路进，OpenCode 那批免费档走 ocbridge 桥；/model 只切会话，config 默认不动
async function openXyModels() {
  openSheet("model", `<div class="sh-head"><b>小芽的模型</b><span>换谁来说话，切完直接生效；想用回谁就回来点谁</span></div><div id="mdlBox">${LOADING}</div>`);
  quotaLoad();
  try {
    const [d, oc] = await Promise.all([hxq("brain"), q("o_models")]);
    const cur = d.provider === "ocbridge" ? "ocbridge/" + (d.model || "") : d.provider === "alibaba" ? "qwen-plus" : "deepseek-flash";
    const row = (k, t, sub) => `<button class="row${k === cur ? " cur" : ""}" data-act="xypick:${k}"><span class="r-main"><span class="r-t">${esc(t)}</span>${sub ? `<span class="r-s">${esc(sub)}</span>` : ""}</span>${k === cur ? `<span class="check">${ico("check")}</span>` : ""}</button>`;
    $("#mdlBox").innerHTML = `<div class="sh-sec">DeepSeek</div>${qLine("deepseek")}<div class="group">` +
      row("deepseek-flash", "DeepSeek", "原来那条路") + `</div><div class="sh-sec">通义</div>${qLine("qwen")}<div class="group">` +
      row("qwen-plus", "通义千问", "阿里的备用") +
      `</div><div class="sh-sec">思考</div><div class="group">` +
      `<button class="row${d.thinking ? " cur" : ""}" data-act="xythink:1"><span class="r-ic">${ico("spark")}</span><span class="r-main"><span class="r-t">开</span><span class="r-s">先想一遍再答，更聪明也慢些</span></span>${d.thinking ? `<span class="check">${ico("check")}</span>` : ""}</button>` +
      `<button class="row${!d.thinking ? " cur" : ""}" data-act="xythink:0"><span class="r-ic">${ico("clock")}</span><span class="r-main"><span class="r-t">关</span><span class="r-s">直接答，快</span></span>${!d.thinking ? `<span class="check">${ico("check")}</span>` : ""}</button>` +
      `</div><div class="sh-sec">OpenCode · 全免费</div>${qLine("oc")}<div class="group">` +
      (oc.list || []).map(([k, v]) => row("ocbridge/" + k, v, "免费，走 opencode 桥")).join("") + `</div>`;
  } catch (e) { $("#mdlBox").textContent = e.message; }
}

// ---------------------------------------------------------------- 小芽的管理页：记忆 / 技能 / 定时任务 / 历史对话（都走 hx，在 Hermes 那边直接读写）
const hxq = (op, a) => q("hx", { hop: op, a: a || {} });
const xyHead = (title, sub) => `<header class="hero"><div class="over">小芽</div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</header>`;
function isoT(iso) {                                  // 定时任务的时间（ISO）→「10月15日 08:00」
  const t = iso ? new Date(iso) : null;
  if (!t || isNaN(t)) return "";
  return `${t.getMonth() + 1}月${t.getDate()}日 ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}
PAGES.xymem = {
  ctx: "xy", title: () => "记忆",
  async load(pg) { try { pg.data = await hxq("memory"); draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    const d = pg.data, head = xyHead("记忆", "每段新对话开头小芽都会带上这些；她聊着聊着自己也会记，你也可以直接改");
    if (!d) return head + LOADING;
    const sec = (t, title, sub) => {
      const m = d[t], pct = Math.min(100, Math.round(m.used / Math.max(1, m.limit) * 100));
      return `<div class="sh-sec">${title}<span class="cnt">${m.used} / ${m.limit} 字</span></div><div class="use"><i style="width:${pct}%"></i></div><div class="group">` +
        m.entries.map((e, k) => `<button class="row" data-act="memed:${t}:${k}"><span class="r-main"><span class="r-t mem-t">${esc(e)}</span></span><span class="chev">${ico("chev")}</span></button>`).join("") +
        `<button class="row add-row" data-act="memed:${t}:new"><span class="r-ic">${ico("plus")}</span><span class="r-main"><span class="r-t">添加一条</span><span class="r-s">${sub}</span></span></button></div>`;
    };
    return head + sec("user", "对你的了解", "称呼、偏好、习惯、家里有什么设备…") + sec("memory", "小芽的笔记", "环境、约定、踩过的坑");
  },
};
let memCtx = null;
function openMemEdit(t, k) {
  const pg = curPage(), old = k === "new" ? "" : pg.data[t].entries[+k];
  memCtx = { t, old, pg };
  openSheet("mem", `<div class="sh-head"><b>${k === "new" ? "添加一条" : "改这条"}</b><span>${t === "user" ? "对你的了解" : "小芽的笔记"}</span></div>
    <div class="field"><textarea id="memText" class="plain" rows="4" placeholder="一条一件事，写清楚，比如：喜欢别人叫他王老师"></textarea></div>
    <div class="btn-row">${old ? '<button class="btn" data-act="memdel">删除</button>' : ""}<button class="btn primary" data-act="memsave">保存</button></div>`);
  $("#memText").value = old;
  setTimeout(() => $("#memText").focus(), 60);
}
PAGES.xyskills = {
  ctx: "xy", title: () => "技能",
  async load(pg) { try { pg.data = await hxq("skills"); draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    const head = xyHead("技能", "做某类事的现成步骤，小芽遇到对口的事会自己翻出来用；关掉的她就不用了（下一段新对话起生效）");
    if (!pg.data) return head + LOADING;
    const groups = {};
    pg.data.skills.forEach(k => (groups[k.cat || "其他"] = groups[k.cat || "其他"] || []).push(k));
    return head + Object.entries(groups).map(([cat, list]) => `<div class="sh-sec">${esc(cat)}</div><div class="group">` + list.map(k =>
      `<div class="row sk-row"><button class="r-main" data-act="skview:${esc(k.name)}"><span class="r-t">${esc(k.name)}</span><span class="r-s sk-d">${esc(k.desc)}</span></button>` +
      `<button class="sw${k.on ? " on" : ""}" data-act="sktog:${esc(k.name)}" aria-label="开关"><i></i></button></div>`).join("") + "</div>").join("");
  },
};
// 技能文件（SKILL.md）开头是 YAML 元数据（---name / description …---）：拆出说明放在标题下，正文开头跟标题重复的一级标题也去掉
function skillDoc(src) {
  let body = String(src || ""), desc = "";
  const fm = body.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  if (fm) {
    body = body.slice(fm[0].length);
    const d = fm[1].match(/^description:\s*(.*)$/m);
    desc = d ? d[1].trim().replace(/^(["'])(.*)\1$/, "$2") : "";
  }
  return { desc, body: body.replace(/^\s*#\s+[^\n]*\n/, "") };
}
PAGES.xyskill = {
  ctx: "xy", title: pg => pg.p.name,
  async load(pg) { try { pg.data = await hxq("skill_view", { name: pg.p.name }); draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    if (!pg.data) return LOADING;
    const doc = skillDoc(pg.data.content);
    return `<header class="hero"><div class="over">技能</div><h1>${esc(pg.data.name)}</h1>${doc.desc ? `<div class="sub">${esc(doc.desc)}</div>` : ""}</header>` +
      `<article class="article"><div class="bub md sk-md">${md(doc.body)}</div></article>`;
  },
};
function cronZh(x) {                                 // Hermes 的定时规则是英文：常见几种翻成中文，认不出的照原样
  const t = String(x || "").trim();
  const hm = s => { const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i); if (!m) return s; let h = +m[1]; if (/pm/i.test(m[3] || "") && h < 12) h += 12; if (/am/i.test(m[3] || "") && h === 12) h = 0; return `${String(h).padStart(2, "0")}:${m[2] || "00"}`; };
  const unit = { m: "分钟", min: "分钟", minute: "分钟", minutes: "分钟", h: "小时", hour: "小时", hours: "小时", d: "天", day: "天", days: "天" };
  let m;
  if ((m = t.match(/^every day at (.+)$/i))) return "每天 " + hm(m[1]);
  if ((m = t.match(/^every weekday at (.+)$/i))) return "工作日每天 " + hm(m[1]);
  if ((m = t.match(/^every (\d+)\s*([a-z]+)$/i)) && unit[m[2].toLowerCase()]) return `每 ${m[1]} ${unit[m[2].toLowerCase()]}`;
  if ((m = t.match(/^once in (\d+)\s*([a-z]+)$/i)) && unit[m[2].toLowerCase()]) return `${m[1]} ${unit[m[2].toLowerCase()]}后一次`;
  if ((m = t.match(/^once at (.+)$/i))) return "一次 · " + (isoT(m[1]) || m[1]);
  return t;
}
const CRON_ST = { scheduled: "等着到点", active: "等着到点", paused: "已暂停", completed: "已完成", running: "正在跑", error: "出错了", failed: "出错了" };
PAGES.xycron = {
  ctx: "xy", title: () => "定时任务",
  async load(pg) {
    try {
      const [d, log] = await Promise.all([hxq("cron"), q("cron_log").catch(() => [])]);
      pg.data = Object.assign(d, { log });
      draw(pg);
    } catch (e) { loadErr(pg, e); }
  },
  html(pg) {
    const head = xyHead("定时任务", "到点小芽去办，手机上会弹系统通知（App 在后台、被关掉也会弹），内容也会留在小芽的对话里。要新建直接跟她说，比如「每天早上 8 点提醒我吃药」");
    if (!pg.data) return head + LOADING;
    const log = pg.data.log || [];
    const jobs = pg.data.jobs.length ? `<div class="group">${pg.data.jobs.map((j, k) => `<button class="row" data-act="cronopen:${k}"><span class="r-ic">${ico("clock")}</span><span class="r-main">
      <span class="r-t">${esc(j.name || j.prompt || j.id)}</span><span class="r-s"><span class="tag${j.state === "paused" || j.state === "completed" ? " gray" : ""}">${esc(CRON_ST[j.state] || j.state || "")}</span>${esc(cronZh(j.schedule))}` +
      `${j.next ? " · 下次 " + esc(isoT(j.next)) : ""}</span>${j.last ? `<span class="r-s cron-last">${cronLastHtml(j)}</span>` : ""}</span><span class="chev">${ico("chev")}</span></button>`).join("")}</div>`
      : emptyHtml("clock", "还没有定时任务", "跟小芽说「明天下午三点提醒我开会」试试");
    return head + jobs + (log.length ? `<div class="sh-sec">最近送到的提醒</div><div class="group">${log.slice(0, 30).map(cronLogHtml).join("")}</div>` : "");
  },
};
function cronLastHtml(j, bare) {                      // 上次跑的结果：成功 / 失败原因 / 送没送出去（失败的另起一行标红）
  const at = (bare ? "" : "上次 ") + esc(isoT(j.last));
  if (j.last_status === "error") return `${at}<br><span class="t-bad">没成：${esc(String(j.last_error || "").slice(0, 60))}</span>`;
  if (j.last_delivery_error) return `${at}<br><span class="t-bad">没送出去：${esc(String(j.last_delivery_error).slice(0, 60))}</span>`;
  return `${at} · 已执行`;
}
function cronTo(r) {                                  // 发到了哪：实时送到的设备 + 手机提前预约的系统通知
  const parts = [];
  if (r.to && r.to.length) parts.push("实时送到 " + r.to.join("、"));
  if (r.alarm) parts.push("iPhone 已提前预约系统通知");
  return parts.length ? parts.join(" · ") : "当时没有设备在线，没送到（内容在小芽的对话里）";
}
function cronLogHtml(r) {
  return `<div class="row"><span class="r-ic">${ico("clock")}</span><span class="r-main"><span class="r-t">${esc(r.name || "定时提醒")}</span>` +
    `<span class="r-s">${esc(isoT(new Date(r.t * 1000).toISOString()))}</span>${r.text ? `<span class="r-s cron-said">${esc(r.text)}</span>` : ""}` +
    `<span class="r-s${r.to && r.to.length || r.alarm ? "" : " t-bad"}">${esc(cronTo(r))}</span></span></div>`;
}
function openCron(k) {
  const pg = curPage(), j = pg.data.jobs[+k];
  if (!j) return;
  openSheet("cron", `<div class="sh-head"><b>${esc(j.name || "定时任务")}</b><span>${esc(cronZh(j.schedule))}${j.next ? " · 下次 " + esc(isoT(j.next)) : ""}</span></div>` +
    (j.last ? `<div class="sh-sec">上次执行</div><div class="cron-p">${cronLastHtml(j, true)}</div>` : "") +
    ((pg.data.log || []).some(r => r.job === j.id) ? `<div class="sh-sec">送到的记录</div><div class="group">${pg.data.log.filter(r => r.job === j.id).slice(0, 5).map(cronLogHtml).join("")}</div>` : "") +
    (j.prompt ? `<div class="sh-sec">到点做什么</div><div class="cron-p">${esc(j.prompt)}</div>` : "") +
    `<div class="btn-row"><button class="btn" data-act="cron:run:${esc(j.id)}">马上跑一次</button>` +
    `<button class="btn" data-act="cron:${j.state === "paused" ? "resume" : "pause"}:${esc(j.id)}">${j.state === "paused" ? "恢复" : "暂停"}</button></div>` +
    `<button class="btn danger wide" data-act="cron:remove:${esc(j.id)}">删除</button>`);
}
PAGES.xysess = {
  ctx: "xy", title: () => "历史对话",
  async load(pg) { try { pg.data = await hxq("sessions", { q: pg.p.q || "" }); draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    const head = xyHead("历史对话") + `<div class="search">${ico("search")}<input id="sessQ" placeholder="搜对话里说过的话" enterkeyhint="search" value="${esc(pg.p.q || "")}"></div>`;
    if (!pg.data) return head + LOADING;
    const rows = pg.data.sessions.filter(r => r.n || r.cur);
    if (!rows.length) return head + emptyHtml("layers", pg.p.q ? "没搜到" : "还没有对话", pg.p.q ? "换个说法试试" : "跟小芽说句话就有了");
    return head + `<div class="group">${rows.map(r => `<button class="row${r.cur ? " cur" : ""}" data-act="sessopen:${esc(r.sid)}"><span class="r-main">
      <span class="r-t">${esc(r.title || r.snip || "（新对话）")}</span><span class="r-s">${r.cur ? '<span class="tag gray">当前</span>' : ""}${r.t ? reltime(r.t) : ""}${r.n ? ` · ${r.n} 条` : ""}</span>
      ${pg.p.q && r.snip ? `<span class="r-s snip">${esc(r.snip)}</span>` : ""}</span><span class="chev">${ico("chev")}</span></button>`).join("")}</div>`;
  },
};
PAGES.xysessView = {
  ctx: "xy", thread: true, bar: "acts", solid: true, title: pg => pg.p.title || "历史对话",
  acts: pg => pg.p.cur ? [] : [{ label: "继续这段对话", icon: "repeat", cls: "primary", act: "sessresume:" + pg.p.sid }],
  async load(pg) { try { pg.data = (await hxq("history", { sid: pg.p.sid, limit: 400 })).msgs; pg.stick = true; draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    if (!pg.data) return LOADING;
    const items = pg.data.map(m => m.r === "file" ? { r: "ai", text: "（文件：" + (m.name || "") + "）" } : m.r === "me" ? { r: "me", text: m.text } : m);
    return items.length ? `<div class="thread">${threadHtml(items, (m, k, cont) => m.r === "tool" ? hxToolHtml(m, k) : m.r === "cron" ? hxCronHtml(m) : msgHtml(pg, m, "xy", cont))}</div>` : emptyHtml("layers", "这段对话是空的", "");
  },
};

// ---------------------------------------------------------------- Claude
const TOOL = { Bash: ["term", "运行"], Read: ["file", "读取"], Write: ["pencil", "写入"], Edit: ["pencil", "修改"], MultiEdit: ["pencil", "修改"],
  NotebookEdit: ["pencil", "修改"], Grep: ["search", "搜索"], Glob: ["search", "找文件"], ToolSearch: ["search", "找工具"],
  WebFetch: ["globe", "打开网页"], WebSearch: ["globe", "联网搜索"], Task: ["spark", "派子任务"], Agent: ["spark", "派子任务"],
  TodoWrite: ["list", "更新待办"], Skill: ["spark", "用技能"],
  bash: ["term", "运行"], read: ["file", "读取"], write: ["pencil", "写入"], edit: ["pencil", "修改"], multiedit: ["pencil", "修改"],
  glob: ["search", "找文件"], grep: ["search", "搜索"], list: ["search", "列表"], webfetch: ["globe", "打开网页"], task: ["spark", "派子任务"] };
// 一段对话画出来：同一轮里 AI 的第二个起的文字气泡不带头像（cont），中间夹着工具卡片、思考也算同一轮
function threadHtml(items, one) {
  let seen = false;
  return items.map((m, k) => {
    if (m.r === "me") seen = false;
    const cont = m.r === "ai" && seen;
    if (m.r === "ai" || m.r === "file") seen = true;
    return one(m, k, cont);
  }).join("");
}
// Claude 干活时底下一条：正在做哪一步、用了多久、中断（每一步的卡片在上面的对话里）
function lastMe(items) { for (let k = items.length - 1; k >= 0; k--) if (items[k].r === "me") return k; return -1; }
function workHtml(b, items) {
  const run = items.slice(lastMe(items) + 1).reverse().find(m => m.r === "tool" && m.res == null);   // 只看这一轮（以前中断的那轮可能留着没结果的卡片）
  const verb = run ? (TOOL[run.name] || ["", run.name])[1] : "思考";
  const arg = run && run.args ? toolArg(run.args) : "";
  return `<div class="m work" id="cWork"><div class="wk-h">${PIX}<span class="wk-t">正在${esc(verb)}${arg ? `<em> · ${esc(arg)}</em>` : ""}</span>` +
    `<span class="timer" data-t0="${b.t0}"></span><button class="wk-stop" data-act="cstop">${ico("stop")}<span>中断</span></button></div></div>`;
}
function cItemHtml(pg, m, k, cont, busy) {
  if (m.r === "tool") return toolHtml(m, TOOL, busy && m.res == null, k);
  if (m.r === "think") return thinkHtml(m, k);
  if (m.r === "more") return `<button class="m note more" data-act="cmore">显示更早的消息（还有 ${m.at} 条）</button>`;
  return msgHtml(pg, m, "claude", cont);
}
PAGES.claude = {
  ctx: "claude", bar: "composer", to: "claude", solid: true, thread: true, midAct: "cmodel",
  title: pg => pg.data ? pg.data.title : "Claude",
  sub: pg => pg.data ? `<span class="mpick">${esc(pg.data.model)}${ico("down")}</span>${qLiteHtml(/^deepseek/i.test(pg.data.model) ? "deepseek" : "claude")}` : "",
  right: () => `<button class="nav-btn" data-act="go:csess" aria-label="历史会话">${ico("layers")}</button><button class="nav-btn" data-act="cnew" aria-label="新建会话">${ico("compose")}</button>`,
  async load(pg) {
    try {
      const d = await q("c_thread");
      if (!cKeepOlder(pg.data, d)) pg.stick = true;                  // 往前翻着看的时候重拉（做完、重连）：别跳到底
      pg.data = d; prunePends("claude", d.msgs); draw(pg);
    } catch (e) { loadErr(pg, e); }
  },
  html(pg) {
    const d = pg.data;
    if (!d) return LOADING;
    if (!d.msgs.length && !pends.claude.length && !d.busy) return emptyHtml("claude", "跟 Claude 说点什么", "打字、按住说话都行，也能发图片和文件；它在服务器上动手干活，做完把结果发回来");
    const cur = d.busy ? lastMe(d.msgs) : Infinity;                   // 正在跑的这一轮：没结果的卡片转圈
    const base = cAt(d) - (d.msgs[0] && d.msgs[0].r === "more" ? 1 : 0);   // 卡片展开状态按会话里的序号记，往前翻出更早的也不串
    return `<div class="thread">${threadHtml(d.msgs, (m, k, cont) => cItemHtml(pg, m, base + k, cont, k > cur))}${pends.claude.map(p => pendHtml(pg, p)).join("")}` +
      `${d.busy ? workHtml(d.busy, d.msgs) : ""}</div>`;
  },
};
function claudePage() { return stack.find(p => p.key === "claude"); }
// 会话很长时服务器只给最后一页，最前面一条是 {r: more, at}：at = 这页第一条在整个会话里的序号（前面还有几条）
const cAt = d => d.msgs[0] && d.msgs[0].r === "more" ? d.msgs[0].at : 0;
// 重拉同一个会话时，把已经往前翻出来的那些接回去；接了就返回 true（n = 那次会话里一共几条，后面接着的是还没写进记录的，序号对不上）
function cKeepOlder(old, d) {
  if (!old || old.sid !== d.sid || cAt(old) >= cAt(d) || cAt(d) > old.n) return false;
  const lead = old.msgs[0].r === "more" ? 1 : 0;
  d.msgs.splice(0, 1, ...old.msgs.slice(0, lead + cAt(d) - cAt(old)));
  return true;
}
// 推过来的新条目并进对话：工具按 id、文字按内容去重（刚整页拉过的会话记录里可能已经有了）；结果按 id 配到卡片上
function cMerge(d, m) {
  const L = d.msgs;
  let changed = false;
  for (const it of m.add || []) {
    const dup = it.r === "tool" ? L.some(x => x.r === "tool" && x.id === it.id) : L.slice(-8).some(x => x.r === it.r && x.text === it.text);
    if (!dup) { L.push(it); changed = true; }
  }
  for (const r of m.res || []) {
    const t = L.find(x => x.r === "tool" && x.id === r.id);
    if (t) { t.res = r.res; t.ok = r.ok; changed = true; }
  }
  return changed;
}
function onClaudeEv(m) {
  if (m.add || m.res) {                                                // 干活的每一步（思考、工具调用、结果、中间说的话）：接到对话后面；首页不用跟着刷
    const pg = claudePage();
    if (pg && pg.data && m.sid === pg.data.sid && cMerge(pg.data, m) && pg.data.busy) draw(pg);
    return;
  }
  if (m.busy) cBusy.add(m.sid); else if (m.done) { cBusy.delete(m.sid); quotaLoad(true); }      // Claude 收工：额度马上重取
  bgSync();
  const pg = claudePage();
  if (pg && pg.data && m.sid === pg.data.sid) {
    if (m.done || m.q != null || (m.busy && !pg.data.busy)) pg.def.load(pg);        // 开始干活 / 做完 / 排上了追加的：整页重拉
    else if (m.busy) pg.data.busy = m.busy;
  }
  homeDirty();
}

PAGES.csess = {
  ctx: "claude", title: () => "历史会话",
  async load(pg) { try { pg.data = await q("c_sessions"); draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    const rows = pg.data;
    const head = `<header class="hero"><div class="over">Claude</div><h1>历史会话</h1></header>
      <button class="new-btn" data-act="cnew:back">${ico("compose")}<span>新建会话</span></button>`;
    if (!rows) return head + LOADING;
    if (!rows.length) return head + emptyHtml("layers", "还没有会话", "发一句话就会开一个新会话");
    return head + `<div class="group">${rows.map(r => {
      const tags = (r.busy ? '<span class="tag"><span class="spin xs"></span>进行中</span>' : r.unread ? '<span class="tag">新回复</span>' : "") +
        (r.cur ? '<span class="tag gray">当前</span>' : "");
      return `<button class="row${r.cur ? " cur" : ""}" data-act="csw:${r.sid}"><span class="r-main"><span class="r-t">${esc(r.title)}</span>
        <span class="r-s">${tags}${reltime(r.t)}${r.model !== "Claude" ? " · " + esc(r.model) : ""}</span></span>
        <span class="${r.cur ? "check" : "chev"}">${ico(r.cur ? "check" : "chev")}</span></button>`;
    }).join("")}</div>`;
  },
};

// ---------------------------------------------------------------- 更新记录：这个软件每次更新的 git 提交 + 现在的版本 + 怎么更新（2026-10-19）
PAGES.uplog = {
  title: () => "更新记录",
  async load(pg) { try { pg.data = await q("uplog"); draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    const d = pg.data;
    const head = `<header class="hero"><div class="over">EspLink</div><h1>更新记录</h1>${d ? `<div class="sub">服务器代码 ${esc(d.head)} · 界面 ${esc(window.UI_VER || "开发版")}（${esc(window.UI_FROM || "内置")}）· 安装包 v${window.SHELL_V || 1}${Link ? "" : "（没有原生模块）"}</div>` : ""}</header>`;
    if (!d) return head + LOADING;
    if (!d.log.length) return head + emptyHtml("layers", "看不到提交记录", "服务器上没有 git 历史");
    return head + `<div class="meta" style="margin-top:0">界面是连上服务器自动热更新的（提交了才下发）；要装新安装包（改了原生部分）时，苹果在 SideStore 软件源里刷新、安卓用电脑 adb 装；服务器和固件的更新是助手改完代码重启 / OTA 下发。下面的每条就是这个软件的一次更新：</div>
      <div class="group">${d.log.map(r => `<div class="row"><span class="r-main"><span class="r-t">${esc(r.s)}</span><span class="r-s">${esc(r.t)} · ${esc(r.h)}</span></span></div>`).join("")}</div>`;
  },
};

// ---------------------------------------------------------------- OpenCode（2026-10-17：免费的 opencode 模型，和 Claude 平级）
// 两台引擎：oc = 本机；ocb = 百度云那台（2026-10-26 经 ocb 桥，侧边栏单独一项）。界面共用，数据走不同的前缀。
const OC_VAR_ZH = { none: "关", minimal: "极简", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };
const OC = {
  oc: { key: "oc", p: "o", sess: "ocsess", who: "oc", name: "OpenCode", over: "OpenCode",
        tip: "全免费（挂在 opencode 网关上）；换型号接着这个会话聊，不用新开" },
  ocb: { key: "ocb", p: "ob", sess: "ocbsess", who: "ocb", name: "opencode—百度", over: "opencode—百度",
         tip: "免费模型，跑在百度云那台服务器上；换型号接着这个会话聊，不用新开" },
};
const oBusy = new Set();                             // 正在干活的 OpenCode 会话（引擎:会话号）
function ocPage(k) { return stack.find(p => p.key === k); }
function ocHost() {                                  // 当前是哪个引擎（在历史会话页点时栈里还压着它下面那页）
  for (let i = stack.length - 1; i >= 0; i--) if (OC[stack[i].key]) return OC[stack[i].key];
  return OC.oc;
}
function oItemHtml(pg, m, k, cont, busy, who) {
  if (m.r === "tool") return toolHtml(m, TOOL, busy && m.res == null, k);
  if (m.r === "think") return thinkHtml(m, k);
  if (m.r === "more") return `<button class="m note more" data-act="omore">显示更早的消息（还有 ${m.at} 条）</button>`;
  return msgHtml(pg, m, who, cont);
}
function onOcEv(k, m) {
  if (m.add || m.res) {                                // 干活的每一步（思考、工具、结果）：接到对话后面
    const pg = ocPage(k);
    if (pg && pg.data && (!m.sid || !pg.data.sid || m.sid === pg.data.sid) && cMerge(pg.data, m) && pg.data.busy) draw(pg);
    return;
  }
  if (m.busy) oBusy.add(k + ":" + m.sid); else if (m.done) oBusy.delete(k + ":" + m.sid);
  const pg = ocPage(k);
  if (pg && pg.data && (!pg.data.sid || m.sid === pg.data.sid)) {
    if (m.sid) pg.data.sid = m.sid;                    // 新会话：事件里带着真正的会话号
    if (m.done || m.q != null || (m.busy && !pg.data.busy)) pg.def.load(pg);   // 开始 / 做完 / 排上了追加的：整页重拉
    else if (m.busy) pg.data.busy = m.busy;
  }
}
function makeOcPage(k) {
  const E = OC[k];
  return {
    ctx: "oc", bar: "composer", to: k, solid: true, thread: true, midAct: "ocmodel",
    title: pg => pg.data ? pg.data.title : E.name,
    sub: pg => pg.data ? `<span class="mpick">${esc(pg.data.model)}${pg.data.variant ? esc(" · " + (OC_VAR_ZH[pg.data.variant] || pg.data.variant)) : ""}${ico("down")}</span>${k === "oc" ? qLiteHtml("oc") : ""}` : "",
    right: () => `<button class="nav-btn" data-act="go:${E.sess}" aria-label="历史会话">${ico("layers")}</button><button class="nav-btn" data-act="onew" aria-label="新建会话">${ico("compose")}</button>`,
    async load(pg) {
      try {
        const d = await q(E.p + "_thread");
        if (!ocKeep(pg.data, d)) pg.stick = true;                // 往前翻着看的时候重拉：别跳到底
        pg.data = d; prunePends(k, d.msgs); draw(pg);
      } catch (e) { loadErr(pg, e); }
    },
    html(pg) {
      const d = pg.data;
      if (!d) return LOADING;
      if (!d.msgs.length && !pends[k].length && !d.busy) {
        return k === "ocb"
          ? emptyHtml("spark", "跟百度上的 OpenCode 聊点什么", "跑在百度云那台服务器上，免费模型；打字、按住说话都行")
          : emptyHtml("spark", "跟 OpenCode 聊点什么", "免费的模型：Claude 额度、DeepSeek 余额用完时在这里顶上；打字、按住说话都行");
      }
      const cur = d.busy ? lastMe(d.msgs) : Infinity;
      const base = cAt(d) - (d.msgs[0] && d.msgs[0].r === "more" ? 1 : 0);
      const work = b => {
        const run = d.msgs.slice(lastMe(d.msgs) + 1).reverse().find(mm => mm.r === "tool" && mm.res == null);
        const verb = run ? (TOOL[run.name] || ["", run.name])[1] : "思考";
        const arg = run && run.args ? toolArg(run.args) : "";
        return `<div class="m work" id="oWork"><div class="wk-h">${PIX}<span class="wk-t">正在${esc(verb)}${arg ? `<em> · ${esc(arg)}</em>` : ""}</span>` +
          `<span class="timer" data-t0="${b.t0}"></span><button class="wk-stop" data-act="ostop">${ico("stop")}<span>中断</span></button></div></div>`;
      };
      return `<div class="thread">${threadHtml(d.msgs, (m, kk, cont) => oItemHtml(pg, m, base + kk, cont, kk > cur, E.who))}${pends[k].map(p => pendHtml(pg, p)).join("")}${d.busy ? work(d.busy) : ""}</div>`;
    },
  };
}
PAGES.oc = makeOcPage("oc");
PAGES.ocb = makeOcPage("ocb");
function ocKeep(old, d) {                            // 同 cKeepOlder：接回已经往前翻出来的那些
  if (!old || old.sid !== d.sid || cAt(old) >= cAt(d) || cAt(d) > old.n) return false;
  const lead = old.msgs[0].r === "more" ? 1 : 0;
  d.msgs.splice(0, 1, ...old.msgs.slice(0, lead + cAt(d) - cAt(old)));
  return true;
}
function makeOcSessions(k) {
  const E = OC[k];
  return {
    ctx: "oc", title: () => "历史会话",
    async load(pg) { try { pg.data = await q(E.p + "_sessions"); draw(pg); } catch (e) { loadErr(pg, e); } },
    html(pg) {
      const rows = pg.data;
      const head = `<header class="hero"><div class="over">${esc(E.over)}</div><h1>历史会话</h1></header>
        <button class="new-btn" data-act="onew:back">${ico("compose")}<span>新建会话</span></button>`;
      if (!rows) return head + LOADING;
      if (!rows.length) return head + emptyHtml("layers", "还没有会话", "发一句话就会开一个新会话");
      return head + `<div class="group">${rows.map(r => {
        const tags = (r.busy ? '<span class="tag"><span class="spin xs"></span>进行中</span>' : r.unread ? '<span class="tag">新回复</span>' : "") +
          (r.cur ? '<span class="tag gray">当前</span>' : "");
        return `<button class="row${r.cur ? " cur" : ""}" data-act="osw:${r.sid}"><span class="r-main"><span class="r-t">${esc(r.title)}</span>
          <span class="r-s">${tags}${reltime(r.t)}${r.model ? " · " + esc(r.model) : ""}</span></span>
          <span class="${r.cur ? "check" : "chev"}">${ico(r.cur ? "check" : "chev")}</span></button>`;
      }).join("")}</div>`;
    },
  };
}
PAGES.ocsess = makeOcSessions("oc");
PAGES.ocbsess = makeOcSessions("ocb");
async function openOcModels() {
  const E = ocHost();
  openSheet("model", `<div class="sh-head"><b>${esc(E.name)} 的设置</b><span>${esc(E.tip)}</span></div><div id="mdlBox">${LOADING}</div>`);
  quotaLoad();
  try {
    const d = await q(E.p + "_models");
    const pick = (act, cur, ic, t, sub) => `<button class="row${cur ? " cur" : ""}" data-act="${act}"><span class="r-ic">${ico(ic)}</span><span class="r-main"><span class="r-t">${esc(t)}</span>${sub ? `<span class="r-s">${esc(sub)}</span>` : ""}</span>${cur ? `<span class="check">${ico("check")}</span>` : ""}</button>`;
    let html = `<div class="sh-sec">模型 · 免费</div>${qLine(E.key)}<div class="group">` + d.list.map(([k, v]) => {
      const cur = d.cur === k;
      return `<button class="row${cur ? " cur" : ""}" data-act="ocmodelpick:${k}"><span class="r-main"><span class="r-t">${esc(v)}</span></span>${cur ? `<span class="check">${ico("check")}</span>` : ""}</button>`;
    }).join("") + `</div>`;
    if (d.variants && d.variants.length) {
      html += `<div class="sh-sec">速率</div><div class="group">` +
        pick("ocvariant:default", !d.variant, "clock", "默认", "模型自己定") +
        d.variants.map(v => pick("ocvariant:" + v, d.variant === v, "spark", OC_VAR_ZH[v] || v, "")).join("") + `</div>`;
    }
    html += `<div class="sh-sec">思考过程</div><div class="group">` +
      pick("octhink:1", d.thinking, "spark", "显示", "模型的思考过程也画在对话里") +
      pick("octhink:0", !d.thinking, "clock", "不显示", "只看回答，界面干净") + `</div>`;
    $("#mdlBox").innerHTML = html;
  } catch (e) { $("#mdlBox").textContent = e.message; }
}

// ---------------------------------------------------------------- 小智
PAGES.xz = {
  ctx: "xz", bar: "composer", to: "xz", solid: true, thread: true,
  title: pg => pg.data && pg.data.msgs.length ? pg.data.title : "小智",
  sub: () => "AI 对话" + (quotaD && quotaD.today ? `<span class="qlite"> · 豆包今天 ${quotaD.today.xz || 0} 次</span>` : ""),
  right: () => arBtnHtml() + (srvCall >= 2 ? `<button class="nav-btn${call.on && call.to === "xz" ? " on" : ""}" data-act="call:xz" aria-label="小智通话">${ico("phone")}</button>` : "") + `<button class="nav-btn" data-act="go:xzconv" aria-label="历史对话">${ico("layers")}</button><button class="nav-btn" data-act="xznew" aria-label="新对话">${ico("compose")}</button>`,
  async load(pg) {
    try { pg.data = await q("xz_thread"); prunePends("xz", pg.data.msgs); pg.stick = true; draw(pg); } catch (e) { loadErr(pg, e); }
  },
  html(pg) {
    const d = pg.data;
    if (!d) return LOADING;
    if (!d.msgs.length && !pends.xz.length && d.live == null) return emptyHtml("chat", "和小智聊聊", "私人秘书兼百科助手，也能看你发的图片和文件；要她边想边念给你听，点右上角的喇叭");
    return `<div class="thread">${d.msgs.map(m => msgHtml(pg, m, "xz")).join("")}${pends.xz.map(p => pendHtml(pg, p)).join("")}${d.live != null ? liveHtml(d.live) : ""}</div>`;
  },
};
function liveHtml(t) {
  return `<div class="m ai" id="xzLive"><span class="av">${ico("chat")}</span><div class="bub md">${t ? md(t) : '<span class="typing"><i></i><i></i><i></i></span>'}</div></div>`;
}
function onXzEv(m) {
  if (call.on && call.to === "xz") {                  // 打给小智的通话：字幕（你说的一句 + 她答的）和「在想」状态
    const me = (call.cap || {}).me;
    if (m.me) { call.cap = { me: m.me }; xyThink = true; }
    else if (m.live) { call.cap = { me, ai: m.live }; xyThink = false; }
    if (m.done != null) { if (m.done) call.cap = { me, ai: m.done }; xyThink = false; }
    if (m.me || m.live || m.done != null) { capUpd(); xyUpd(); }
  }
  const pg = stack.find(p => p.key === "xz");
  if (pg && pg.data) {
    if (m.sync) pg.def.load(pg);
    else if (m.live != null) {
      pg.data.live = m.live;
      const w = pg.el.querySelector("#xzLive");
      if (w && pg === curPage()) { w.replaceWith(el(liveHtml(m.live))); stickBottom(pg); } else draw(pg);
    }
  }
  homeDirty();
}
PAGES.xzconv = {
  ctx: "xz", title: () => "历史对话",
  async load(pg) { try { pg.data = await q("xz_convs"); draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    const head = `<header class="hero"><div class="over">小智</div><h1>历史对话</h1></header>
      <button class="new-btn" data-act="xznew:back">${ico("compose")}<span>新对话</span></button>`;
    if (!pg.data) return head + LOADING;
    return head + `<div class="group">${pg.data.map(c => `<button class="row${c.cur ? " cur" : ""}" data-act="xzsw:${c.id}"><span class="r-main">
      <span class="r-t">${esc(c.n ? c.title : "（空对话）")}</span><span class="r-s">${c.cur ? '<span class="tag gray">当前</span>' : ""}${reltime(c.t)} · ${Math.ceil(c.n / 2)} 轮</span></span>
      <span class="${c.cur ? "check" : "chev"}">${ico(c.cur ? "check" : "chev")}</span></button>`).join("")}</div>`;
  },
};

// ---------------------------------------------------------------- AI 日报
PAGES.news = {
  ctx: "news", title: () => "AI 日报",
  async load(pg) { try { pg.data = await q("news"); draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    const d = pg.data;
    const date = d && d.date ? `${+d.date.slice(5, 7)}月${+d.date.slice(8, 10)}日` : "";
    const head = `<header class="hero"><div class="over">${date}</div><h1>AI 日报</h1>${d ? `<div class="sub">${d.items.length} 条</div>` : ""}</header>`;
    if (!d) return head + LOADING;
    return head + `<button class="play-all" data-act="nplay:0"><span class="pa-ic">${ico("play")}</span><span><b>播放全部</b><span>从第一条连续念</span></span></button>` +
      (d.last ? `<button class="play-all" style="background:var(--elev);color:var(--text);box-shadow:var(--shadow)" data-act="nresume"><span class="pa-ic" style="background:var(--cs);color:var(--c)">${ico("repeat")}</span><span><b>接着听</b><span>上次听到第 ${d.last} 条</span></span></button>` : "") +
      `<div class="group">${d.items.map(([sec, t], k) => `<button class="row news-row${d.last === k + 1 ? " last" : ""}" data-act="nitem:${k}"><span class="num">${k + 1}</span>
        <span class="r-main"><span class="r-t">${esc(t)}</span><span class="r-s">${esc(sec)}</span></span><span class="chev">${ico("chev")}</span></button>`).join("")}</div>`;
  },
};
PAGES.newsItem = {
  ctx: "news", bar: "acts", title: pg => pg.data ? `第 ${pg.p.k + 1} 条` : "日报",
  acts: pg => [{ label: "从这条连播", icon: "play", cls: "primary", act: "nplay:" + pg.p.k }, { label: "只念这条", icon: "speak", act: "nsay:" + pg.p.k }],
  async load(pg) { try { pg.data = await q("news_item", { k: pg.p.k }); draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    const d = pg.data;
    if (!d) return LOADING;
    return `<header class="hero"><div class="over">${esc(d.sec)} · ${pg.p.k + 1}</div></header><article class="article"><h1>${esc(d.title)}</h1>
      <div class="prose">${esc(d.d || "")}</div>${d.src ? `<div class="source">${ico("link")}${esc(d.src)}</div>` : ""}</article>`;
  },
};

// BroadLink 智能插座（2026-10-20）：顶上是状态 + 大开关，下面是资料。
// 开 / 关 / 查状态走服务器 op plug——走博联云端（只靠服务器，不要电脑、不要遥控器：它们都会关机）；办不了就在卡片里写一行原因（不弹提示）。
// 定时：跟小芽说「每天 8 点开插座」，她建的任务在「定时任务」页里，到点同样走服务器；这页先只做开关。
const PLUG_DOC =
  "**「Wi-Fi智能插座1」** · BroadLink SP mini 3（devtype 0x7583）\n" +
  "家里 IP 192.168.0.101（UDP 80）・MAC 78:0F:77:E7:F0:83\n\n" +
  "### 怎么控制\n" +
  "插座只认家里局域网，服务器（硅谷）够不着；电脑和遥控器又会关机。所以走**博联云端**：服务器用一个专用账号调官方云接口，" +
  "跟手机 App 在外面控制它是一回事。**只靠服务器**，电脑、遥控器关不关机都不影响。\n\n" +
  "### 说明\n" +
  "- 开、关、状态都是实时问插座，经博联云，一般 1~3 秒。\n" +
  "- 这个专用账号是你在「我 → 邀请成员」里邀请进「我的家」的成员；想收回权限，去「家庭管理」把它移出去，服务器就控制不了了。\n" +
  "- 登录凭证过期会自动重登。\n\n" +
  "### 资料\n" +
  "- 局域网版协议和脚本：服务器上另存了一份（要在家里 Wi-Fi 里的机器上跑，只作参考）\n" +
  "- 云端接口逆向资料：服务器上另存了一份\n\n" +
  "### 小芽\n" +
  "跟小芽说「插座开着吗」「关掉插座」，用的是同一条云端通路。\n";
function plugCard(pg) {
  const d = pg.data;
  if (pg.err && !pg.busy) {                                // 电脑没开 / 插座没应答：就地写一行，留着旧状态
    return `<div class="plug-card"><div class="plug-st"><b>${esc(pg.err)}</b>${d ? `<span>上次看到：${d.pwr ? "开着" : "关着"}</span>` : ""}</div>` +
      `<button class="btn" data-act="plugre">重试</button></div>`;
  }
  if (!d) return `<div class="plug-card"><div class="loading"><span class="spin"></span></div><div class="plug-st"><span>正在问插座…</span></div></div>`;
  const on = !!d.pwr;
  return `<div class="plug-card"><button class="plug-btn${on ? " on" : ""}${pg.busy ? " busy" : ""}" data-act="plugtog" aria-label="${on ? "关掉插座" : "打开插座"}">${pg.busy ? '<span class="spin"></span>' : ico("power")}</button>` +
    `<div class="plug-st"><b>${on ? "已打开" : "已关闭"}</b><span>${pg.busy ? "正在办…" : on ? "点一下关掉" : "点一下打开"}</span></div></div>`;
}
async function plugRun(pg, act) {
  if (pg.busy) return;
  pg.busy = true; draw(pg);
  try { pg.data = await q("plug", { act }); pg.err = ""; }
  catch (e) { pg.err = e.message; }
  pg.busy = false; draw(pg);
}
PAGES.plug = {
  ctx: "plg", title: () => "插座",
  load(pg) { pg.stick = false; return plugRun(pg, "state"); },   // 页面默认贴底（对话页要）：这页从上往下读，不然一进来就被滚到资料最底下

  html(pg) { return `<header class="hero"><div class="over">物联网 DIY</div><h1>Wi-Fi智能插座1</h1><div class="sub">BroadLink SP mini 3 · 走博联云端</div></header>` +
    plugCard(pg) + `<article class="article"><div class="bub md sk-md">${md(PLUG_DOC)}</div></article>`; },
};

// ---------------------------------------------------------------- 文件页（2026-10-26）：看硅谷服务器整盘的文件，只读
// 后端是开源的 dufs，服务器 /app/fs 带令牌转发（只放行 GET / HEAD，/proc /sys /dev 不让进）。列表、内容、下载都是 HTTP 直接取，不走 WebSocket；
// 线路跟别的页一样看 host()（北京中转优先；以后撤了北京只改 cfg.servers）。出错一律就地一行字，不弹框。
// 目录大小：dufs 给的目录 size 是条目数；字节数另走 /app/fsdu（du 一次量出这一层所有项，根目录第一次约半分钟，服务器缓存 5 分钟）。
// 预览：文本 / Markdown / 图片；PDF、压缩包、Office、音视频、二进制不预览，交给系统（window.open，跟聊天里的文件一样）。
const FS_START = "/root", FS_TEXT_MAX = 256 << 10, FS_IMG_MAX = 20 << 20, FS_LIST_MAX = 2000;
const FS_IMG = new Set("jpg jpeg png gif webp bmp svg ico avif heic heif".split(" "));
const FS_AUD = new Set("mp3 m4a aac wav flac ogg oga opus weba".split(" "));
const FS_VID = new Set("mp4 m4v mov webm mkv avi flv wmv 3gp".split(" "));
const FS_DOC = new Set("doc docx dot dotx ppt pptx pot potx odt odp rtf wps dps".split(" "));     // 服务器上 LibreOffice 转成 PDF 再看
const FS_SHEET = new Set("xlsx xlsm xlsb xls ods et csv tsv".split(" "));                          // 表格
const FS_ZIP = new Set("zip jar apk ipa".split(" "));                                              // 只列目录
const FS_TEXT = new Set(("txt log md markdown json jsonl ndjson js mjs cjs ts tsx jsx py sh bash zsh yml yaml toml ini conf cfg env css scss xml sql " +
  "java c h cc cpp hpp go rs swift kt kts rb php lua r pl service timer socket mount rst tex srt vtt properties gradle bat ps1 diff patch lock plist " +
  "gitignore gitattributes dockerignore editorconfig npmrc").split(" "));
const FS_BIN = new Set(("gz tgz bz2 xz 7z rar tar zst iso dmg so o a dylib dll exe bin dat db sqlite sqlite3 pyc class wasm ttf otf woff woff2 " +
  "psd onnx pt pth npy npz safetensors gguf").split(" "));
// 代码高亮用的语言名（highlight.js 常用集里有的才会真高亮，没有的素着）
const HL_LANG = { py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", json: "json", jsonl: "json",
  sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", conf: "ini", cfg: "ini", service: "ini", timer: "ini", css: "css", scss: "scss",
  xml: "xml", svg: "xml", plist: "xml", html: "xml", htm: "xml", sql: "sql", java: "java", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", go: "go", rs: "rust",
  swift: "swift", kt: "kotlin", kts: "kotlin", rb: "ruby", php: "php", lua: "lua", r: "r", pl: "perl", diff: "diff", patch: "diff" };
let fsSort = "name";                                     // name | size | time
const fsPath = pg => pg.p.path || (pg.p.path = FS_START);
const fsName = p => p === "/" ? "/" : p.slice(p.lastIndexOf("/") + 1);
const fsDir = p => p.slice(0, p.lastIndexOf("/")) || "/";
const fsJoin = (d, n) => (d === "/" ? "" : d) + "/" + n;
const fsUrl = (p, extra) => `http://${host()}/app/fs${p.split("/").map(encodeURIComponent).join("/")}?${extra ? extra + "&" : ""}key=${encodeURIComponent(cfg.token)}`;
function fsTime(ms) {
  if (!ms) return "";
  const d = new Date(ms), p = v => String(v).padStart(2, "0"), day = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}年${day}` : `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const fsExt = n => n.includes(".") ? n.slice(n.lastIndexOf(".") + 1).toLowerCase() : "";
function fsKind(name) {
  const e = fsExt(name);
  return FS_IMG.has(e) ? "image" : e === "pdf" ? "pdf" : e === "md" || e === "markdown" ? "md" : e === "json" ? "json" : e === "html" || e === "htm" || e === "xhtml" ? "html"
    : FS_AUD.has(e) ? "audio" : FS_VID.has(e) ? "video" : FS_DOC.has(e) ? "office" : FS_SHEET.has(e) ? "sheet" : FS_ZIP.has(e) ? "zip"
    : FS_BIN.has(e) ? "bin" : FS_TEXT.has(e) ? "text" : "probe";   // probe：没见过的后缀 / 没后缀，取开头看像不像文字
}
// 取一段字节，最多读 cap 就掐断：服务器没按 Range 给、或文件长大了，也不会把整个大文件拉进手机内存
async function fsGet(url, init, cap, ms) {
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms || 45000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal, cache: "no-store" }, init));
    if (!r.ok) {
      let m = "";
      try { m = (await r.json()).error || ""; } catch (e) { /* 不是 JSON */ }
      throw new Error(m === "key" ? "登录已失效，到设置里重新登录" : m || (r.status === 404 ? "没有这个文件了" : `出错了（${r.status}）`));
    }
    const rd = r.body.getReader(), parts = [];
    let n = 0;
    while (n < cap) { const { done, value } = await rd.read(); if (done) break; parts.push(value); n += value.length; }
    rd.cancel().catch(() => {});
    const bytes = new Uint8Array(Math.min(n, cap));
    let at = 0;
    for (const x of parts) { const k = Math.min(x.length, bytes.length - at); bytes.set(x.subarray(0, k), at); at += k; }
    return { bytes, status: r.status };
  } catch (e) {
    if (e.name === "AbortError") throw new Error("服务器没回应");
    if (e instanceof TypeError) throw new Error("连不上 " + hostName(host()));
    throw e;
  } finally { clearTimeout(tm); }
}
const fsJson = async (url, ms) => JSON.parse(new TextDecoder().decode((await fsGet(url, null, 8 << 20, ms)).bytes));
function fsDecode(bytes) {                                                 // UTF-8；不是的话试 GBK（国内的 csv / txt 常见），解不出来返回 null
  if (bytes.subarray(0, 8000).includes(0)) return null;                    // 有 NUL：二进制
  const s = new TextDecoder("utf-8").decode(bytes);
  if ((s.match(/�/g) || []).length <= s.length * 0.02) return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  try {
    const g = new TextDecoder("gb18030").decode(bytes);
    if ((g.match(/[\x00-\x08\x0e-\x1f�]/g) || []).length <= g.length * 0.005) return g;
  } catch (e) { /* 没有这个编码 */ }
  return null;
}
function fsText(bytes, cut) {
  const s = fsDecode(bytes);
  return s == null ? null : cut ? s.slice(s.indexOf("\n") + 1) : s;       // 从文件中间读的，第一行是半截，丢掉
}
function fsSorted(pg) {
  const du = (pg.du && pg.du.items) || {}, sz = x => x.dir ? (x.name in du ? du[x.name] : -1) : x.size;   // 没量过的目录排最后
  const by = { name: (a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }), size: (a, b) => sz(b) - sz(a), time: (a, b) => b.mtime - a.mtime };
  return pg.data.items.slice().sort((a, b) => (fsSort === "name" ? b.dir - a.dir : 0) || by[fsSort](a, b) || by.name(a, b));
}
function fsCrumbs(path) {
  let acc = "";
  const segs = path.split("/").filter(Boolean), last = segs.length;
  const b = (p, t, cur) => `<button class="fs-crumb${cur ? " cur" : ""}"${cur ? "" : ` data-act="fsdir:${esc(p)}"`}>${esc(t)}</button>`;
  return `<div class="fs-crumbs">${b("/", "/", !last)}${segs.map((s, i) => b(acc += "/" + s, s, i === last - 1)).join("")}</div>`;
}
function fsRow(pg, dir, it) {
  const du = pg.du && pg.du.items, p = fsJoin(dir, it.name), k = it.dir ? "folder" : fsKind(it.name) === "image" ? "image" : "file";
  const meta = (it.dir ? (du && it.name in du ? `<b>${fsize(du[it.name])}</b> · ` : "") + (it.size >= 1000 ? "1000+" : it.size) + " 项" : fsize(it.size)) + " · " + fsTime(it.mtime);
  return `<button class="row fs-row" data-act="${it.dir ? "fsdir" : "fsfile"}:${esc(p)}"><span class="r-ic">${ico(k)}</span><span class="r-main"><span class="r-t">${esc(it.name)}</span>` +
    `<span class="r-s">${it.link ? "链接 · " : ""}${meta}</span></span>${it.dir ? `<span class="chev">${ico("chev")}</span>` : ""}</button>`;
}
async function fsDuRun(pg) {
  if (pg.du === "busy") return;
  pg.du = "busy"; draw(pg);
  try {
    const d = await fsJson(`http://${host()}/app/fsdu?p=${encodeURIComponent(fsPath(pg))}&key=${encodeURIComponent(cfg.token)}`, 150000);
    pg.du = d.err ? { err: d.err } : d;
  } catch (e) { pg.du = { err: e.message }; }
  draw(pg);
}
PAGES.files = {
  ctx: "fs", title: pg => fsName(fsPath(pg)),
  right: () => `<button class="nav-btn" data-act="reload" aria-label="刷新">${ico("repeat")}</button>`,
  async load(pg) {
    pg.stick = false; pg.data = null; pg.du = null;
    try {
      const d = await fsJson(fsUrl(fsPath(pg), "fmt=json"));
      pg.data = { items: (d.paths || []).map(x => ({ name: x.name, dir: /Dir$/.test(x.path_type), link: /^Symlink/.test(x.path_type), size: x.size, mtime: x.mtime })) };
      draw(pg);
    } catch (e) { loadErr(pg, e); }
  },
  html(pg) {
    const path = fsPath(pg), d = pg.data;
    if (!d) return LOADING;
    const L = fsSorted(pg), bad = !!(pg.du && pg.du.err);
    const sub = pg.du === "busy" ? "正在量各项占了多少盘…" : bad ? pg.du.err : `${d.items.length} 项` + (pg.du && pg.du.items ? ` · 合计 ${fsize(pg.du.total)}` : "");
    const chip = (k, t) => `<button class="fs-chip${fsSort === k ? " on" : ""}" data-act="fssort:${k}">${t}${k === "size" && pg.du === "busy" ? '<span class="spin"></span>' : ""}</button>`;
    return `<header class="hero"><div class="over">硅谷服务器</div><h1>${esc(fsName(path))}</h1><div class="sub${bad ? " bad" : ""}">${esc(sub)}</div></header>` +
      fsCrumbs(path) + `<div class="fs-bar">${chip("name", "名称")}${chip("size", "大小")}${chip("time", "时间")}</div>` +
      (L.length ? `<div class="group">${L.slice(0, FS_LIST_MAX).map(it => fsRow(pg, path, it)).join("")}</div>` +
        (L.length > FS_LIST_MAX ? `<div class="fs-note">还有 ${L.length - FS_LIST_MAX} 项没列出</div>` : "") : emptyHtml("folder", "空目录", ""));
  },
};
// ---------------------------------------------------------------- 文件查看器（2026-10-27，用户：对话里 AI 产出的文件 / 路径 / 链接要能直接在 App 里打开看）
// 来源有两种：服务器路径 { path, size, mtime }（文件页、回复里的路径）、对话里的文件 { id, url, name, size }（上传 / 小芽发的）。
// 按后缀分类（fsKind）：文本 / 代码 / JSON / Markdown 本地渲染，图片、音视频用系统自带的，HTML 放沙盒 iframe，
// PDF 用 PDF.js，Word / PPT 等先让服务器用 LibreOffice 转成 PDF（op /app/conv，缓存）再用 PDF.js，表格用 SheetJS，zip 只列目录。
// 开源库（PDF.js、SheetJS、highlight.js、KaTeX、Mermaid、JSZip）不打进安装包（IPA 一大 SideStore 就装不上），放服务器 /app/lib/，用到才下载、WebView 缓存。
const LIBS = {
  hljs: { js: ["highlight/highlight.min.js"] },
  xlsx: { js: ["xlsx/xlsx.full.min.js"] },
  pdf: { js: ["pdfjs/pdf.min.js"] },
  katex: { css: ["katex/katex.min.css"], js: ["katex/katex.min.js", "katex/auto-render.min.js"] },
  mermaid: { js: ["mermaid/mermaid.min.js"] },
  jszip: { js: ["jszip/jszip.min.js"] },
};
const libUrl = f => `http://${host()}/app/lib/${f}`;
const libP = {};
function loadLib(k) {
  if (libP[k]) return libP[k];
  const one = (tag, url) => new Promise((res, rej) => {
    const e = document.createElement(tag);
    if (tag === "link") { e.rel = "stylesheet"; e.href = url; } else e.src = url;
    e.onload = res; e.onerror = () => rej(new Error("加载组件失败（" + url.split("/").pop() + "），检查一下网络"));
    document.head.appendChild(e);
  });
  return libP[k] = (async () => {
    for (const c of LIBS[k].css || []) await one("link", libUrl(c));
    for (const j of LIBS[k].js) await one("script", libUrl(j));
  })().catch(e => { delete libP[k]; throw e; });
}
const fvSrc = p => p.url || fsUrl(p.path);
const fvName = p => p.name || fsName(p.path);
const fvConv = p => `http://${host()}/app/conv?${p.path ? "p=" + encodeURIComponent(p.path) : "id=" + encodeURIComponent(p.id)}&key=${encodeURIComponent(cfg.token)}`;
async function fvBytes(url, cap, ms) {                   // 整个读下来；超过 cap 不看了（fsGet 到上限会静悄悄截断，这里要报出来）
  const { bytes } = await fsGet(url, null, cap + 1, ms);
  if (bytes.length > cap) throw new Error(`文件超过 ${cap >> 20}MB，不在这里看，点下面的「下载 / 打开」`);
  return bytes;
}
async function fsLoadText(pg, tail) {
  const p = pg.p, d = pg.d, big = p.size > FS_TEXT_MAX;
  d.err = ""; d.busy = true; d.note = ""; draw(pg);
  try {
    if (p.size === 0 && !p.id) d.text = "";
    else {
      const init = big ? { headers: { Range: tail ? `bytes=${p.size - FS_TEXT_MAX}-` : `bytes=0-${FS_TEXT_MAX - 1}` } } : null;
      const { bytes, status } = await fsGet(fvSrc(p), init, FS_TEXT_MAX);
      if (big && tail && status !== 206) throw new Error("服务器没按分段给，看不了结尾");
      const s = fsText(bytes, big && tail);
      if (s == null) d.kind = "bin";                                       // 看着是二进制
      else { d.text = s; d.big = big; d.tail = big && tail; }
    }
    const lang = d.kind === "json" ? "json" : HL_LANG[fsExt(fvName(p))];
    if (lang && d.text && d.text.length <= 200000 && d.kind !== "md") { try { await loadLib("hljs"); } catch (e) { /* 高亮组件下不来就素着 */ } }
  } catch (e) { d.err = e.message; }
  d.busy = false;
  draw(pg);
  pg.el.scrollTop = d.tail ? pg.el.scrollHeight : 0;
  if (d.kind === "md" && d.text) mdEnhance(pg.el);
}
function fvTextBody(pg) {
  const d = pg.d, name = fvName(pg.p);
  if (d.kind === "md") return `<article class="article"><div class="bub md sk-md">${md(d.text)}</div></article>`;
  let text = d.text;
  if (d.kind === "json" && !d.big) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { /* 不是整段合法 JSON：原样 */ } }
  const lang = d.kind === "json" ? "json" : HL_LANG[fsExt(name)];
  if (lang && text.length <= 200000 && window.hljs && hljs.getLanguage(lang)) {
    try { return `<pre class="fs-pre hl"><code>${hljs.highlight(text, { language: lang, ignoreIllegals: true }).value}</code></pre>`; } catch (e) { /* 高亮出错：素着 */ }
  }
  return `<pre class="fs-pre">${esc(text)}</pre>`;
}
// Markdown 文件里的流程图（```mermaid）和数学公式（$$…$$、\(…\)、$…$）：看到了才去下组件
async function mdEnhance(root) {
  try {
    const mm = [...root.querySelectorAll("pre")].filter(x => (x.querySelector(".lang") || {}).textContent === "mermaid");
    if (mm.length) {
      await loadLib("mermaid");
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
      for (let i = 0; i < mm.length; i++) {
        try { const { svg } = await mermaid.render("mm" + Date.now() + i, mm[i].querySelector("code").textContent); mm[i].replaceWith(el(`<div class="mm">${svg}</div>`)); } catch (e) { /* 这张图语法有问题：留着代码 */ }
      }
    }
    if (/\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\$[^\s$][^$\n]*\$/.test(root.textContent)) {
      await loadLib("katex");
      renderMathInElement(root, { throwOnError: false, ignoredTags: ["script", "style", "textarea", "pre", "code"],
        delimiters: [{ left: "$$", right: "$$", display: true }, { left: "\\[", right: "\\]", display: true }, { left: "\\(", right: "\\)", display: false }, { left: "$", right: "$", display: false }] });
    }
  } catch (e) { /* 组件下不来：保持原样 */ }
}
// PDF（含 Word / PPT 转出来的）：整个读下来交给 PDF.js，每一页按可见区域懒渲染成画布；放大缩小重排
let pdfWorkerUrl = "";
async function fvPdfLoad(pg, url, conv) {
  const d = pg.d;
  d.busy = true; d.err = ""; d.note = conv ? "正在转换成 PDF…第一次打开要几秒到二十秒" : "正在读取…"; draw(pg);
  try {
    const bytes = await fvBytes(url, 120 << 20, conv ? 170000 : 90000);
    await loadLib("pdf");
    if (!pdfWorkerUrl) pdfWorkerUrl = URL.createObjectURL(new Blob([await (await fetch(libUrl("pdfjs/pdf.worker.min.js"))).text()], { type: "text/javascript" }));   // Worker 必须同源，所以转成 blob
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const doc = await pdfjsLib.getDocument({ data: bytes, cMapUrl: libUrl("pdfjs/cmaps/"), cMapPacked: true, standardFontDataUrl: libUrl("pdfjs/standard_fonts/") }).promise;
    const v = (await doc.getPage(1)).getViewport({ scale: 1 });
    pg.pdf = doc; d.pages = doc.numPages; d.ratio = v.height / v.width;
  } catch (e) { d.err = /password/i.test(e.message || "") ? "这个 PDF 有密码，打不开" : e.message || "打不开这个文件"; }
  d.busy = false; draw(pg); fvPdfMount(pg);
}
function fvPdfMount(pg) {
  const box = pg.el.querySelector(".pdf-doc"), doc = pg.pdf;
  if (!box || !doc) return;
  if (pg.io) pg.io.disconnect();
  box.innerHTML = "";
  const w = Math.round((box.clientWidth || pg.el.clientWidth - 32) * pg.d.zoom), h = Math.round(w * (pg.d.ratio || 1.41));
  const io = pg.io = new IntersectionObserver(es => es.forEach(en => {
    const t = en.target;
    if (en.isIntersecting && !t.dataset.done) { t.dataset.done = "1"; fvPdfPage(pg, +t.dataset.i, t, w); }
    else if (!en.isIntersecting && t.dataset.done) { t.textContent = ""; delete t.dataset.done; }      // 滚远了就把画布扔掉（几百页的 PDF 不然手机内存扛不住），回来再画
  }), { root: pg.el, rootMargin: "800px 0px" });
  for (let i = 1; i <= doc.numPages; i++) {
    const c = el(`<div class="pdf-pg" data-i="${i}" style="width:${w}px;height:${h}px"></div>`);
    box.appendChild(c); io.observe(c);
  }
}
async function fvPdfPage(pg, i, host_, cssW) {
  try {
    const page = await pg.pdf.getPage(i), base = page.getViewport({ scale: 1 });
    let sc = cssW / base.width * Math.min(window.devicePixelRatio || 1, 2);
    while (base.width * sc * base.height * sc > 12e6) sc *= 0.85;          // iOS 画布上限约 1600 万像素
    const vp = page.getViewport({ scale: sc }), cv = document.createElement("canvas");
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    cv.style.width = cssW + "px"; cv.style.height = Math.round(cssW * base.height / base.width) + "px";
    host_.style.height = cv.style.height;
    host_.appendChild(cv);
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
  } catch (e) { /* 这一页画不出来：留白 */ }
}
// 表格：xlsx / xls / ods 用 SheetJS，csv / tsv 自己解析（省一个组件、UTF-8 / GBK 都认）；最多显示 1000 行 × 40 列
function dsvParse(t, sep, limit) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < t.length && rows.length <= limit; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f === "") q = true;
    else if (c === sep) { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}
async function fvSheetLoad(pg) {
  const d = pg.d, p = pg.p, ext = fsExt(fvName(p));
  d.busy = true; d.err = ""; d.note = "正在读取…"; draw(pg);
  try {
    const bytes = await fvBytes(fvSrc(p), 30 << 20, 90000);
    if (ext === "csv" || ext === "tsv") {
      const t = fsDecode(bytes);
      if (t == null) throw new Error("看着不是文本的表格");
      d.sheets = [{ name: "", rows: dsvParse(t, ext === "tsv" ? "\t" : ",", 1001) }];
    } else {
      await loadLib("xlsx");
      const wb = XLSX.read(bytes, { type: "array", cellDates: true });
      d.sheets = wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "", blankrows: false }) }));
    }
    d.sheet = 0;
  } catch (e) { d.err = e.message || "打不开这个表格"; }
  d.busy = false; draw(pg);
}
function fvSheetHtml(pg) {
  const d = pg.d, sh = d.sheets[d.sheet], rows = sh.rows, MAXR = 1000, MAXC = 40;
  const tabs = d.sheets.length > 1 ? `<div class="fs-bar fv-tabs">${d.sheets.map((s, i) => `<button class="fs-chip${i === d.sheet ? " on" : ""}" data-act="fvsheet:${i}">${esc(s.name || "表" + (i + 1))}</button>`).join("")}</div>` : "";
  const cols = Math.min(MAXC, rows.slice(0, MAXR).reduce((m, r) => Math.max(m, r.length), 0));
  if (!rows.length || !cols) return tabs + '<div class="fs-note">这张表是空的。</div>';
  const body = rows.slice(0, MAXR).map((r, ri) => "<tr>" + Array.from({ length: cols }, (_, c) => `<${ri ? "td" : "th"}>${esc(r[c] == null ? "" : r[c])}</${ri ? "td" : "th"}>`).join("") + "</tr>").join("");
  return tabs + `<div class="fv-tbl"><table>${body}</table></div>` +
    (rows.length > MAXR ? `<div class="fs-note">只显示前 ${MAXR} 行。</div>` : "") + (cols === MAXC ? `<div class="fs-note">只显示前 ${MAXC} 列。</div>` : "");
}
async function fvZipLoad(pg) {
  const d = pg.d;
  d.busy = true; d.err = ""; d.note = "正在读取…"; draw(pg);
  try {
    const bytes = await fvBytes(fvSrc(pg.p), 50 << 20, 90000);
    await loadLib("jszip");
    const zip = await JSZip.loadAsync(bytes);
    d.entries = Object.values(zip.files).map(f => ({ n: f.name, dir: f.dir, size: (f._data && f._data.uncompressedSize) || 0 })).sort((a, b) => a.n.localeCompare(b.n, "zh-Hans-CN", { numeric: true }));
  } catch (e) { d.err = e.message || "打不开这个压缩包"; }
  d.busy = false; draw(pg);
}
function fvFit(pg) {                                       // HTML 预览按电脑屏幕排版再缩放（跟「系统」页一样）
  sysFit(pg);
  if (!pg.ro && window.ResizeObserver) { pg.ro = new ResizeObserver(() => sysFit(pg)); pg.ro.observe(pg.el); }
}
PAGES.fileView = {
  ctx: "fs", bar: "acts", title: pg => fvName(pg.p),
  acts: pg => {
    const d = pg.d || {}, a = [];
    if (d.kind === "pdf" || d.kind === "office") a.push({ label: "", icon: "minus", cls: "mini", act: "fvzoom:-" }, { label: "", icon: "plus", cls: "mini", act: "fvzoom:+" });
    if (d.kind === "html") a.push(d.mode === "src" ? { label: "预览", icon: "globe", act: "fvmode" } : { label: "源码", icon: "term", act: "fvmode" });
    if (d.big) a.push(d.tail ? { label: "看开头", icon: "vtop", act: "fshead" } : { label: "看结尾", icon: "vbot", act: "fstail" });
    if (pg.p.path) a.push({ label: "所在文件夹", icon: "folder", act: "fsparent" });
    a.push({ label: "下载 / 打开", icon: "download", cls: "primary", act: "fsopen" });
    return a;
  },
  load(pg) {
    pg.stick = false;
    if (pg.pdf) { pg.pdf.destroy().catch(() => {}); pg.pdf = null; }
    const kind = fsKind(fvName(pg.p));
    pg.d = { kind, text: null, big: false, tail: false, err: "", busy: false, note: "", mode: "view", zoom: 1 };
    if (kind === "html") { draw(pg); fvFit(pg); return; }
    if (kind === "image" || kind === "audio" || kind === "video" || kind === "bin") { draw(pg); return; }
    if (kind === "pdf") return fvPdfLoad(pg, fvSrc(pg.p), false);
    if (kind === "office") return fvPdfLoad(pg, fvConv(pg.p), true);
    if (kind === "sheet") return fvSheetLoad(pg);
    if (kind === "zip") return fvZipLoad(pg);
    return fsLoadText(pg, false);
  },
  html(pg) {
    const d = pg.d, p = pg.p, name = fvName(p), src = fvSrc(p);
    const head = `<header class="hero"><div class="over">${esc(p.path ? fsDir(p.path) : "对话里的文件")}</div><h1>${esc(name)}</h1>` +
      `<div class="sub">${esc([p.size ? fsize(p.size) : "", p.mtime ? fsTime(p.mtime) : "", d && d.pages ? d.pages + " 页" : ""].filter(Boolean).join(" · "))}</div></header>`;
    if (!d) return head + LOADING;
    if (d.kind === "html" && d.mode !== "src")
      return `<div class="sys-wait">${LOADING}</div><div class="sys-box fv"><iframe class="sys-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" src="${esc(src)}" onload="this.classList.add('on')"></iframe>` +
        '<div class="sys-tip">横过来看，整个页面更清楚</div></div><div class="sys-edge"></div>';
    if (d.busy) return head + (d.note ? `<div class="fs-note">${esc(d.note)}</div>` : "") + LOADING;
    if (d.err) return head + `<div class="fs-note bad">${esc(d.err)}</div><button class="btn" data-act="reload">重试</button>`;
    switch (d.kind) {
      case "image": return head + (p.size > FS_IMG_MAX ? '<div class="fs-note">图片超过 20MB，不在这里预览，点下面的「下载 / 打开」。</div>' : `<img class="fs-img" data-act="img" src="${esc(src)}" alt="">`);
      case "audio": return head + `<audio class="fv-media" controls preload="metadata" src="${esc(src)}" onerror="this.insertAdjacentHTML('afterend','<div class=fs-note>这个音频格式手机放不了，点下面的「下载 / 打开」。</div>')"></audio>`;
      case "video": return head + `<video class="fv-media" controls playsinline preload="metadata" src="${esc(src)}" onerror="this.insertAdjacentHTML('afterend','<div class=fs-note>这个视频格式手机放不了，点下面的「下载 / 打开」。</div>')"></video>`;
      case "pdf": case "office": return head + '<div class="pdf-doc"></div>';
      case "sheet": return head + fvSheetHtml(pg);
      case "zip": return head + `<div class="fs-note">压缩包，共 ${d.entries.length} 项（只列目录，不解压）。</div><div class="group">` +
        d.entries.slice(0, 500).map(x => `<div class="row fs-row"><span class="r-ic">${ico(x.dir ? "folder" : "file")}</span><span class="r-main"><span class="r-t">${esc(x.n)}</span>${x.dir ? "" : `<span class="r-s">${fsize(x.size)}</span>`}</span></div>`).join("") +
        `</div>${d.entries.length > 500 ? `<div class="fs-note">还有 ${d.entries.length - 500} 项没列出。</div>` : ""}`;
      case "bin": return head + `<div class="fs-note">${fsKind(name) === "probe" ? "看起来是二进制文件，不预览。" : "这类文件不在这里预览。"}点下面的「下载 / 打开」。</div>`;
    }
    if (d.text === "") return head + '<div class="fs-note">空文件。</div>';
    return head + (d.big ? `<div class="fs-note">只显示${d.tail ? "最后" : "开头"} 256KB，共 ${fsize(p.size)}。</div>` : "") + fvTextBody(pg);
  },
};

// ---------------------------------------------------------------- 系统页（2026-10-27）：服务器上自己做的那批系统（汇报 / BI / 客服看板 / 话术审核台…）聚合在这里
// 这些系统只听服务器本机，手机从 8003 的 /app/s/<令牌>/<挂载点>/ 带令牌转进去（server.py「手机 App『系统』页」一节）；点开用 iframe 在 App 里显示。
// 清单（名字、起始路径、分组）由服务器 op sys 给，加系统只改 server.py 的 SYS_LIST。出错一律就地一行字，不弹框。
const sysUrl = p => `http://${host()}/app/s/${encodeURIComponent(cfg.token)}/${p.mount}${p.path}`;
PAGES.systems = {
  ctx: "sys", title: () => "系统",
  right: () => `<button class="nav-btn" data-act="reload" aria-label="刷新">${ico("repeat")}</button>`,
  async load(pg) { pg.stick = false; try { pg.data = await q("sys"); draw(pg); } catch (e) { loadErr(pg, e); } },
  html(pg) {
    const L = pg.data && pg.data.list;
    if (!L) return LOADING;
    const up = L.filter(x => x.up).length;
    return `<header class="hero"><div class="over">硅谷服务器</div><h1>系统</h1><div class="sub">${up === L.length ? `${L.length} 个都在运行` : `${up} / ${L.length} 个在运行`} · 点开直接在 App 里用</div></header>` +
      [...new Set(L.map(x => x.group))].map(g => `<div class="sys-g">${esc(g)}</div><div class="group">` + L.map((x, i) => x.group !== g ? "" :
        `<button class="row" data-act="sysgo:${i}"><span class="r-main"><span class="r-t">${esc(x.name)}</span>` +
        `<span class="r-s">${x.up ? "" : '<b class="bad">没在运行</b> · '}${esc(x.desc)}</span></span><span class="sys-st${x.up ? "" : " down"}"></span><span class="chev">${ico("chev")}</span></button>`).join("") + "</div>").join("");
  },
};
PAGES.sysView = {
  ctx: "sys", title: pg => pg.p.name,
  right: () => `<button class="nav-btn" data-act="reload" aria-label="刷新">${ico("repeat")}</button><button class="nav-btn" data-act="sysout" aria-label="用浏览器打开">${ico("globe")}</button>`,
  load(pg) {
    pg.stick = false; draw(pg); sysFit(pg);
    if (!pg.ro && window.ResizeObserver) { pg.ro = new ResizeObserver(() => sysFit(pg)); pg.ro.observe(pg.el); }   // 转屏
  },
  html(pg) {
    return `<div class="sys-wait">${LOADING}</div><div class="sys-box"><iframe class="sys-frame" src="${esc(sysUrl(pg.p))}" onload="this.classList.add('on')"></iframe>` +
      '<div class="sys-tip">横过来看，整个页面更清楚</div></div><div class="sys-edge"></div>';
  },
};
// 2026-10-27 用户：这些系统是按电脑做的，手机窄屏上排版很乱 → 一律按 1280 宽的电脑屏幕排版再整体缩放：
// 竖屏保持电脑的 16:10（1280x800）缩到屏幕宽度，下面留空；横屏高度跟着屏幕走、整屏铺满
const SYS_VW = 1280, SYS_VH = 800;
function sysFit(pg) {
  const box = pg.el.querySelector(".sys-box"), f = box && box.firstElementChild, w = box ? box.clientWidth : 0, h = box ? box.clientHeight : 0;
  if (!f || !w || !h) return;
  const s = w / SYS_VW, vh = w < h ? SYS_VH : Math.round(h / s), tip = box.querySelector(".sys-tip");
  f.style.height = vh + "px";
  f.style.transform = `scale(${s})`;
  tip.hidden = w >= h;
  tip.style.top = Math.round(vh * s + 14) + "px";
}

// 侧栏数据变了（Claude 开始 / 做完、小智说完）：稍等一下合并着重拉（侧栏和左上角的点都靠它）
let homeTimer = 0;
function homeDirty() {
  clearTimeout(homeTimer);
  homeTimer = setTimeout(homeTiles, 400);
}
PAGES.home.onShow = pg => { if (pg.dirty) { pg.dirty = false; draw(pg); } };

function onEv(m) {
  if (m.w === "c") onClaudeEv(m);
  else if (m.w === "xz") onXzEv(m);
  else if (m.w === "xy") onXyEv(m);
  else if (m.w === "hx") onHxEv(m);
  else if (m.w === "o") onOcEv("oc", m);
  else if (m.w === "ob") onOcEv("ocb", m);
}

// ---------------------------------------------------------------- 计时（Claude 干活、小芽通话）
function tickTimers() {
  const now = Date.now() / 1000;
  document.querySelectorAll("[data-t0]").forEach(t => { t.textContent = mmss((now - +t.dataset.t0) * 1000); });
  if (call.on) {
    const s = mmss(Date.now() - call.t0);
    document.querySelectorAll(".call-t").forEach(e => { e.textContent = s + " · 点这里回到通话"; });
  }
  xyStat();
}
setInterval(tickTimers, 1000);

// ---------------------------------------------------------------- 点按：整个界面一个委托（click 才算 iOS 的用户手势）
// 列表页上点了切换 / 新建，等服务器回了再返回：只在还停在那个列表上时返回（2026-10-15 日志：iPhone 上回得慢、连点了几下，每个回话都返回一次，一路退回了首页）
const backFrom = k => { if (curPage() && curPage().key === k) back(); };
const ACT = {
  back: () => { if (!back()) {} },
  go: k => go(k),
  settings: () => openSettings(),
  login: () => doLogin(),
  lgsrv: () => { const b = $("#lgSrvBox"); b.hidden = !b.hidden; },
  async logout() {
    try { await q("logout"); } catch (e) { /* 没连上也照样退 */ }
    closeSheet();
    needLogin("已退出登录");
  },
  artog: () => {
    setAutoRead(!autoRead);
    hap("medium");
    if (call.on && !$("#xy").hidden) xyFlash(autoRead ? "自动朗读已开：小芽、小智的回复会念出来" : "自动朗读已关：回复只显示文字");   // 别处喇叭图标自己会变
  },
  bgtog: (_, t) => { bgOn = !bgOn; store("bgOn", bgOn ? "1" : "0"); t.classList.toggle("on", bgOn); bgSync(); },
  notetog: (_, t) => { noteOn = !noteOn; store("noteOn", noteOn ? "1" : "0"); t.classList.toggle("on", noteOn); bgSync(); if (noteOn && Link) Link.perm().catch(() => {}); },
  pwopen: () => { const b = $("#pwBox"); b.hidden = !b.hidden; if (!b.hidden) setTimeout(() => $("#pwOld").focus(), 60); },
  async pwsave() {
    const o = $("#pwOld").value, n = $("#pwNew").value;
    if (n.length < 6) { hint("新密码至少 6 位", $("#pwBox")); return; }
    try {
      await q("passwd", { old: o, new: n });
      $("#pwOld").value = $("#pwNew").value = ""; $("#pwBox").hidden = true;
      $("#pwBox").previousElementSibling.querySelector(".r-s").textContent = "密码已改好 · 别的设备要重新登录";
    } catch (e) { hint(e.message, $("#pwBox")); }
  },
  async onew(a) {
    const E = ocHost();
    try {
      const d = await q(E.p + "_new");
      const pg = ocPage(E.key);
      if (pg) { pg.data = d; pg.stick = true; draw(pg); }
      if (a === "back") backFrom(E.sess);
    } catch (e) { hint(e.message); }
  },
  async osw(sid) {
    const E = ocHost();
    try {
      const d = await q(E.p + "_switch", { sid });
      const pg = ocPage(E.key);
      if (pg) { pg.data = d; pg.stick = true; draw(pg); }
      backFrom(E.sess);
    } catch (e) { hint(e.message); }
  },
  async ostop() { const E = ocHost(), pg = ocPage(E.key); try { await q(E.p + "_stop", { sid: pg && pg.data && pg.data.sid }); } catch (e) { hint(e.message); } },
  ocmodel: () => openOcModels(),
  xymodels: () => openXyModels(),
  async xypick(k) {
    try { await hxq("set_model", { m: k }); closeSheet(); }
    catch (e) { hint(e.message); }
  },
  async xythink(k) {
    try { await hxq("thinking", { e: k === "1" }); hint(k === "1" ? "已开思考" : "思考关了"); openXyModels(); }
    catch (e) { hint(e.message); }
  },
  async ocmodelpick(k) {
    const E = ocHost();
    try { await q(E.p + "_model", { m: k }); closeSheet(); const pg = ocPage(E.key); if (pg) pg.def.load(pg); }
    catch (e) { hint(e.message); }
  },
  async ocvariant(k) {
    const E = ocHost();
    try { await q(E.p + "_variant", { v: k === "default" ? "" : k }); openOcModels(); }
    catch (e) { hint(e.message); }
  },
  async octhink(k) {
    const E = ocHost();
    try { await q(E.p + "_think", { e: k === "1" }); openOcModels(); }
    catch (e) { hint(e.message); }
  },
  async omore(_, t) {                                  // OpenCode 对话顶上「显示更早的消息」
    const E = ocHost(), pg = ocPage(E.key), d = pg && pg.data;
    if (!d) return;
    t.disabled = true; t.textContent = "加载中…";
    try {
      const r = await q(E.p + "_more", { sid: d.sid, at: (d.msgs[0] || {}).at });
      const h = pg.el.scrollHeight - pg.el.scrollTop;
      d.msgs.splice(0, 1, ...r.msgs);
      pg.stick = false; draw(pg);
      pg.el.scrollTop = pg.el.scrollHeight - h;
    } catch (e) { t.disabled = false; t.textContent = "没加载出来（" + e.message + "），点这里重试"; }
  },

  async cmore(_, t) {                                  // Claude 对话顶上「显示更早的消息」：往前翻一页，停在原来看的位置
    const pg = claudePage(), d = pg && pg.data;
    if (!d || !cAt(d) || t.disabled) return;
    t.disabled = true; t.textContent = "正在加载…";
    try {
      const r = await q("c_more", { sid: d.sid, at: cAt(d) });
      if (pg.data !== d) return;
      const h = pg.el.scrollHeight - pg.el.scrollTop;
      d.msgs.splice(0, 1, ...r.msgs);
      pg.stick = false; draw(pg);
      pg.el.scrollTop = pg.el.scrollHeight - h;
    } catch (e) { t.disabled = false; t.textContent = "没加载出来（" + e.message + "），点这里重试"; }
  },
  async cnew(a) {
    try {
      const d = await q("c_new");
      const pg = claudePage();
      if (pg) { pg.data = d; pg.stick = true; draw(pg); }
      if (a === "back") backFrom("csess");
    } catch (e) { hint(e.message); }
  },
  async csw(sid) {
    try {
      const d = await q("c_switch", { sid });
      const pg = claudePage();
      if (pg) { pg.data = d; pg.stick = true; draw(pg); }
      backFrom("csess");
    } catch (e) { hint(e.message); }
  },
  async cstop() { const pg = claudePage(); try { await q("c_stop", { sid: pg && pg.data && pg.data.sid }); } catch (e) { hint(e.message); } },
  cmodel: () => openModels(),
  async model(a) {
    const [m, sub] = a.split("|");
    try {
      const r = await q("c_model", { m, sub });
      closeSheet();
      const pg = claudePage();
      if (pg) pg.def.load(pg);
    } catch (e) { hint(e.message); }
  },
  async xznew(a) {
    try {
      const d = await q("xz_new");
      const pg = stack.find(p => p.key === "xz");
      if (pg) { pg.data = d; draw(pg); }
      if (a === "back") backFrom("xzconv");
    } catch (e) { hint(e.message); }
  },
  async xzsw(id) {
    try {
      const d = await q("xz_switch", { cid: id });
      const pg = stack.find(p => p.key === "xz");
      if (pg) { pg.data = d; pg.stick = true; draw(pg); }
      backFrom("xzconv");
    } catch (e) { hint(e.message); }
  },
  nitem: k => go("newsItem", { k: +k }),
  async nplay(k) { try { await q("news_play", { k: +k }); } catch (e) { hint(e.message); } },
  async nsay(k) { try { await q("news_say", { k: +k }); } catch (e) { hint(e.message); } },
  async nresume() { const pg = curPage(); if (pg && pg.data && pg.data.last) ACT.nplay(pg.data.last - 1); },
  call: to => callStart(to),
  xymenu: () => openXyMenu(),
  drawer: () => openDrawer(),
  dwclose: () => closeDrawer(),
  dwgo: k => goSection(k),
  xygo: k => { closeSheet(); go(k); },
  memed: a => { const [t, k] = a.split(":"); openMemEdit(t, k); },
  async memsave() {
    const c = memCtx, text = $("#memText").value.trim();
    if (!c || !text) return;
    try {
      const d = await hxq("memory_edit", c.old ? { action: "replace", target: c.t, old_text: c.old, content: text } : { action: "add", target: c.t, content: text });
      closeSheet(); c.pg.data = d; draw(c.pg);
    } catch (e) { hint(e.message); }
  },
  async memdel() {
    const c = memCtx;
    if (!c || !c.old) return;
    try { const d = await hxq("memory_edit", { action: "remove", target: c.t, old_text: c.old }); closeSheet(); c.pg.data = d; draw(c.pg); }
    catch (e) { hint(e.message); }
  },
  skview: name => go("xyskill", { name }),
  async sktog(name, t) {
    const pg = curPage(), on = !t.classList.contains("on");
    t.classList.toggle("on", on);
    try { pg.data = await hxq("skill_toggle", { name, on }); draw(pg); }
    catch (e) { t.classList.toggle("on", !on); hint(e.message); }
  },
  cronopen: k => openCron(k),
  async cron(a) {
    const [action, id] = a.split(":"), pg = curPage();
    try {
      pg.data = Object.assign(await hxq("cron", { action, id }), { log: pg.data && pg.data.log });
      closeSheet(); draw(pg);
    } catch (e) { hint(e.message); }
  },
  sessopen: sid => {
    const pg = curPage(), r = pg.data && pg.data.sessions.find(x => x.sid === sid);
    go("xysessView", { sid, title: r ? r.title || r.snip : "", cur: r && r.cur });
  },
  sessq: () => { const pg = curPage(); if (pg && pg.key === "xysess") { pg.p.q = $("#sessQ").value.trim(); pg.data = null; draw(pg); pg.def.load(pg); } },
  async sessresume(sid) {
    try {
      await hxq("resume", { sid });
      const xi = stack.findIndex(p => p.key === "home");           // 回到小芽页：中间的历史列表悄悄丢掉
      while (xi >= 0 && stack.length > xi + 2) stack.splice(xi + 1, 1)[0].el.remove();
      popPage();
      Object.assign(hx, { msgs: null }); hxRedraw(true);
      setTimeout(hxLoad, 1500);
    } catch (e) { hint(e.message); }
  },
  async hxnew() {
    closeSheet();
    try { await q("hx", { hop: "new_session", a: {} }); Object.assign(hx, { msgs: [], busy: false }); hxRedraw(true); setTimeout(hxLoad, 1500); }
    catch (e) { hint(e.message); }
  },
  async hxok(choice) {
    const a = hx.msgs && [...hx.msgs].reverse().find(x => x.r === "ask" && x.live);
    try {
      const r = await q("hx", { hop: "approve", a: { choice } });
      if (a) { a.live = false; a.done = !r.ok ? (r.why || "没在等确认了") : choice === "once" ? "已确认执行" : "已取消"; }
      hxRedraw();
    } catch (e) { hint(e.message); }
  },
  async hxf(i) {                                       // 小芽发过的文件（历史里只有服务器上的路径）：取回来存成上传文件再打开
    const [k, j] = String(i).split(":");
    const m = hx.msgs && hx.msgs[+k];
    const it = m && (j != null ? (m.files || []).filter(f => !f.id)[+j] : m);
    if (!it || !it.path) return;
    try {
      const f = await q("hx", { hop: "file", a: { path: it.path } });
      if (j != null) Object.assign(it, f); else m.f = f;
      hxRedraw();
      if (f.kind === "image") { const v = $("#viewer"); v.querySelector("img").src = fileUrl(f.id); v.classList.add("on"); }
    } catch (e) { hint(e.message); }
  },
  xymin: () => xyMin(),
  xyhang: () => callEnd(),
  xysnd: () => {                                       // 声音 = 自动朗读开关：关着小芽照样听、照样回，只是不念，回复看字幕
    const on = !(autoRead && !soundOff);
    if (on && soundOff) { soundOff = false; if (Link) Link.sound({ off: false }).catch(() => {}); }   // 锁屏 / 灵动岛上关的声音一起打开
    setAutoRead(on);
    hap("medium");
    xyFlash(on ? `声音已打开，${cname()}的回复会念出来` : `声音已关，${cname()}的回复只显示文字`);
  },
  xymute: () => { call.muted = !call.muted; hap("medium"); if (Link && live) Link.live({ on: true, mute: call.muted }).catch(() => {}); xyUpd(); },
  xyorb: () => { if (speaking()) spStop(true); },
  fopen: (id, t) => { if (id) go("fileView", { id, url: fileUrl(id), name: t.dataset.name || id.split("/").pop(), size: +t.dataset.size || 0 }); },     // 对话里的文件：App 里直接看
  path: p => {                                         // 回复里的服务器路径：文件直接看，文件夹进「文件」页
    const m = pathGet(p);
    if (!m) return;
    if (m.t === "d") go("files", { path: p }); else go("fileView", { path: p, size: m.size, mtime: m.mtime });
  },
  img: (_, t) => { const v = $("#viewer"); v.querySelector("img").src = t.src; v.classList.add("on"); },
  copycode: (_, t) => copy(t.parentNode.querySelector("code").textContent),   // 点按本身震一下，不弹「已复制」
  saveSettings: () => saveSettings(),
  closeSheet: () => closeSheet(),
  pop: k => popDo(k),
  plugtog: () => { const pg = curPage(); if (pg && pg.data) plugRun(pg, pg.data.pwr ? "off" : "on"); },
  plugre: () => { const pg = curPage(); if (pg) plugRun(pg, "state"); },
  fsdir: p => go("files", { path: p }),
  fsfile: p => {
    const pg = curPage(), n = fsName(p), it = pg && pg.data && pg.data.items && pg.data.items.find(x => x.name === n);
    if (it) go("fileView", { path: p, size: it.size, mtime: it.mtime });
  },
  fssort: k => {
    const pg = curPage();
    fsSort = k;
    if (k === "size" && pg.du !== "busy" && (!pg.du || pg.du.err)) fsDuRun(pg);     // 按大小排：目录要先量一遍占用（点了才量）
    else draw(pg);
  },
  fsopen: () => { const pg = curPage(); if (pg) window.open(fvSrc(pg.p), "_blank"); },   // 交给系统浏览器：能显示的显示，不能的下载
  fsparent: () => { const pg = curPage(); if (pg && pg.p.path) go("files", { path: fsDir(pg.p.path) }); },     // 所在文件夹
  fvzoom: dir => {
    const pg = curPage(), Z = [1, 1.5, 2, 3];
    if (!pg || !pg.pdf) return;
    pg.d.zoom = Z[Math.max(0, Math.min(Z.length - 1, Z.indexOf(pg.d.zoom) + (dir === "+" ? 1 : -1)))];
    fvPdfMount(pg);
  },
  fvmode: () => {                                      // HTML 文件：预览 ⇄ 源码
    const pg = curPage();
    if (!pg || !pg.d) return;
    if (pg.d.mode === "src") { pg.d.mode = "view"; draw(pg); fvFit(pg); }
    else { pg.d.mode = "src"; if (pg.d.text == null) fsLoadText(pg, false); else draw(pg); }
  },
  fvsheet: i => { const pg = curPage(); if (pg && pg.d && pg.d.sheets) { pg.d.sheet = +i; draw(pg); pg.el.scrollTop = 0; } },
  fshead: () => fsLoadText(curPage(), false),
  fstail: () => fsLoadText(curPage(), true),
  sysgo: i => { const pg = curPage(), x = pg && pg.data && pg.data.list && pg.data.list[+i]; if (x) go("sysView", { mount: x.mount, path: x.path, name: x.name }); },
  sysout: () => { const pg = curPage(); if (pg) brOpen(sysUrl(pg.p)); },   // 用 App 内浏览器打开（有地址栏、能切电脑版）；没有浏览器模块就交系统浏览器
  reload: () => { const pg = curPage(); if (pg && pg.def.load) { pg.el.innerHTML = LOADING; pg.def.load(pg); } },
  spstop: () => spStop(true),
};

// ---------------------------------------------------------------- 浏览器（2026-10-27，用户：要能自己填网址、登录各种页面，像电脑上的浏览器）
// 用开源插件 @capgo/capacitor-inappbrowser（MPL-2.0；原生 WebView，iOS 是 WKWebView、安卓是系统 WebView）当网页内核：每个标签页一个原生 WebView，
// 摆在页面中间那一块（x / y / width / height），四周的触摸穿透到下面的网页层；地址栏、标签条、底栏、书签、历史都是这里用 HTML 画的（跟 App 别的页一个风格，热更新）。
// 为什么不直接拿「谷歌浏览器」：iPhone 上所有浏览器都必须用苹果的 WebKit，Chrome / Firefox / Brave 的 iOS 版都是整个 App、不是组件，嵌不进来。
// 🔴 原生 WebView 永远盖在网页层上面：弹层（侧栏、底部菜单、通话、图片查看、标签总览、地址栏联想）出来时必须先把它藏起来（brSync 每 250ms 对一遍：该不该显示、位置对不对）。
// 🔴 页面标题：插件没有标题事件，靠页面加载完 executeScript 让页面里的 window.mobileApp.postMessage 把 title 发回来（messageFromWebview）。
// 🔴 没有这个插件的安装包（老壳）/ 浏览器里：IAB 为 null，链接照旧交系统浏览器（openLink）；插件连着出错 3 次也退回系统浏览器（BR.broken）。
const IAB = plug("CapgoInAppBrowser");
const BR_MAX = 8, BR_LIVE = 3;                       // 最多 8 个标签；同时活着的原生 WebView 最多 3 个，其余卸掉（地址标题留着，点开重新加载）
const BR_ENGINES = { baidu: ["百度", "https://www.baidu.com/s?wd="], bing: ["必应", "https://www.bing.com/search?q="], google: ["谷歌", "https://www.google.com/search?q="] };
const BR_UA = PLATFORM === "ios" ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
  : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const BR_META_JS = "try{window.mobileApp.postMessage({detail:{m:'meta',t:document.title,u:location.href}})}catch(e){}";
const BR_DESK_JS = "(function(){var m=document.querySelector('meta[name=viewport]');if(!m){m=document.createElement('meta');m.name='viewport';(document.head||document.documentElement).appendChild(m);}m.content='width=1280';})();";
const BR = { tabs: [], cur: 0, seq: 0, mode: "", ready: false, broken: false, fails: 0, prog: 0, sys: null, clearArm: false };
const brJson = (k, d) => { try { return JSON.parse(store(k) || "null") || d; } catch (e) { return d; } };
let brBm = brJson("br_bm", []), brHist = brJson("br_hist", []), brSet = Object.assign({ engine: "baidu" }, brJson("br_set", {}));
const brNewTab = (url, desk) => ({ k: ++BR.seq, url: url || "", title: "", desk: !!desk, wid: null, vis: false, shot: "", load: false, err: false, used: Date.now(), dim: "" });
const brCur = () => BR.tabs[BR.cur];
const brByWid = id => BR.tabs.find(t => t.wid === id);
const brHost = u => { try { return new URL(u).host.replace(/^www\./, ""); } catch (e) { return u; } };
const isLoopback = h => /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])$/.test(h);
function brSave() { store("br_state", JSON.stringify({ tabs: BR.tabs.map(t => ({ u: t.url, t: t.title, d: t.desk })), cur: BR.cur })); }
function brEnsure() {                                // 第一次用：读回上次的标签、挂上插件事件
  if (BR.ready) return;
  BR.ready = true;
  const d = brJson("br_state", null);
  if (d && Array.isArray(d.tabs)) {
    BR.tabs = d.tabs.slice(0, BR_MAX).map(x => Object.assign(brNewTab(x.u, x.d), { title: x.t || "" }));
    BR.cur = Math.max(0, Math.min(d.cur || 0, BR.tabs.length - 1));
  }
  if (!BR.tabs.length) BR.tabs.push(brNewTab(""));
  brListen();
}
// 地址栏输入 → 网址：有协议的原样；IP / localhost / 带端口的补 http://；像域名的补 https://；其余当关键词搜
function brNormalize(s) {
  s = String(s || "").trim();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|blob):/i.test(s)) return s;
  if (!/\s/.test(s)) {
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|[^\s/]+:\d+)([:/?#].*)?$/i.test(s)) return "http://" + s;
    if (/^[^\s/?#]+\.[a-z]{2,}([:/?#].*)?$/i.test(s)) return "https://" + s;
  }
  return BR_ENGINES[brSet.engine][1] + encodeURIComponent(s);
}
// 服务器本机端口（127.0.0.1:19490…）手机够不着：改成「系统页」的反代网址；没登记的返回 ""
async function sysMapUrl(u) {
  if (!sysPorts) { try { sysPorts = (await q("sys")).ports || {}; } catch (e) { hint(e.message); return ""; } }
  const mount = sysPorts[u.port];
  return mount ? sysUrl({ mount, path: u.pathname + u.search + u.hash }) : "";
}
const brIsSys = url => url.startsWith(`http://${host()}/app/s/`);
async function brResolve(input) {                    // 输入 → 真正要加载的网址（本机端口换成反代）；办不了返回 ""
  let url = brNormalize(input);
  try {
    const u = new URL(url);
    if (isLoopback(u.hostname)) {
      const m = await sysMapUrl(u);
      if (!m) { hint(`服务器上 ${u.port} 端口的页面没登记在「系统」页里，手机打不开`); return ""; }
      url = m;
    }
  } catch (e) { /* 不是标准网址：原样 */ }
  return url;
}
// 对外入口：聊天里的外链、系统页「用浏览器打开」都走这里。没有浏览器模块就交系统浏览器
async function brOpen(url, newTab) {
  if (!IAB || BR.broken) { window.open(url, "_blank"); return; }
  brEnsure();
  url = await brResolve(url);
  if (!url) return;
  let t = brCur();
  if (newTab !== false && !(t && !t.url)) {          // 当前是空白标签就直接用，不然新开一个；满了就顶掉当前这个
    if (BR.tabs.length >= BR_MAX) hint("标签页满了（最多 " + BR_MAX + " 个），在当前标签里打开");
    else { t = brNewTab(); BR.tabs.push(t); BR.cur = BR.tabs.length - 1; }
  }
  t.url = url; t.title = ""; t.err = false; t.used = Date.now(); t.desk = brIsSys(url);
  BR.mode = "";
  brSave();
  const pg = curPage();
  if (pg && pg.key === "browser") { draw(pg); brSync(); } else go("browser");
}
function brFail(e) {
  BR.fails++;
  if (BR.fails >= 3 && !BR.broken) { BR.broken = true; hint("浏览器组件出错了，链接先交给系统浏览器：" + (e && e.message || e)); }
}

// ---- 插件事件
let brListening = false;
function brListen() {
  if (brListening || !IAB) return;
  brListening = true;
  const on = (ev, fn) => { try { IAB.addListener(ev, fn).catch(() => {}); } catch (e) { /* 这个事件这版插件没有 */ } };
  on("urlChangeEvent", e => {
    const t = brByWid(e.id);
    if (!t || !e.url || e.url === t.url) return;
    t.url = e.url; t.err = false;
    if (t === brCur()) brUrlBar();
    brSave();
  });
  on("browserPageLoadStart", e => { const t = brByWid(e.id); if (t) { t.load = true; t.err = false; if (t === brCur()) { BR.prog = .05; brUpdBar(); } } });
  on("browserPageLoadProgress", e => { const t = brByWid(e.id); if (t && t === brCur()) { BR.prog = e.progress; brUpdBar(); } });
  on("browserPageLoaded", e => {
    const t = brByWid(e.id);
    if (!t) return;
    t.load = false;
    if (t === brCur()) { BR.prog = 0; brUpdBar(); }
    IAB.executeScript({ id: t.wid, code: BR_META_JS }).catch(() => {});
    if (t.desk) IAB.executeScript({ id: t.wid, code: BR_DESK_JS }).catch(() => {});
  });
  on("pageLoadError", e => { const t = brByWid(e.id); if (t) { t.load = false; t.err = true; if (t === brCur()) { BR.prog = 0; brUpdBar(); } } });
  on("messageFromWebview", e => {
    let d = e && e.detail;
    if (!d && e && e.rawMessage) { try { d = JSON.parse(e.rawMessage).detail; } catch (x) { /* 不是我们的消息 */ } }
    if (!d || d.m !== "meta") return;
    const t = (e.id && brByWid(e.id)) || brCur();
    if (!t) return;
    t.title = d.t || t.title;
    if (d.u) t.url = d.u;
    brHistAdd(t.url, t.title);
    if (t === brCur()) brUrlBar();
    brSave();
  });
  on("closeEvent", e => { const t = brByWid(e.id); if (t) { t.wid = null; t.vis = false; t.dim = ""; } });
  on("popupWindowOpened", e => {                     // 页面 window.open（登录弹窗等）：当成新标签
    const parent = brByWid(e.parentId), t = brNewTab(e.url || "");
    t.wid = e.id; t.vis = !!e.visible; t.desk = !!(parent && parent.desk);
    BR.tabs.splice(Math.max(0, BR.tabs.indexOf(parent)) + 1, 0, t);
    if (BR.tabs.length > BR_MAX) { const old = BR.tabs.findIndex(x => x !== t && x !== parent); if (old >= 0) brDrop(old); }
    BR.cur = BR.tabs.indexOf(t);
    const pg = curPage();
    if (pg && pg.key === "browser") draw(pg);
    brSync();
  });
}
function brHistAdd(url, title) {
  if (!url || /^(about|data|blob):/.test(url)) return;
  const h = brHist[0];
  if (h && h.u === url) { if (title) h.t = title; }
  else brHist.unshift({ u: url, t: title || "", at: Date.now() });
  brHist.length = Math.min(brHist.length, 300);
  store("br_hist", JSON.stringify(brHist));
}

// ---- 原生 WebView 的摆放：该不该显示、在哪
function brRect() {
  const v = document.getElementById("brView");
  if (!v) return null;
  const b = v.getBoundingClientRect();
  if (b.width < 10 || b.height < 10) return null;
  const r = { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  r.key = `${r.x},${r.y},${r.w},${r.h}`;
  return r;
}
function brWant() {                                  // 原生 WebView 此刻该不该露出来：当前页是浏览器、没有任何东西盖在上面
  const pg = curPage();
  return !!pg && pg.key === "browser" && !BR.mode && !dwOn && !sheetKind && $("#xy").hidden && !popCtx && !slideEnd && $("#login").hidden && !$("#viewer").classList.contains("on");
}
let brSyncing = false;
async function brSync() {
  if (brSyncing || !IAB || BR.broken || !BR.ready) return;
  brSyncing = true;
  try {
    const want = brWant(), act = brCur(), r = want ? brRect() : null;
    for (const t of BR.tabs) {
      if (!t.wid) continue;
      const show = !!r && t === act;
      if (show) {
        if (t.dim !== r.key) { await IAB.updateDimensions({ id: t.wid, x: r.x, y: r.y, width: r.w, height: r.h }); t.dim = r.key; }
        if (!t.vis) { await IAB.show({ id: t.wid }); t.vis = true; }
      } else if (t.vis) { await IAB.hide({ id: t.wid }); t.vis = false; }
    }
    if (r && act && act.url && !act.wid && !act.opening && !act.err) await brOpenNative(act, r);
    BR.fails = 0;
  } catch (e) { brFail(e); }
  brSyncing = false;
}
setInterval(() => { if (IAB && BR.ready && (BR.tabs.some(t => t.wid) || (curPage() && curPage().key === "browser"))) brSync(); }, 250);
async function brOpenNative(t, r) {
  t.opening = true;
  try {
    const o = { url: t.url, x: r.x, y: r.y, width: r.w, height: r.h, toolbarType: "blank", isAnimated: false, backgroundColor: "white",
      handleDownloads: true, downloadPreview: "systemPreview",        // 网页触发的下载：iOS 先存到临时目录、弹系统预览（有分享 / 存到「文件」）
      enableReloadGesture: true, openBlankTargetInWebView: true, hiddenPopupWindow: true };
    if (t.desk) { o.preferredContentMode = "desktop"; o.customUserAgent = BR_UA; }
    const { id } = await IAB.openWebView(o);
    t.wid = id; t.vis = true; t.dim = r.key; t.used = Date.now();
    brLive(t);
  } finally { t.opening = false; }
}
function brLive(keep) {                              // 活着的原生 WebView 太多就卸掉最久没看的（地址、标题留着）
  const alive = BR.tabs.filter(t => t.wid && t !== keep).sort((a, b) => a.used - b.used);
  while (alive.length + 1 > BR_LIVE) {
    const t = alive.shift();
    IAB.close({ id: t.wid }).catch(() => {});
    t.wid = null; t.vis = false; t.dim = "";
  }
}
function brDrop(i) {                                 // 关掉第 i 个标签（原生的一起关）
  const t = BR.tabs[i];
  if (!t) return;
  if (t.wid) IAB.close({ id: t.wid }).catch(() => {});
  BR.tabs.splice(i, 1);
  if (!BR.tabs.length) BR.tabs.push(brNewTab(""));
  BR.cur = Math.max(0, Math.min(BR.cur > i ? BR.cur - 1 : BR.cur, BR.tabs.length - 1));
  brSave();
}
async function brSnap() {                            // 给标签总览 / 菜单后面垫的截图（缩小成小 JPEG，8 个标签不占内存）
  const t = brCur();
  if (!IAB || !t || !t.wid || !t.vis) return;
  try {
    const s = await IAB.takeScreenshot({ id: t.wid });
    const src = s.dataUrl || (s.base64 ? "data:image/png;base64," + s.base64 : "");
    if (!src) return;
    t.shot = await new Promise(res => {
      const im = new Image();
      im.onload = () => { const c = document.createElement("canvas"); c.width = 260; c.height = Math.round(260 * im.height / im.width); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", .6)); };
      im.onerror = () => res("");
      im.src = src;
    });
    const v = document.getElementById("brView");
    if (v && t.shot && !BR.mode) v.style.backgroundImage = `url(${t.shot})`;
  } catch (e) { /* 截不到就算了 */ }
}

// ---- 页面
function brPageGo(fn) { const pg = curPage(); if (pg && pg.key === "browser") { fn(pg); brSync(); } }
function brTabsHtml() {
  return `<div class="br-tabs">${BR.tabs.map((t, i) => `<div class="br-card${i === BR.cur ? " on" : ""}" data-act="brsel:${i}">` +
    `<div class="br-ch"><span>${esc(t.title || (t.url ? brHost(t.url) : "新标签页"))}</span><button class="br-cx" data-act="brdrop:${i}" aria-label="关闭">${ico("x")}</button></div>` +
    `<div class="br-shot"${t.shot ? ` style="background-image:url(${t.shot})"` : ""}>${t.shot ? "" : `<b>${esc((brHost(t.url) || "＋").slice(0, 1).toUpperCase())}</b>`}</div></div>`).join("")}</div>`;
}
function brStartHtml() {
  const tile = (name, url, sub) => `<button class="br-tile" data-act="bropenu" data-u="${esc(url)}"><span class="br-fav">${esc((name || brHost(url)).slice(0, 1).toUpperCase())}</span><span class="br-tn">${esc(name || brHost(url))}</span></button>`;
  const sys = BR.sys && BR.sys.list ? BR.sys.list.map(x => tile(x.name, sysUrl({ mount: x.mount, path: x.path }))).join("") : "";
  return `<div class="br-start"><div class="br-sec">我的书签</div>` +
    (brBm.length ? `<div class="br-grid">${brBm.map(b => tile(b.t, b.u)).join("")}</div>` : '<div class="fs-note">还没有书签：打开网页后，菜单里「加入书签」。</div>') +
    `<div class="br-sec">服务器上的系统</div>${sys ? `<div class="br-grid">${sys}</div>` : '<div class="fs-note">' + (BR.sys ? "没取到系统列表" : "正在读取…") + "</div>"}</div>`;
}
function brHtml() {
  const t = brCur(), tabs = BR.mode === "tabs";
  const view = tabs ? brTabsHtml() : !t.url ? brStartHtml() : t.err ? `<div class="br-err">${emptyHtml("globe", "页面没打开", "网址可能不对，或者这个网站现在连不上；点下面的刷新再试")}</div>` : "";
  const btn = (act, ic, cls, label) => `<button class="br-btn ${cls || ""}" data-act="${act}" aria-label="${label}">${ico(ic)}</button>`;
  return `<div class="br"><div class="br-top">${tabs ? `<div class="br-title">${BR.tabs.length} 个标签页</div>` :
    `<div class="br-addr"><span class="br-si">${ico("search")}</span><input id="brUrl" type="text" inputmode="url" enterkeyhint="go" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="搜索或输入网址" value="${esc(brShownUrl(t))}">` +
    `<button class="br-rl" data-act="brreload" aria-label="刷新">${ico(t.load ? "x" : "repeat")}</button></div><div class="br-prog"><i></i></div>`}</div>` +
    `<div class="br-view" id="brView"${t.shot && !tabs ? ` style="background-image:url(${t.shot})"` : ""}>${view}<div class="br-sug" id="brSug" hidden></div></div>` +
    `<div class="br-bot">${tabs ? `<button class="br-wide" data-act="brnew">${ico("plus")}<span>新标签页</span></button><button class="br-wide primary" data-act="brdone"><span>完成</span></button>` :
      btn("brback", "back", "", "后退") + btn("brfwd", "chev", "", "前进") + `<button class="br-btn br-n" data-act="brtabs" aria-label="标签页"><i>${BR.tabs.length}</i></button>` +
      btn("brmenu", "more", "", "菜单") + btn("brclose", "x", "", "关闭浏览器")}</div></div>`;
}
const brShownUrl = t => t.url ? (/^https?:/.test(t.url) ? brHost(t.url) + (t.title ? "" : "") : t.url) : "";
function brUrlBar() {                                // 导航 / 标题变了：只改地址栏文字，不整页重画（重画会丢掉输入框的焦点）
  const i = document.getElementById("brUrl"), t = brCur();
  if (i && t && document.activeElement !== i) i.value = brShownUrl(t);
}
function brUpdBar() {                                // 加载状态：进度条、刷新 / 停止图标
  const pg = curPage();
  if (!pg || pg.key !== "browser") return;
  const t = brCur(), p = pg.el.querySelector(".br-prog"), rl = pg.el.querySelector(".br-rl");
  if (p) { p.classList.toggle("on", BR.prog > 0 && BR.prog < 1); p.firstElementChild.style.width = Math.round((BR.prog || 0) * 100) + "%"; }
  if (rl && t) rl.innerHTML = ico(t.load ? "x" : "repeat");
  brUrlBar();
}
async function brLoadSys(pg) {
  if (BR.sys && BR.sys.list) return;
  try { BR.sys = await q("sys"); sysPorts = BR.sys.ports || sysPorts; } catch (e) { BR.sys = { err: true }; }
  const cur = curPage();
  if (cur === pg && !BR.mode && !brCur().url) draw(pg);
}
PAGES.browser = {
  ctx: "br", cls: "br-page", noSwipe: true, title: () => "浏览器",
  html: () => { brEnsure(); return brHtml(); },
  load(pg) { brEnsure(); if (!brCur().url) brLoadSys(pg); brSync(); },
  onBack(pg) { if (BR.mode) { BR.mode = ""; draw(pg); brSync(); return true; } return false; },
  onLeave() { BR.mode = ""; brSync(); },
};
// 地址栏：点进去 = 全选 + 联想（藏起原生网页，联想盖在上面）；回车 = 打开
function brSug(q_) {
  const s = q_.trim().toLowerCase(), rows = [];
  if (q_.trim()) rows.push({ u: q_.trim(), t: /^[a-z]+:\/\/|^[^\s/]+\.[a-z]{2,}/i.test(q_.trim()) ? "打开 " + q_.trim() : "搜索「" + q_.trim() + "」", main: true });
  const seen = new Set();
  for (const x of [...brBm.map(b => ({ u: b.u, t: b.t, bm: true })), ...brHist]) {
    if (seen.has(x.u) || (s && !(x.u.toLowerCase().includes(s) || (x.t || "").toLowerCase().includes(s)))) continue;
    seen.add(x.u); rows.push(x);
    if (rows.length >= 8) break;
  }
  return rows.map(r => `<button class="row br-sr" data-u="${esc(r.u)}"><span class="r-ic">${ico(r.main ? "search" : r.bm ? "book" : "clock")}</span><span class="r-main"><span class="r-t">${esc(r.t || brHost(r.u))}</span>${r.main ? "" : `<span class="r-s">${esc(r.u)}</span>`}</span></button>`).join("");
}
function brSugShow(v) {
  const box = document.getElementById("brSug");
  if (!box) return;
  box.innerHTML = brSug(v);
  box.hidden = false;
}
document.addEventListener("focusin", e => {
  if (e.target.id !== "brUrl") return;
  BR.mode = "addr";
  const t = brCur();
  e.target.value = t && t.url ? t.url : "";
  setTimeout(() => e.target.select(), 30);
  brSnap();
  brSugShow(e.target.value === (t && t.url) ? "" : e.target.value);
  brSync();
});
document.addEventListener("input", e => { if (e.target.id === "brUrl") brSugShow(e.target.value); });
document.addEventListener("focusout", e => {
  if (e.target.id !== "brUrl") return;
  setTimeout(() => {
    if (BR.mode !== "addr" || document.activeElement === e.target) return;
    BR.mode = "";
    const box = document.getElementById("brSug");
    if (box) box.hidden = true;
    brUrlBar(); brSync();
  }, 120);
});
document.addEventListener("keydown", e => {
  if (e.target.id !== "brUrl" || e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  const v = e.target.value;
  e.target.blur();
  brGoto(v);
});
document.addEventListener("pointerdown", e => {      // 联想：按下就办（不等 click，不然输入框先失焦、联想先消失）
  const r = e.target.closest && e.target.closest(".br-sr");
  if (!r) return;
  e.preventDefault();
  brGoto(r.dataset.u);
});
async function brGoto(input) {
  const url = await brResolve(input);
  if (!url) return;
  const t = brCur();
  t.url = url; t.err = false; t.title = ""; t.shot = ""; t.used = Date.now();
  const desk = brIsSys(url);
  BR.mode = "";
  const pg = curPage();
  if (t.wid && !!t.desk === desk) { IAB.setUrl({ id: t.wid, url }).catch(e => brFail(e)); }
  else { if (t.wid) { IAB.close({ id: t.wid }).catch(() => {}); t.wid = null; t.vis = false; t.dim = ""; } t.desk = desk; }
  brSave();
  if (pg && pg.key === "browser") { draw(pg); brSync(); }
}
const brSheetRow = (act, ic, t, sub, extra) => `<button class="row" data-act="${act}"><span class="r-ic">${ico(ic)}</span><span class="r-main"><span class="r-t">${t}</span>${sub ? `<span class="r-s">${esc(sub)}</span>` : ""}</span>${extra || ""}</button>`;
async function brMenu() {
  await brSnap();
  const t = brCur(), has = !!t.url, bm = has && brBm.some(b => b.u === t.url);
  openSheet("brmenu", `<div class="sh-head"><b>${esc(t.title || (has ? brHost(t.url) : "浏览器"))}</b><span>${esc(has ? t.url : "还没有打开网页")}</span></div><div class="group">` +
    brSheetRow("brnew", "plus", "新标签页") +
    (has ? brSheetRow("brreload", "repeat", "刷新") + brSheetRow("brdesk", "gauge", "电脑版网站", "按 1280 宽的电脑页面排版（个别网站可能不完美）", `<span class="sw${t.desk ? " on" : ""}"><i></i></span>`) +
      brSheetRow("brbm", "book", bm ? "取消书签" : "加入书签") + brSheetRow("brcopy", "copy", "复制网址") + brSheetRow("brsys", "globe", "用系统浏览器打开") : "") +
    `</div><div class="group">` + brSheetRow("brbmlist", "book", "书签", brBm.length + " 个") + brSheetRow("brhist", "clock", "历史记录") +
    brSheetRow("brengine", "search", "搜索引擎", BR_ENGINES[brSet.engine][0] + "（点一下换下一个）") +
    brSheetRow("brclear", "power", BR.clearArm ? "再点一次，确认清除" : "清除网站数据", BR.clearArm ? "所有网站的登录状态、缓存都会清掉" : "登录状态、缓存、本地存储") + "</div>");
}
Object.assign(ACT, {
  brsel: i => { BR.cur = +i; BR.mode = ""; const t = brCur(); t.used = Date.now(); brSave(); brPageGo(pg => draw(pg)); },
  brdrop: (i, t, e) => { e.stopPropagation(); brDrop(+i); brPageGo(pg => draw(pg)); },
  brdone: () => { BR.mode = ""; brPageGo(pg => draw(pg)); },
  brtabs: async () => { await brSnap(); BR.mode = "tabs"; brPageGo(pg => draw(pg)); },
  brnew: () => {
    closeSheet();
    if (BR.tabs.length >= BR_MAX) { hint("标签页满了（最多 " + BR_MAX + " 个），先关一个"); return; }
    const nt = brNewTab(); BR.tabs.push(nt); BR.cur = BR.tabs.length - 1; BR.mode = ""; brSave();
    brPageGo(pg => { draw(pg); brLoadSys(pg); });
  },
  bropenu: (_, t) => brGoto(t.dataset.u),
  brback: () => { const t = brCur(); if (t && t.wid) IAB.goBack({ id: t.wid }).catch(() => {}); },
  brfwd: () => { const t = brCur(); if (t && t.wid) IAB.executeScript({ id: t.wid, code: "history.forward()" }).catch(() => {}); },
  brreload: () => {
    closeSheet();
    const t = brCur();
    if (!t || !t.url) return;
    if (t.load && t.wid) { IAB.executeScript({ id: t.wid, code: "window.stop()" }).catch(() => {}); return; }       // 加载中点 ✕ = 停止
    t.err = false;
    if (t.wid) IAB.reload({ id: t.wid }).catch(() => {});
    brPageGo(pg => draw(pg));
  },
  brclose: () => { if (!back()) { /* 栈底没有可退的（不会发生：浏览器总在 Claude 上面） */ } },
  brmenu: () => { BR.clearArm = false; brMenu(); },
  brdesk: () => {                                    // 电脑版 ⇄ 手机版：换浏览器标识要重开原生 WebView（地址留着）
    closeSheet();
    const t = brCur();
    t.desk = !t.desk;
    if (t.wid) { IAB.close({ id: t.wid }).catch(() => {}); t.wid = null; t.vis = false; t.dim = ""; }
    brSave(); brPageGo(pg => draw(pg));
  },
  brbm: () => {
    closeSheet();
    const t = brCur(), i = brBm.findIndex(b => b.u === t.url);
    if (i >= 0) brBm.splice(i, 1); else brBm.unshift({ u: t.url, t: t.title || brHost(t.url) });
    store("br_bm", JSON.stringify(brBm));
  },
  brcopy: () => { closeSheet(); const t = brCur(); if (t && t.url) copy(t.url); },
  brsys: () => { closeSheet(); const t = brCur(); if (t && t.url) window.open(t.url, "_blank"); },
  brengine: () => {
    const k = Object.keys(BR_ENGINES);
    brSet.engine = k[(k.indexOf(brSet.engine) + 1) % k.length];
    store("br_set", JSON.stringify(brSet));
    brMenu();
  },
  brbmlist: () => {
    openSheet("brbm", `<div class="sh-head"><b>书签</b><span>点一下打开；右边 ✕ 删除</span></div>` + (brBm.length ? `<div class="group">${brBm.map((b, i) =>
      `<div class="row"><button class="r-main" data-act="bropens" data-u="${esc(b.u)}"><span class="r-t">${esc(b.t)}</span><span class="r-s">${esc(b.u)}</span></button><button class="chip" data-act="brbmdel:${i}">${ico("x")}</button></div>`).join("")}</div>` : '<div class="fs-note">还没有书签。</div>'));
  },
  brbmdel: i => { brBm.splice(+i, 1); store("br_bm", JSON.stringify(brBm)); ACT.brbmlist(); },
  brhist: () => {
    openSheet("brhist", `<div class="sh-head"><b>历史记录</b><span>最近 ${brHist.length} 条</span></div>` + (brHist.length ? `<div class="group">${brHist.slice(0, 100).map(h =>
      `<button class="row" data-act="bropens" data-u="${esc(h.u)}"><span class="r-main"><span class="r-t">${esc(h.t || brHost(h.u))}</span><span class="r-s">${esc(h.u)}</span></span></button>`).join("")}</div>
      <button class="btn" style="width:100%;margin-top:14px" data-act="brhistclr">清空历史</button>` : '<div class="fs-note">还没有历史记录。</div>'));
  },
  brhistclr: () => { brHist = []; store("br_hist", "[]"); closeSheet(); },
  bropens: (_, t) => { closeSheet(); brGoto(t.dataset.u); },
  async brclear() {                                  // 两步：第一下变「再点一次」，第二下才真清
    if (!BR.clearArm) { BR.clearArm = true; brMenu(); return; }
    BR.clearArm = false;
    closeSheet();
    try { await IAB.clearAllBrowsingData(); BR.tabs.forEach(t => { if (t.wid) IAB.reload({ id: t.wid }).catch(() => {}); }); }
    catch (e) { hint("没清掉：" + e.message); }
  },
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if ($("#viewer").classList.contains("on")) $("#viewer").classList.remove("on");
  else if (popCtx) closePop();
  else if (sheetKind) closeSheet();
  else if (dwOn) closeDrawer();
  else back();
});
document.addEventListener("keydown", e => {               // 历史对话的搜索框：回车搜
  if (e.target && e.target.id === "sessQ" && e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); ACT.sessq(); e.target.blur(); }
});
// 对话 / 文档里的 http 链接（2026-10-27）：指向服务器本机端口的（127.0.0.1:194xx，手机够不着）改走「系统」页的反代，其余交给系统浏览器
let sysPorts = null;
async function openLink(url) {
  let u;
  try { u = new URL(url); } catch (e) { return; }
  if (isLoopback(u.hostname)) {                      // 本机端口：按「系统页」的电脑版排版看
    if (!sysPorts) { try { sysPorts = (await q("sys")).ports || {}; } catch (e) { hint(e.message); return; } }
    const mount = sysPorts[u.port];
    if (mount) go("sysView", { mount, path: u.pathname + u.search + u.hash, name: "服务器 :" + u.port });
    else hint(`服务器上 ${u.port} 端口的页面没登记在「系统」页里，手机打不开`);
    return;
  }
  brOpen(url);                                       // App 内浏览器（没有这个模块 / 出错时 brOpen 自己退回系统浏览器）
}
document.addEventListener("click", e => {
  const a = e.target.closest && e.target.closest(".md a[href], .bub a[href], .article a[href]");
  if (!a || !/^https?:/i.test(a.getAttribute("href") || "")) return;
  e.preventDefault(); e.stopPropagation();
  hap("light");
  openLink(a.href);
}, true);
document.addEventListener("click", e => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  e.preventDefault();
  const a = t.dataset.act, i = a.indexOf(":");
  const name = i < 0 ? a : a.slice(0, i), arg = i < 0 ? "" : a.slice(i + 1);
  if (ACT[name]) { hap("light"); ACT[name](arg, t, e); }
});
// 按下去的样子（真正的动作在 click）
(function pressFx() {
  let t = null, x0 = 0, y0 = 0;
  const clear = () => { if (t) { const e = t; setTimeout(() => e.classList.remove("pressed"), 90); } t = null; };
  document.addEventListener("pointerdown", e => { t = e.target.closest("[data-act], .cmp-btn, .cmp-send, .mo"); if (!t) return; x0 = e.clientX; y0 = e.clientY; t.classList.add("pressed"); }, true);
  document.addEventListener("pointermove", e => { if (t && Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) > 10) clear(); }, { passive: true });
  document.addEventListener("pointerup", clear);
  document.addEventListener("pointercancel", clear);
  document.addEventListener("contextmenu", e => { if (!e.target.closest("textarea, input")) e.preventDefault(); });
})();
$("#viewer").addEventListener("click", () => $("#viewer").classList.remove("on"));

function copy(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).catch(() => copyOld(text)); return; } } catch (e) { /* 走老办法 */ }
  copyOld(text);
}
function copyOld(text) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (e) { /* 复制不了 */ }
  ta.remove();
}

// 长按气泡：复制 / 朗读
let popCtx = null, lpTimer = 0, lpX = 0, lpY = 0;
document.addEventListener("pointerdown", e => {
  const b = e.target.closest(".bub[data-i]");
  if (!b || e.target.closest("a, button, img")) return;
  lpX = e.clientX; lpY = e.clientY;
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => openPop(b), 480);
}, true);
document.addEventListener("pointermove", e => { if (Math.abs(e.clientX - lpX) + Math.abs(e.clientY - lpY) > 8) clearTimeout(lpTimer); }, { passive: true });
document.addEventListener("pointerup", () => clearTimeout(lpTimer));
document.addEventListener("pointercancel", () => clearTimeout(lpTimer));
function openPop(b) {
  const owner = curPage();
  const text = owner && owner.raw[+b.dataset.i];
  if (text == null) return;
  hap("medium");
  popCtx = { text, who: b.dataset.who || "", b };
  b.classList.add("held");
  const p = $("#pop");
  p.innerHTML = `<button data-act="pop:copy">${ico("copy")}<span>复制</span></button>` + (b.dataset.who ? `<button data-act="pop:speak">${ico("speak")}<span>朗读</span></button>` : "");
  const r = b.getBoundingClientRect();
  p.classList.add("on");
  const w = p.offsetWidth, h = p.offsetHeight;
  const x = Math.max(10, Math.min(innerWidth - w - 10, r.left + r.width / 2 - w / 2));
  const y = r.top - h - 10 > 60 ? r.top - h - 10 : Math.min(innerHeight - h - 20, r.bottom + 10);
  p.style.left = x + "px"; p.style.top = y + "px";
}
function closePop() { $("#pop").classList.remove("on"); if (popCtx) popCtx.b.classList.remove("held"); popCtx = null; }
document.addEventListener("pointerdown", e => { if (popCtx && !e.target.closest("#pop")) closePop(); }, true);
document.addEventListener("scroll", () => { if (popCtx) closePop(); }, true);
async function popDo(k) {
  const c = popCtx;
  closePop();
  if (!c) return;
  if (k === "copy") copy(c.text);                    // 点「复制」本身震一下，不弹「已复制」
  if (k === "speak") { try { await q("speak", { text: c.text, who: c.who }); } catch (e) { hint(e.message); } }
}

// ---------------------------------------------------------------- 底部弹层：模型、连接设置、记忆、定时任务
let sheetKind = null;
function openSheet(kind, html) {
  sheetKind = kind;
  $("#sheetBody").innerHTML = html;
  $("#sheet").classList.add("on");
  $("#scrim").classList.add("on");
}
function closeSheet() {
  sheetKind = null;
  $("#sheet").classList.remove("on");
  $("#scrim").classList.remove("on");
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest("#sheet")) document.activeElement.blur();
}
$("#scrim").addEventListener("click", closeSheet);
(function sheetDrag() {
  const sh = $("#sheet");
  let y0 = 0, dy = 0, on = false;
  sh.addEventListener("pointerdown", e => {
    if (!e.target.closest(".grab, .sh-head")) return;
    on = true; y0 = e.clientY; dy = 0; sh.classList.add("drag");
    sh.setPointerCapture(e.pointerId);
  });
  sh.addEventListener("pointermove", e => { if (!on) return; dy = Math.max(0, e.clientY - y0); sh.style.transform = `translateY(${dy}px)`; });
  const up = () => { if (!on) return; on = false; sh.classList.remove("drag"); sh.style.transform = ""; if (dy > 90) closeSheet(); };
  sh.addEventListener("pointerup", up);
  sh.addEventListener("pointercancel", up);
})();

// 额度（2026-10-27，用户：所选模型的额度要自动更新，不用再点按钮）：服务器 op quota 一次给全（缓存 60 秒），
// 打开模型弹层就取、弹层开着每分钟取、平时每 5 分钟取、Claude 收工后立刻取；额度行挂在各家模型名下（.qline），取到就原地换内容
let quotaD = null, quotaT = 0, quotaBusy = false;
async function quotaLoad(fresh) {
  if (quotaBusy) return;
  quotaBusy = true;
  try { quotaD = await q("quota", fresh ? { fresh: 1 } : {}); quotaT = Date.now(); quotaUpd(); } catch (e) { /* 没连上：下次再来 */ }
  quotaBusy = false;
}
const qRow = (k, v, bad) => `<div class="qrow${bad ? " bad" : ""}"><span>${k}</span><b>${v}</b></div>`;
function qInner(kind) {
  const d = quotaD;
  if (!d) return qRow("额度", "查询中…");
  if (kind === "claude") {
    const c = d.claude || {}, w = (n, name) => c[n] ? qRow(name, `剩 ${c[n].left}%<i>${c[n].reset} 重置</i>`, c[n].left <= 10) : "";
    return (w("five", "5 小时内") + w("week", "本周")) + (c.err ? qRow("额度", esc(c.err), true) : "") || qRow("额度", "暂无数据");
  }
  if (kind === "deepseek") {
    const b = d.deepseek;
    if (!b) return qRow("余额", "没配密钥");
    const n = parseFloat(b.balance);
    return (b.balance != null ? qRow("余额", `${esc(b.balance)} ${esc(b.cur || "")}${n <= 0 ? "<i>已欠费</i>" : ""}`, n <= 0) : "") + (b.err ? qRow("余额", esc(b.err) + "，查不到", true) : "");
  }
  if (kind === "oc") {
    const o = d.oc || {};
    return qRow("免费档", o.limited ? `被限速了<i>最近一次 ${o.last}</i>` : "没有限速" + (o.last ? `<i>上次 ${o.last}</i>` : ""), o.limited);
  }
  if (kind === "ocb") return qRow("免费档", "跑在百度云上，没有额度数据");
  const t = d.today || {};
  if (kind === "qwen") return qRow("百炼（通义）", `今天语音识别 ${t.asr || 0} 次<i>官方额度查不到</i>`);
  if (kind === "xz") return qRow("豆包", `今天小智回答 ${t.xz || 0} 次<i>官方额度查不到</i>`);
  return "";
}
const qLine = kind => `<div class="qline" data-q="${kind}">${qInner(kind)}</div>`;
// 顶栏模型名旁边的一小段（只给 Claude / DeepSeek / OpenCode 本机）
function qLite(kind) {
  const d = quotaD;
  if (!d) return "";
  if (kind === "claude") return d.claude && d.claude.five ? `5小时剩 ${d.claude.five.left}%` : "";
  if (kind === "deepseek") return d.deepseek && d.deepseek.balance != null ? `余额 ${d.deepseek.balance}` : "";
  if (kind === "oc") return d.oc && d.oc.limited ? "被限速" : "";
  return "";
}
const qLiteHtml = kind => { const t = qLite(kind); return t ? `<span class="qlite"> · ${esc(t)}</span>` : ""; };
function quotaUpd() {
  document.querySelectorAll(".qline").forEach(e => { e.innerHTML = qInner(e.dataset.q); });
  const pg = curPage();
  if (pg && pg.def.sub && ["claude", "oc", "xz"].includes(pg.key)) $("#navSub").innerHTML = pg.def.sub(pg);
}
setInterval(() => {
  if (document.hidden || !online) return;
  if (Date.now() - quotaT > (sheetKind === "model" ? 60e3 : 300e3)) quotaLoad();
}, 15000);

async function openModels() {
  openSheet("model", `<div class="sh-head"><b>Claude 的模型</b><span>换一家会新开一个会话；同一家换型号接着聊</span></div><div id="mdlBox">${LOADING}</div>`);
  quotaLoad();
  try {
    const d = await q("c_models");
    $("#mdlBox").innerHTML = d.list.map(m => `<div class="sh-sec">${esc(m.name)}</div>${qLine(m.m === "deepseek" ? "deepseek" : "claude")}<div class="group">${m.subs.map(([k, v]) => {
      const cur = d.cur === m.m && m.sub === k;
      return `<button class="row${cur ? " cur" : ""}" data-act="model:${m.m}|${k}"><span class="r-main"><span class="r-t">${esc(m.name)} ${esc(v)}</span></span>${cur ? `<span class="check">${ico("check")}</span>` : ""}</button>`;
    }).join("")}</div>`).join("");
  } catch (e) { $("#mdlBox").textContent = e.message; }
}

function openSettings() {
  const sw = (act, on, title, sub) => `<button class="row sw-row" data-act="${act}"><span class="r-main"><span class="r-t">${title}</span><span class="r-s">${sub}</span></span>
    <span class="sw${on ? " on" : ""}"><i></i></span></button>`;
  const native = !!Link;
  openSheet("settings", `<div class="sh-head"><b>设置</b><span class="conn-t"></span></div>
    <div class="group"><div class="row"><span class="r-main"><span class="r-t">${esc(cfg.user || "未登录")}</span><span class="r-s">账号 · 这台是 ${esc(DEV_LABEL)}</span></span>
      <button class="chip" data-act="pwopen">改密码</button><button class="chip danger" data-act="logout">退出</button></div>
      <div id="pwBox" class="pw-box" hidden><input id="pwOld" type="password" placeholder="原密码" autocomplete="current-password">
        <input id="pwNew" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password"><button class="btn primary" data-act="pwsave">保存</button></div></div>
    <div class="group">${sw("artog", autoRead, "自动朗读", "小芽、小智的回复自己念出来（小芽通话里也是）；首页右上角的喇叭也能开关")}</div>
    <div class="group${native ? "" : " dim"}">` +
      sw("bgtog", bgOn, "后台运行", native ? "锁屏、切到别的 App 时，小芽通话和 Claude 干活照常进行" : "要装新安装包才有") +
      sw("notetog", noteOn, "通知", native ? "在后台时，Claude 做完、小芽小智回话会弹通知" : "要装新安装包才有") + `</div>
    <div class="group"><button class="row" data-act="go:uplog"><span class="r-main"><span class="r-t">更新记录</span><span class="r-s">每次更新改了什么（git 提交）、现在的版本、怎么更新</span></span><span class="chev">${ico("chev")}</span></button></div>
    <div class="sh-sec">服务器地址（一行一个，连不上按顺序换下一个）</div>
    <div class="field"><textarea id="sServers" rows="2" spellcheck="false"></textarea></div>
    <button class="btn" style="width:100%" data-act="saveSettings">保存并重连</button>
    <div class="meta">设备号 ${esc(DEV_ID)} · 界面 ${esc(window.UI_VER || "开发版")}（${esc(window.UI_FROM || "内置")}）· 安装包 v${window.SHELL_V || 1}${native ? "" : "（没有原生模块）"}</div>`);
  $("#sServers").value = cfg.servers.join("\n");
  updConn();
}
function saveSettings() {
  const s = $("#sServers").value.split(/\s+/).filter(Boolean);
  if (!s.length) return;
  cfg.servers = s;
  saveCfg();
  closeSheet();
  srv = 0;
  disconnect();
  connect();
}

// ---------------------------------------------------------------- 返回：左边缘右滑（上一页跟着手出来）、安卓返回键
(function edgeSwipe() {
  let d = null;
  stage.addEventListener("pointerdown", e => {
    if (e.clientX > 22 || stack.length < 2 || curPage().sec || curPage().def.noSwipe || sheetKind || ptt || pttHeld) return;     // 一级页上的边缘右滑拉侧栏（下面 drawerDrag）；浏览器页边缘滑动留给网页自己的前进后退
    settle();
    const cur = curPage(), prev = stack[stack.length - 2];
    prev.el.classList.remove("off");
    prev.el.style.zIndex = 1; cur.el.style.zIndex = 3; cur.el.style.boxShadow = "0 0 40px rgba(0,0,0,.28)";
    d = { x0: e.clientX, x: e.clientX, t: performance.now(), v: 0, w: stage.clientWidth, cur, prev };
    stage.setPointerCapture(e.pointerId);
    move(0);
  });
  function move(dx) {
    d.cur.el.style.transform = `translateX(${dx}px)`;
    d.prev.el.style.transform = `translateX(${-d.w * .3 * (1 - dx / d.w)}px)`;
    d.prev.el.style.opacity = .4 + .6 * dx / d.w;
  }
  stage.addEventListener("pointermove", e => {
    if (!d) return;
    const now = performance.now();
    d.v = (e.clientX - d.x) / Math.max(1, now - d.t);
    d.x = e.clientX; d.t = now;
    move(Math.max(0, e.clientX - d.x0));
  });
  const up = () => {
    if (!d) return;
    const g = d; d = null;
    const dx = Math.max(0, g.x - g.x0);
    if (performance.now() - g.t > 100) g.v = 0;
    if (dx > g.w * .35 || g.v > .45 && dx > 40) {
      hap("light");
      stack.pop();
      chrome(g.prev);
      slide(g.cur.el, g.prev.el, -1, dx, () => g.cur.el.remove());
      if (g.prev.def.onShow) g.prev.def.onShow(g.prev);
    } else {
      const opt = { duration: 300, easing: EASE };
      g.cur.el.animate([{ transform: g.cur.el.style.transform }, { transform: "translateX(0)" }], opt).onfinish = () => {
        g.cur.el.style.transform = ""; g.cur.el.style.boxShadow = ""; g.cur.el.style.zIndex = "";
      };
      g.prev.el.animate([{ transform: g.prev.el.style.transform, opacity: g.prev.el.style.opacity }, { transform: `translateX(${-g.w * .3}px)`, opacity: .4 }], opt).onfinish = () => {
        g.prev.el.classList.add("off"); g.prev.el.style.transform = ""; g.prev.el.style.opacity = ""; g.prev.el.style.zIndex = "";
      };
      g.cur.el.style.transform = "translateX(0)";
    }
  };
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
})();
// 主页：左边缘右滑拉出抽屉（跟着手出来），抽屉开着时往左划收回
(function drawerDrag() {
  const dw = $("#drawer"), pn = $("#dwPanel"), sc = dw.querySelector(".dw-scrim");
  let d = null;
  function pos(x) {
    x = Math.max(0, Math.min(d.w, x));
    pn.style.transform = `translateX(${x - d.w}px)`;
    sc.style.opacity = x / d.w;
  }
  function track(e) {
    const now = performance.now();
    d.v = (e.clientX - d.x) / Math.max(1, now - d.t);
    d.x = e.clientX; d.t = now;
  }
  stage.addEventListener("pointerdown", e => {
    if (e.clientX > 22 || (stack.length > 1 && !curPage().sec) || curPage().def.noSwipe || dwOn || sheetKind || ptt || pttHeld) return;
    pn.innerHTML = drawerHtml(tiles);
    updConn();
    d = { x0: e.clientX, y0: e.clientY, x: e.clientX, t: performance.now(), v: 0, w: pn.offsetWidth, open: false, live: true };
    dw.classList.add("drag");
    stage.setPointerCapture(e.pointerId);
    pos(0);
  });
  dw.addEventListener("pointerdown", e => {
    if (!dwOn) return;
    d = { x0: e.clientX, y0: e.clientY, x: e.clientX, t: performance.now(), v: 0, w: pn.offsetWidth, open: true, live: false, id: e.pointerId };
  });
  const move = e => {
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.live) {                                   // 开着的抽屉：横着划过 8px 才算拖，不然是点按 / 上下滑
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(e.clientY - d.y0)) return;
      d.live = true;
      dw.classList.add("drag");
      try { dw.setPointerCapture(d.id); } catch (err) { /* 指针已经没了 */ }
    }
    track(e);
    pos(d.open ? d.w + dx : dx);
  };
  const up = () => {
    if (!d) return;
    const g = d; d = null;
    if (!g.live) return;
    if (performance.now() - g.t > 100) g.v = 0;
    const dx = g.x - g.x0;
    const open = g.open ? !(-dx > g.w * .35 || g.v < -.45 && dx < -40) : dx > g.w * .35 || g.v > .45 && dx > 40;
    dw.classList.remove("drag");
    pn.style.transform = sc.style.opacity = "";
    if (open && !g.open) { hap("light"); openDrawer(); }
    if (!open && g.open) closeDrawer();
  };
  stage.addEventListener("pointermove", move);
  dw.addEventListener("pointermove", move);
  [stage, dw].forEach(t => { t.addEventListener("pointerup", up); t.addEventListener("pointercancel", up); });
})();
if (AppP) {
  try {
    AppP.addListener("backButton", () => {
      if ($("#viewer").classList.contains("on")) return $("#viewer").classList.remove("on");
      if (popCtx) return closePop();
      if (sheetKind) return closeSheet();
      if (dwOn) return closeDrawer();
      if (pttHeld || ptt) return pttEnd(true);
      if (!$("#xy").hidden) return xyMin();
      if (back()) return;
      (AppP.minimizeApp ? AppP.minimizeApp() : AppP.exitApp()).catch(() => {});
    });
  } catch (e) { /* 插件没装 */ }
}
function barStyle() {
  try { Bars && Bars.setStyle({ style: matchMedia("(prefers-color-scheme: dark)").matches ? "DARK" : "LIGHT" }).catch(() => {}); } catch (e) { /* 没有 */ }
}
barStyle();
try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", barStyle); } catch (e) { /* 老 WebView */ }

// ---------------------------------------------------------------- IMA ADPCM（跟 server.py 的 Recording.feed / audioop 同一套表）
const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97,
  107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484,
  7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
function adpcmDec(st, n) {
  const step = STEP[st.idx];
  let diff = step >> 3;
  if (n & 4) diff += step;
  if (n & 2) diff += step >> 1;
  if (n & 1) diff += step >> 2;
  st.pred = Math.max(-32768, Math.min(32767, n & 8 ? st.pred - diff : st.pred + diff));
  st.idx = Math.max(0, Math.min(88, st.idx + IDX[n]));
  return st.pred;
}
function adpcmEnc(st, s) {
  let step = STEP[st.idx], diff = s - st.pred, n = 0;
  if (diff < 0) { n = 8; diff = -diff; }
  if (diff >= step) { n |= 4; diff -= step; }
  if (diff >= step >> 1) { n |= 2; diff -= step >> 1; }
  if (diff >= step >> 2) n |= 1;
  adpcmDec(st, n);                                   // 编码器跟着解码器走，两头状态一致
  return n;
}
function b64dec(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
function b64enc(a) { let s = ""; for (const b of a) s += String.fromCharCode(b); return btoa(s); }

// ---------------------------------------------------------------- 声音：朗读、提示音
// 有原生 Link 时声音全在原生里（朗读、提示音、录音）：网页这边一个 AudioContext 都不建，免得 WebKit 去改 iOS 的声音会话
let actx = null, gain = null, nSpeak = false;
function ac() {
  if (Link) return null;
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    gain = actx.createGain();
    gain.connect(actx.destination);
  }
  if (actx.state !== "running") actx.resume().catch(() => {});   // iOS 录音时会变成 interrupted，不只是 suspended
  return actx;
}
// 🔴 iOS 只认点击（touchend / click）是用户手势：每次点都把声音通道唤醒一下，按住说话（按下就开录）才录得到声音
["touchend", "click"].forEach(t => document.addEventListener(t, () => ac(), { capture: true, passive: true }));

let sp = null;
window.__pcmLog = null;    // 测试用：设成 [] 就把解出来的朗读 PCM 攒在这里
function spStart(m) {
  spStop(false);
  if (soundOff && call.on) { tx({ t: "sp_stop" }); return; }   // 小芽关着声音：只看文字
  if (m.fmt !== "a16" && m.fmt !== "p24") return;
  const c = ac();
  sp = { n: m.n, fmt: m.fmt, st: { pred: 0, idx: 0 }, t: c.currentTime + 0.15, srcs: new Set() };
}
function spData(m) {
  if (!sp || m.n !== sp.n) return;
  const b = b64dec(m.d), p24 = sp.fmt === "p24", out = new Float32Array(p24 ? b.length >> 1 : b.length * 2);
  if (p24) {                                         // 不压缩：24k 单声道 16 位小端 PCM
    const dv = new DataView(b.buffer);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  } else {
    let j = 0;
    for (const x of b) {                             // 朗读 a16 高半字节在前（audioop）
      out[j++] = adpcmDec(sp.st, x >> 4) / 32768;
      out[j++] = adpcmDec(sp.st, x & 15) / 32768;
    }
  }
  if (window.__pcmLog) window.__pcmLog.push(...out);
  const c = ac(), buf = c.createBuffer(1, out.length, p24 ? 24000 : 16000);
  buf.getChannelData(0).set(out);
  const s = c.createBufferSource();
  s.buffer = buf;
  gain.gain.value = 1;                               // 手机音量用手机自己的音量键（App 里不放音量）
  s.connect(gain);
  sp.t = Math.max(sp.t, c.currentTime + 0.05);
  s.start(sp.t);
  sp.t += buf.duration;
  const cur = sp;
  cur.srcs.add(s);
  s.onended = () => cur.srcs.delete(s);
}
function speaking() { return Link ? nSpeak : !!(sp && actx && actx.currentTime < sp.t); }
function spStop(tell) {
  if (Link) { if (tell && nSpeak) Link.spStop().catch(() => {}); nSpeak = false; return; }
  if (!sp) return;
  for (const s of sp.srcs) try { s.stop(); } catch (e) { /* 还没开始的也停掉 */ }
  sp = null;
  if (tell) tx({ t: "sp_stop" });
}
function spCut() {
  if (Link) { Link.spStop().catch(() => {}); nSpeak = false; xyUpd(); return; }
  spStop(false);
  xyUpd();
}
function beep(k) {
  if (Link) return;
  const c = ac(), tones = k === "err" ? [[220, 0.25]] : k === "start" ? [[660, 0.09], [990, 0.15]] : [[880, 0.08], [1320, 0.12]];
  let t = c.currentTime + 0.02;
  for (const [f, d] of tones) {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = f;
    g.gain.value = 0.15;
    o.connect(g); g.connect(gain);
    o.start(t); o.stop(t + d);
    t += d + 0.04;
  }
}

// ---------------------------------------------------------------- 麦克风：16k → ADPCM → au（按住说话 ptt、小芽常开收音 live 共用一路）
let mic = null, ring = [], ringLen = 0, micIdle = 0, micAec = false;
const PREROLL = 8000;            // 预录 0.5 秒：按下时已经在说的第一个字不吞掉
async function openMic() {
  clearTimeout(micIdle);
  if (Link || mic) return;
  const c = ac();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  if (mic) { stream.getTracks().forEach(t => t.stop()); return; }
  micAec = !!(stream.getAudioTracks()[0] && stream.getAudioTracks()[0].getSettings().echoCancellation);
  const src = c.createMediaStreamSource(stream);
  const proc = c.createScriptProcessor(4096, 1, 1);
  const ratio = c.sampleRate / 16000, mute = c.createGain();
  let acc = 0, accN = 0, pos = 0;
  mute.gain.value = 0;
  proc.onaudioprocess = e => {                       // 降到 16k：按比例把几个点平均成一个（顺带低通）
    const x = e.inputBuffer.getChannelData(0), out = new Int16Array(Math.ceil(x.length / ratio) + 1);
    let n = 0;
    for (let i = 0; i < x.length; i++) {
      acc += x[i]; accN++;
      if (++pos >= ratio) {
        pos -= ratio;
        out[n++] = Math.max(-32768, Math.min(32767, Math.round(acc / accN * 32768)));
        acc = 0; accN = 0;
      }
    }
    onPcm(out.subarray(0, n));
  };
  src.connect(proc);
  proc.connect(mute);            // ScriptProcessor 要接到输出才会跑，接个静音的
  mute.connect(c.destination);
  mic = { stream, src, proc };
}
function closeMic() {
  if (!mic) return;
  mic.proc.onaudioprocess = null;
  mic.src.disconnect();
  mic.proc.disconnect();
  mic.stream.getTracks().forEach(t => t.stop());
  mic = null;
  ring = []; ringLen = 0;
}
function micMaybeIdle() {                            // 没在录也没在通话：20 秒后关麦（不然 iPhone 顶上一直亮着橙点）
  clearTimeout(micIdle);
  micIdle = setTimeout(() => { if (!ptt && !pttHeld && !live && !call.on) closeMic(); }, 20000);
}
function onPcm(p) {
  if (ptt) { ptt.got += p.length; meter(p); sendAudio(ptt, p); return; }
  if (live) { live.got += p.length; if (!call.muted) { meter(p); sendAudio(live, p); } else meter(null); return; }
  ring.push(p); ringLen += p.length;
  while (ring.length > 1 && ringLen - ring[0].length >= PREROLL) ringLen -= ring.shift().length;
}
// 按 20ms（160 字节 = 320 点）整帧发：服务器 LiveSeg 每条 au 按 20ms 一帧切，零头会被丢掉
function sendAudio(r, p) {
  const e = r.enc, out = r.out;
  for (const s of p) {                               // 上传是低半字节在前（server.py Recording.feed）
    const n = adpcmEnc(e, s);
    if (e.half < 0) e.half = n;
    else { out.push(e.half | n << 4); e.half = -1; }
  }
  const k = out.length - out.length % 160;
  if (k) tx({ t: "au", d: b64enc(out.splice(0, k)) });
}
function flush(r) {
  if (r.enc.half >= 0) { r.out.push(r.enc.half); r.enc.half = -1; }
  if (r.out.length) tx({ t: "au", d: b64enc(r.out.splice(0)) });
}
const newEnc = () => ({ enc: { pred: 0, idx: 0, half: -1 }, out: [], got: 0 });

// 音量：每 20ms 一个值排队，录音波形匀速往左走；小芽的球跟着当前音量缩放
let lvQ = [], lvBars = new Array(40).fill(0), lvNow = 0, lastPop = 0;
function meter(p) {
  if (!p) { lvQ.push(0); return; }
  for (let i = 0; i + 320 <= p.length; i += 320) {
    let s = 0;
    for (let j = i; j < i + 320; j++) s += p[j] * p[j];
    const db = 20 * Math.log10(Math.sqrt(s / 320) / 32768 + 1e-6);
    lvQ.push(Math.max(0, Math.min(1, (db + 58) / 46)));
  }
  if (lvQ.length > 40) lvQ.splice(0, lvQ.length - 40);
}
function frame(t) {
  if (lvQ.length && t - lastPop >= 20) {
    lastPop = t;
    do { lvBars.push(lvQ.shift()); lvBars.shift(); } while (lvQ.length > 6);
  } else if (!ptt && !live && t - lastPop > 60) { lvBars.push(0); lvBars.shift(); lastPop = t; }
  const target = (ptt || live) ? lvBars[lvBars.length - 1] : speaking() ? .25 + .2 * Math.sin(t / 140) : 0;
  lvNow += (target - lvNow) * .2;
  if (call.on) document.querySelectorAll("#xy .orb.big, #xyFloat .orb, .callbtn .orb").forEach(o => o.style.setProperty("--lv", lvNow.toFixed(3)));
  if (document.body.classList.contains("recording")) drawWave();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
function drawWave() {
  const cv = $("#wave"), dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#fff";
  const n = lvBars.length, bw = w / n;
  for (let i = 0; i < n; i++) {
    const v = Math.max(.08, lvBars[i]), bh = v * h;
    g.globalAlpha = .45 + .55 * (i / n);
    const x = i * bw + bw * .22, wd = bw * .56;
    g.beginPath();
    if (g.roundRect) g.roundRect(x, (h - bh) / 2, wd, bh, wd / 2); else g.rect(x, (h - bh) / 2, wd, bh);
    g.fill();
  }
  if (ptt) $(".rec-time").textContent = mmss(Date.now() - ptt.t0);
}

// ---------------------------------------------------------------- 按住说话（输入栏里的那条）：按下开录、松开发出、上滑取消
let ptt = null, pttHeld = false, pttY0 = 0, cancelArm = false, recN = 0, pttCmp = null;
const REC_C = { claude: "var(--claude-b)", xz: "var(--xz-b)", xy: "var(--xy-b)", oc: "var(--oc-b)" };
async function pttStart(cmp, y) {
  if (ptt || pttHeld) return;
  ac();
  if (speaking()) spStop(true);
  pttHeld = true; pttY0 = y; pttCmp = cmp;
  setCancel(false);
  document.documentElement.style.setProperty("--rec-c", REC_C[cmp.to] || "var(--xy)");
  $(".rec-time").textContent = "0:00";
  $(".rec-tip").textContent = "松开 发送";
  document.body.classList.add("recording");
  lvBars.fill(0); lvQ = [];
  hap("medium");
  if (Link) {                                        // 原生录：rec 由原生先发、接着发预录的 0.5 秒和后面的音频
    const n = ++recN;
    if (!linkUp) { pttHeld = false; document.body.classList.remove("recording"); hint("还没连上服务器"); return; }
    ptt = Object.assign(newEnc(), { t0: Date.now(), n, to: cmp.to, cmp });
    try { await Link.ptt({ on: true, msg: JSON.stringify({ t: "rec", to: cmp.to, n }) }); } catch (e) {
      ptt = null; pttHeld = false; document.body.classList.remove("recording");
      hint("打不开麦克风" + (e && e.message ? "\n" + e.message : "")); return;
    }
    if (!pttHeld && ptt && ptt.n === n) pttEnd(false);              // 第一次要等授权弹窗，等回来手已经松开了
    setTimeout(() => { if (ptt && ptt.n === n && !ptt.got) hint("麦克风没有声音"); }, 1500);
    return;
  }
  try { await openMic(); } catch (e) {
    pttHeld = false; document.body.classList.remove("recording");
    hint("打不开麦克风" + (e && e.message ? "\n" + e.message : "")); return;
  }
  if (!pttHeld) { document.body.classList.remove("recording"); micMaybeIdle(); return; }   // 第一次要等授权弹窗，等回来手已经松开了
  const n = ++recN;
  if (!tx({ t: "rec", to: cmp.to, n })) { pttHeld = false; document.body.classList.remove("recording"); hint("还没连上服务器"); return; }
  ptt = Object.assign(newEnc(), { t0: Date.now(), n, to: cmp.to, cmp });
  for (const p of ring) sendAudio(ptt, p);
  ring = []; ringLen = 0;
  beep("start");
  setTimeout(() => {
    if (ptt && ptt.n === n && !ptt.got) { hint("麦克风没有声音\n松开后点一下屏幕再试"); ac(); }
  }, 1500);
}
function pttEnd(cancel) {
  if (!pttHeld && !ptt) return;
  pttHeld = false;
  document.body.classList.remove("recording");
  const r = ptt;
  ptt = null;
  micMaybeIdle();
  if (!r) return;
  if (!Link) flush(r);
  const short = Date.now() - r.t0 < 600;
  if (cancel || cancelArm || short) {
    if (Link) Link.ptt({ on: false, msg: JSON.stringify({ t: "rec_cancel" }) }).catch(() => {}); else tx({ t: "rec_cancel" });
    if (short && !cancel && !cancelArm) hint("说话时间太短");
    setCancel(false);
    return;
  }
  setCancel(false);
  const files = r.cmp.takeFiles(r.to);
  const end = { t: "rec_end", files: files.map(f => ({ id: f.id })) };
  if (Link) Link.ptt({ on: false, msg: JSON.stringify(end) }).catch(() => {}); else tx(end);
  addPend(r.to, { n: r.n, text: "", files, st: "asr", cmp: r.cmp });
  if (r.to === "claude" || r.to === "xz" || r.to === "oc") { const pg = curPage(); if (pg) { pg.stick = true; stickBottom(pg); } }
}
function setCancel(on) {
  if (on === cancelArm) return;
  cancelArm = on;
  document.body.classList.toggle("rec-cancel", on);
  $(".rec-tip").textContent = on ? "松开手指，取消发送" : "松开 发送";
  if (on) hap("medium");
}
function onAsr(m) {
  for (const to in pends) {
    const p = pends[to].find(x => x.n === m.n && x.st === "asr");
    if (!p) continue;
    if (m.text) { p.text = m.text; p.st = "sent"; p.t = Date.now(); redrawThread(to); }
    else {
      dropPend(to, p.k);
      if (p.files && p.files.length) p.cmp.restoreFiles(to, p.files);
      hint(m.err || "没听清，再说一次");
    }
  }
}
function onAsrErr(m) {
  for (const to in pends) {
    const p = pends[to].find(x => x.n === m.n);
    if (!p) continue;
    dropPend(to, p.k);
    p.cmp.restoreText(to, m.text || "", p.files);
    hint(m.err);
  }
}

// ---------------------------------------------------------------- 输入栏（一个类，Claude / 小智页底下一个，小芽通话里一个）
function makeComposer() {
  const c = { to: "claude", drafts: {}, el: null };
  c.el = el(`<div class="cmp"><div class="cmp-att"></div><div class="cmp-row">
    <button class="cmp-btn cmp-mode" aria-label="切换打字 / 说话"></button>
    <div class="cmp-mid"><textarea class="cmp-in" rows="1" placeholder="发消息" enterkeyhint="send"></textarea><button class="cmp-hold">按住 说话</button></div>
    <button class="cmp-btn cmp-plus" aria-label="发图片或文件" aria-expanded="false">${ico("plus")}</button><button class="cmp-send">发送</button></div>
    <div class="cmp-more"><div class="mo-in"><button class="mo" data-pick="photos"><span class="mo-ic">${ico("image")}</span>相册</button>` +
    `<button class="mo" data-pick="camera"><span class="mo-ic">${ico("camera")}</span>拍照</button><button class="mo" data-pick="files"><span class="mo-ic">${ico("folder")}</span>文件</button></div></div></div>`);
  c.el.__c = c;
  const ta = c.el.querySelector(".cmp-in"), hold = c.el.querySelector(".cmp-hold"), attBox = c.el.querySelector(".cmp-att");
  const d = () => c.drafts[c.to] || (c.drafts[c.to] = { text: "", atts: [] });
  c.mode = store("cmpMode") || "voice";
  function setMode(m, focus) {
    c.mode = m;
    store("cmpMode", m);
    c.el.dataset.mode = m;
    c.el.querySelector(".cmp-mode").innerHTML = ico(m === "voice" ? "kbd" : "mic");
    if (m === "text" && focus) setTimeout(() => ta.focus(), 30);
    if (m === "voice") ta.blur();
    upd();
  }
  function grow() { ta.style.height = "auto"; ta.style.height = Math.min(136, ta.scrollHeight) + "px"; }
  function upd() {
    d().text = ta.value;
    c.el.classList.toggle("has", (c.mode === "text" && !!ta.value.trim()) || d().atts.some(a => a.st === "ok"));
    grow();
    barSize();
  }
  c.setTo = to => {
    if (c.to !== to) { d().text = ta.value; c.to = to; ta.value = d().text; renderAtt(); }
    c.setMore(false);
    setMode(c.mode, false);
  };
  // 「+」：在输入栏下面就地展开 相册 / 拍照 / 文件，输入栏一直在（跟微信一样）。2026-10-16 用户：原来先弹一层「发送图片或文件」，
  // 点了「图片」再弹系统的三个选项悬在半空、输入栏都不见了，很丑。点输入框、点对话、换页、选好了都收起
  c.setMore = on => {
    if (on === c.el.classList.contains("more")) return;
    c.el.classList.toggle("more", on);
    c.el.querySelector(".cmp-plus").setAttribute("aria-expanded", on);
    if (on) ta.blur();
  };
  ta.addEventListener("input", upd);
  // 键盘上的「发送」键 = 发出去（跟微信一样）；中文输入法还在拼字时的回车不算
  ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); c.send(); } });
  c.el.querySelector(".cmp-mode").addEventListener("click", () => { hap("light"); setMode(c.mode === "voice" ? "text" : "voice", true); if (c.mode === "voice") openMic().then(micMaybeIdle).catch(() => {}); });
  c.el.querySelector(".cmp-plus").addEventListener("click", () => { hap("light"); c.setMore(!c.el.classList.contains("more")); });
  c.el.querySelector(".cmp-more").addEventListener("click", e => { const b = e.target.closest(".mo"); if (b) { hap("light"); c.pick(b.dataset.pick, b); } });
  ta.addEventListener("focus", () => c.setMore(false));
  c.el.querySelector(".cmp-send").addEventListener("click", () => { hap("light"); c.send(); });
  // 按住说话
  hold.addEventListener("pointerdown", e => {
    e.preventDefault();
    c.setMore(false);
    hold.setPointerCapture(e.pointerId);
    hold.classList.add("held");
    pttStart(c, e.clientY);
  });
  hold.addEventListener("pointermove", e => { if (pttHeld) setCancel(pttY0 - e.clientY > 70); });
  const up = e => { hold.classList.remove("held"); if (pttHeld || ptt) pttEnd(e.type === "pointercancel"); };
  hold.addEventListener("pointerup", up);
  hold.addEventListener("pointercancel", up);
  hold.addEventListener("contextmenu", e => e.preventDefault());

  // 附件
  function renderAtt() {
    const atts = d().atts;
    attBox.innerHTML = atts.map(a => (a.kind === "image"
      ? `<div class="ca${a.st === "err" ? " err" : ""}"><img src="${esc(a.url)}" alt="">`
      : `<div class="ca file${a.st === "err" ? " err" : ""}">${ico("file")}<span>${esc(a.name)}</span>`) +
      (a.st === "up" ? `<span class="prog">${a.pct || 0}%</span>` : a.st === "err" ? '<span class="prog">失败</span>' : "") +
      `<button class="x" data-k="${a.k}" aria-label="去掉">${ico("x")}</button></div>`).join("");
    upd();
  }
  attBox.addEventListener("click", e => {
    const x = e.target.closest(".x");
    if (!x) return;
    const dd = d(), a = dd.atts.find(y => y.k === +x.dataset.k);
    if (a && a.xhr) a.xhr.abort();
    dd.atts = dd.atts.filter(y => y.k !== +x.dataset.k);
    renderAtt();
  });
  // 选好的进上面的附件条，跟下一句话一起发，也可以直接点「发送」单发。
  // iPhone 安装包 v4 起相册、文件走原生直接打开系统的选择界面（Link.pick）：网页的 <input type=file> 在 iOS 上一律先弹
  // 「照片图库 / 拍照 / 选取文件」菜单、跳不过去。拍照用 capture，本来就直接开相机；旧安装包、安卓、浏览器走 input，
  // 先把它挪到点的那个按钮上，iOS 的菜单就从按钮那儿出来，不再悬在半空
  c.pick = async (k, btn) => {
    if (k !== "camera" && Link && PLATFORM === "ios" && window.SHELL_V >= 4) {
      try {
        const r = await Link.pick({ kind: k, max: Math.max(1, 9 - d().atts.length) });
        const fs = (r && r.files) || [];
        if (fs.length) c.setMore(false);
        for (const f of fs) {
          const b = await (await fetch(CAP.convertFileSrc(f.path))).blob();
          await c.add(new File([b], f.name, { type: f.mime || b.type }));
        }
      } catch (e) { hint("没打开" + (k === "files" ? "文件" : "相册") + "：" + e.message); }
      return;
    }
    const inp = { photos: $("#pickImg"), camera: $("#pickCam"), files: $("#pickFile") }[k], r = btn.getBoundingClientRect();
    Object.assign(inp.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    inp.value = "";
    inp.onchange = () => { const fs = [...inp.files]; inp.value = ""; if (fs.length) c.setMore(false); fs.forEach(f => c.add(f)); };
    inp.click();
  };
  let attSeq = 0;
  c.add = async file => {
    const to = c.to, dd = d();
    if (dd.atts.length >= 9) { hint("一次最多 9 个"); return; }
    const kind = /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name) ? "image" : "file";
    const a = { k: ++attSeq, name: file.name || (kind === "image" ? "图片.jpg" : "文件"), kind, size: file.size, st: "up", pct: 0, url: kind === "image" ? URL.createObjectURL(file) : "" };
    dd.atts.push(a);
    if (c.to === to) renderAtt();
    const f = kind === "image" ? await shrink(file) : file;
    if (f !== file && /\.(heic|heif|png|webp)$/i.test(a.name)) a.name = a.name.replace(/\.\w+$/, ".jpg");
    if (kind === "image" && f !== file && !/\.jpe?g$/i.test(a.name)) a.name += ".jpg";
    a.size = f.size;
    upload(f, a.name, a, pct => { a.pct = pct; if (c.to === to) { const p = attBox.querySelector(`.x[data-k="${a.k}"]`); const pr = p && p.parentNode.querySelector(".prog"); if (pr) pr.textContent = pct + "%"; } })
      .then(r => { a.id = r.id; a.size = r.size; a.st = "ok"; })
      .catch(e => { a.st = "err"; hint("上传失败：" + e.message); })
      .finally(() => { if (c.to === to) renderAtt(); });
  };
  c.takeFiles = to => {
    const dd = c.drafts[to] || { atts: [] };
    const ok = dd.atts.filter(a => a.st === "ok");
    dd.atts = dd.atts.filter(a => a.st !== "ok");
    if (c.to === to) renderAtt();
    return ok.map(a => ({ id: a.id, name: a.name, kind: a.kind, size: a.size, url: a.url || "" }));
  };
  c.restoreFiles = (to, files) => {
    const dd = c.drafts[to] || (c.drafts[to] = { text: "", atts: [] });
    files.forEach(f => dd.atts.push({ k: ++attSeq, id: f.id, name: f.name, kind: f.kind, size: f.size, st: "ok", url: f.url || (f.kind === "image" ? fileUrl(f.id) : "") }));
    if (c.to === to) renderAtt();
  };
  c.restoreText = (to, text, files) => {
    const dd = c.drafts[to] || (c.drafts[to] = { text: "", atts: [] });
    dd.text = text + (dd.text ? "\n" + dd.text : "");
    if (files && files.length) c.restoreFiles(to, files);
    if (c.to === to) { ta.value = dd.text; setMode("text", false); }
  };
  c.send = async () => {
    const to = c.to, dd = d();
    if (dd.atts.some(a => a.st === "up")) { hint("附件还在上传，传完再发"); return; }
    const text = c.mode === "text" ? ta.value.trim() : "";
    const files = c.takeFiles(to);
    if (!text && !files.length) return;
    if (c.mode === "text") { ta.value = ""; dd.text = ""; upd(); }
    c.setMore(false);
    const p = addPend(to, { text, files, st: "send", cmp: c });
    const pg = curPage();
    if (pg && pg.def.to === to) { pg.stick = true; stickBottom(pg); }
    try { await q("say", { to, text, files: files.map(f => ({ id: f.id })) }); p.st = "sent"; }
    catch (e) { dropPend(to, p.k); c.restoreText(to, text, files); hint(e.message); }
  };
  setMode(c.mode, false);
  return c;
}
const cmpMain = makeComposer();
stage.addEventListener("pointerdown", () => cmpMain.setMore(false));   // 点对话收起「+」面板

// 图片发之前先压一压（最长边 1600、JPEG 0.82）：北京中转只有 1M 带宽，原图几 MB 要传半分钟
async function shrink(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) || !window.createImageBitmap) return file;
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (s === 1 && file.size < 700 * 1024 && /jpeg/i.test(file.type)) return file;
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", .82));
    return blob && blob.size < file.size ? blob : file;
  } catch (e) { return file; }
}
function upload(blob, name, a, onPct) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    a.xhr = x;
    x.open("POST", `http://${host()}/app/up?key=${encodeURIComponent(cfg.token)}&name=${encodeURIComponent(name)}`);
    x.upload.onprogress = e => { if (e.lengthComputable) onPct(Math.round(e.loaded / e.total * 100)); };
    x.onload = () => {
      let r = null;
      try { r = JSON.parse(x.responseText); } catch (e) { /* 不是 JSON */ }
      if (x.status === 200 && r && r.id) res(r); else rej(new Error((r && r.error) || "HTTP " + x.status));
    };
    x.onerror = () => rej(new Error("网络出错"));
    x.onabort = () => rej(new Error("已取消"));
    x.send(blob);
  });
}

// ---------------------------------------------------------------- 小芽：通话（常开收音）+ 全屏 / 悬浮小窗
const call = { on: false, t0: 0, muted: false, ui: "none", to: "xy", aec: false };   // to = 打给谁（xy 小芽 / xz 小智）；aec = 手机能边念边听（回声消除 / 戴耳机），能的话说话就能打断
const CALLEE = { xy: "小芽", xz: "小智" };
let srvCall = 0;
const cname = () => CALLEE[call.to] || "小芽";
let live = null, xyThink = false;
$("#xyMute span").innerHTML = ico("micOff");
let soundOff = false;
function sndUpd() {                                 // 通话页「声音」：自动朗读关着、或锁屏上关了声音，都算关
  const off = soundOff || !autoRead, b = $("#xySnd");
  b.querySelector("span").innerHTML = ico(off ? "speakOff" : "speak");
  b.querySelector("em").textContent = off ? "声音已关" : "声音";
  b.classList.toggle("on", off);
  b.setAttribute("aria-pressed", off);
}
sndUpd();
$("#xy [data-act=xyhang] span").innerHTML = ico("hang");
$(".rec-cancel-ic").innerHTML = ico("x");
$("#navBack").innerHTML = ico("back");
$(".sh-x").innerHTML = $(".vw-x").innerHTML = ico("x");
$("#navMenu").innerHTML = ico("menu");

async function callStart(to) {
  to = to === "xz" ? "xz" : "xy";
  if (to === "xz" && srvCall < 2) { hint("服务器还没更新好，稍等再打"); return; }
  if (call.on && call.to === to) { xyOpen(); return; }
  if (call.on) {                                     // 正跟另一个通话：页面不关，直接换人（小芽 ↔ 小智）
    liveStop(2);
    Object.assign(call, { to, aec: false, t0: Date.now(), cap: {} });
    xyThink = false;
    callLook(); capUpd(); xyOpen(); updCallUi();
    if (Link) setTimeout(liveStart, 420); else await liveStart();
    return;
  }
  ac();
  call.on = true; call.to = to; call.aec = false; call.t0 = Date.now(); call.muted = false; call.cap = {};
  xyThink = false;
  callLook();
  capUpd();
  xyOpen();
  updCallUi();
  if (Link) setTimeout(liveStart, 420);              // 展开动画走完再开麦：原生开声音会话要一两百毫秒，别跟动画抢（iOS 上点开会卡一下）
  else await liveStart();
}
function callLook() {                                // 通话页按打给谁换名字、换色（小智是青绿色的对话气泡球）
  $(".xy-top b").textContent = cname();
  $("#xyOrb").setAttribute("aria-label", cname());
  $("#xy").classList.toggle("to-xz", call.to === "xz");
  fl.classList.toggle("to-xz", call.to === "xz");
}
function callCfg() { q("call_cfg", { to: call.to, aec: call.aec }).catch(() => {}); }    // 告诉服务器这通电话打给谁、能不能边念边听（能就让说话打断朗读）
async function liveStart() {
  if (Link) {
    if (!call.on || live || !online) return;
    live = newEnc();
    let r;
    try { r = await Link.live({ on: true, mute: call.muted }); } catch (e) { live = null; callEnd("打不开麦克风" + (e && e.message ? "\n" + e.message : "")); return; }
    call.aec = !!(r && r.aec);                       // 新安装包才会报：iOS 开了系统回声消除，或者声音走的耳机 / 蓝牙
    callCfg();
    xyUpd(); bgSync();
    laHint(r && r.la);
    return;
  }
  if (!call.on || live || !online || document.visibilityState !== "visible") return;
  try { await openMic(); } catch (e) { callEnd("打不开麦克风" + (e && e.message ? "\n" + e.message : "")); return; }
  if (!call.on || live) return;
  if (!tx({ t: "rec", wc: 15, to: call.to })) return;
  live = newEnc();
  call.aec = micAec;
  callCfg();
  beep("start");
  xyUpd();
}
// 苹果：锁屏 / 灵动岛的实时活动建不起来时说一下为什么（安装包 1.10 起原生回 la；每次启动只说一次）
let laTold = false;
function laHint(la) {
  if (!la || la === "ok" || laTold) return;
  laTold = true;                                     // 通话全屏时提示只有一行，说短点
  hint("灵动岛出不来：" + ({ noext: "安装时小组件被去掉了", off: "设置里关了实时活动" }[la] || la.replace(/^err:/, "").slice(0, 40)));
}
function liveStop(vs) {
  if (Link) { if (live || call.on) Link.live({ on: false, vs: vs || 0 }).catch(() => {}); live = null; bgSync(); return; }
  if (!live) return;
  flush(live);
  tx(vs ? { t: "rec_end", vs } : { t: "rec_cancel" });
  live = null;
}
function callEnd(msg) {
  if (!call.on) return;
  liveStop(2);
  call.on = false;
  soundOff = false; sndUpd();
  xyThink = false;
  if (!$("#xy").hidden) xyClose();
  micMaybeIdle();
  updCallUi();
  if (msg) hint(msg);
}
function updCallUi() {
  const pg = curPage();
  if (pg && pg.def.bar === "call") setBar(pg);
  if (pg && (pg.key === "home" || pg.key === "xz")) chrome(pg);   // 顶栏电话按钮：通话中亮着
  xyUpd(); flUpd(); bgSync();
}

// 字幕：通话里你最近说的一句 + 小芽最近回的一句（首页对话的 ev{w: hx} 顺手更新；Markdown 去掉符号，只留字）
function plainText(t) {
  return String(t || "").replace(/```[\s\S]*?(```|$)/g, "（代码）").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "").replace(/\*\*|__|~~|`/g, "").replace(/\n{2,}/g, "\n").trim();   // 只去成对的符号，「18~24℃」的 ~ 留着
}
function capUpd() {
  const c = call.cap || {};
  $("#xyCap").innerHTML = (c.me ? `<div class="cap-me">${esc(c.me)}</div>` : "") + (c.ai ? `<div class="cap-ai">${esc(plainText(c.ai))}</div>` : "");
}
function onXyEv(m) {
  if (m.think != null && call.to === "xy" && (!m.dev || m.dev === DEV_ID)) { xyThink = m.think; xyUpd(); }   // 别的设备上的小芽在想，跟这台无关；打给小智时看小智的事件
}

// ------------------------------------------------------------------ 小水母头像（2026-10-19）：app/www/av 的小水母 8 场景动图，服务端 /app/av 给
// 状态 → 场景：按住说话好像在录音 mic / 在听 listening / 在想 thinking / 小芽在说 speaking / 结果通知 success /
// 连不上 sad（下雨难过）/ 连接中·静音 standby（出场待机）/ 通话结束 sleep（睡觉）
const AV_FILE = { listen: "listening", think: "thinking", speak: "speaking", mic: "mic",
  success: "success", sad: "sad", standby: "standby", sleep: "sleep" };
let avSizes = null, avTryAt = 0, avOkT = 0;
function avSrc(f) {
  if (!avSizes || !avSizes[f]) return "";
  return `http://${host()}/app/av?name=${f}&key=${encodeURIComponent(cfg.token)}&v=${avSizes[f]}`;
}
function avUrl(k) { return avSrc((AV_FILE[k] || "") + ".gif"); }
async function avBoot() {                             // 文件名→大小表一次就够；大小就是版本，改了图 URL 变了才重新下（手机缓存接着用旧的）
  if (avSizes || !cfg.token || Date.now() - avTryAt < 8000) return;
  avTryAt = Date.now();
  try {
    const r = await fetch(`http://${host()}/app/av?key=${encodeURIComponent(cfg.token)}`, { cache: "no-store" });
    if (r.ok) {
      avSizes = await r.json();
      for (const f of Object.keys(avSizes)) if (/\.gif$/.test(f)) new Image().src = avSrc(f);      // 一次把 8 张都拉进缓存
    }
  } catch (e) { /* 拿不到就继续用原来的渐变球 */ }
  xyLast = "";
  xyUpd();
}
function avApply(o, k) {                              // 球里那层 i 换成对应场景的动图；拿不到 URL（还没拉到表 / 登录前）就保持原来的渐变
  const i = o && o.querySelector("i");
  if (!i || o.classList.contains("sprout")) return;
  const u = avUrl(k);
  if ((i.dataset.av || "") === u) return;
  i.dataset.av = u;
  i.classList.toggle("msh", !!u);                      // 🔴 类名别用 av——style.css 的 .av 是消息头像（width 30px），会把 i 压成 30px
  i.style.background = u ? `center / cover no-repeat url("${u}")` : "";
}
function xyState() {
  if (!call.on) return ["idle", "通话已结束"];
  if (!online || !live && !ptt) return ["idle", "正在连接…"];
  if (call.muted) return ["mute", "已静音，点左边的麦克风恢复"];
  if ((soundOff || !autoRead) && !xyThink) return ["listen", "声音已关 · 我在听，回复看字幕"];
  if (speaking()) return ["speak", cname() + "在说话 · " + (call.aec ? "开口说话或点球打断" : "点球打断")];
  if (xyThink) return ["think", "让我想想…"];
  return ["listen", "我在听，直接说"];
}
let xyLast = "", xyNote = "", xyNoteT = 0;
function xyUpd() {
  const [k, label0] = xyState();
  const label = Date.now() < xyNoteT ? xyNote : label0;   // 全屏时的提示临时占用状态这一行
  const fk = call.on ? k : speaking() ? "speak" : "";
  const key = k + label + call.muted + fk;
  $("#xyMute").classList.toggle("on", call.muted);
  $("#xyMute").setAttribute("aria-pressed", call.muted);
  $("#xyMute em").textContent = call.muted ? "已静音" : "静音";
  if (key === xyLast) return;
  xyLast = key;
  const xz = call.on && call.to === "xz" ? " xz" : "";
  $("#xyOrb").className = "orb big sprout " + k + xz;
  fl.querySelector(".orb").className = "orb sprout " + fk + xz;
  let mk;                                              // 小水母哪一幕：刚来的通知=庆祝，通话里按状态（掉线=下雨），不通话顶栏=待机/在说
  if (Date.now() < avOkT) mk = "success";
  else if (call.on) mk = !online ? "sad" : ptt && k === "listen" ? "mic" : k === "idle" || k === "mute" ? "standby" : (AV_FILE[k] ? k : "listen");
  const cbk = speaking() ? "speak" : call.on ? mk : "standby";
  avApply($("#xyOrb"), mk);                            // 全屏球 / 悬浮球 / 顶栏「呼叫小芽」都换
  avApply(fl.querySelector(".orb"), cbk);
  avApply($(".callbtn .orb"), cbk);
  const s = $("#xyState");
  s.textContent = label;
  s.className = "xy-state " + (Date.now() < xyNoteT ? "note" : k);
}
setInterval(xyUpd, 250);
function xyStat() { $("#xyStat").textContent = call.on ? "通话中 " + mmss(Date.now() - call.t0) : ""; }

// ---------------------------------------------------------------- 全屏 ↔ 悬浮球：只动 transform / opacity（合成层，iOS 上不卡），从球的位置展开、缩回球里
function rectXf(r) {                                 // 把整屏缩放平移到矩形 r 的中心（等比，宽对齐）
  const W = innerWidth, H = innerHeight, s = Math.max(.08, r.width / W);
  return `translate(${r.left + r.width / 2 - W / 2}px, ${r.top + r.height / 2 - H / 2}px) scale(${s})`;
}
function xyAnimEnd(p) { p.classList.remove("anim", "drag"); p.style.transform = ""; p.style.opacity = ""; p.style.borderRadius = ""; }
function xyOpen() {
  const p = $("#xy"), fromFloat = !fl.hidden;
  const src = fromFloat ? fl : $(".callbtn");
  const r = src ? src.getBoundingClientRect() : null;
  call.ui = "full";
  flUpd();
  p.hidden = false;
  $("#app").inert = true;
  p.classList.add("anim");
  xyUpd(); xyStat();
  const from = r && r.width ? rectXf(r) : "translateY(40px) scale(.94)";
  const an = p.animate([{ transform: from, opacity: fromFloat ? .5 : .2, borderRadius: "60px" }, { transform: "none", opacity: 1, borderRadius: "0px" }],
    { duration: fromFloat ? 440 : 400, easing: EASE });
  an.onfinish = () => {
    xyAnimEnd(p);
    xyHint();
  };
}
function xyMin() {
  if (!call.on) return xyClose();
  const p = $("#xy");
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  call.ui = "float";
  $("#app").inert = false;
  fl.classList.remove("open");
  flUpd();
  const r = fl.getBoundingClientRect();
  fl.style.opacity = "0";
  p.classList.add("anim");
  const cur = p.style.transform || "none";
  const an = p.animate([{ transform: cur, opacity: p.style.opacity || 1, borderRadius: p.style.borderRadius || "0px" },
    { transform: rectXf(r), opacity: 0, borderRadius: "120px" }], { duration: 400, easing: EASE });
  an.onfinish = () => {
    p.hidden = true; xyAnimEnd(p);
    fl.style.opacity = "";
    fl.animate([{ transform: fl.style.transform + " scale(.6)", opacity: 0 }, { transform: fl.style.transform, opacity: 1 }], { duration: 260, easing: EASE });
  };
}
function xyClose() {
  const p = $("#xy");
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  call.ui = "none";
  $("#app").inert = false;
  p.classList.add("anim");
  p.animate([{ transform: p.style.transform || "none", opacity: 1 }, { transform: "translateY(60px) scale(.92)", opacity: 0 }],
    { duration: 280, easing: EASE }).onfinish = () => { p.hidden = true; xyAnimEnd(p); };
  flUpd();
}
function xyHint() {                                  // 头几次打开提示一下怎么收起（原来的「↓」按钮去掉了）
  const n = +(store("xyHint") || 0);
  if (n >= 3) return;
  store("xyHint", String(n + 1));
  xyFlash("左右滑动收起成悬浮球");
}
function xyFlash(text) { xyNote = text; xyNoteT = Date.now() + 2600 + Math.min(3000, text.length * 60); xyLast = ""; xyUpd(); }

// 侧滑收起（用户：收起应该是侧滑，不要「↓」箭头）：在通话页任意处横着滑，页面跟着手缩小，松手滑过一段或甩一下就收成悬浮球
(function xySwipe() {
  const p = $("#xy");
  let d = null;
  p.addEventListener("pointerdown", e => {
    if (d || p.classList.contains("anim") || e.target.closest(".xy-ctl, #xyOrb")) return;
    d = { x0: e.clientX, y0: e.clientY, id: e.pointerId, on: false, x: e.clientX, t: performance.now(), v: 0 };
  });
  p.addEventListener("pointermove", e => {
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.on) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { d = null; return; }   // 竖着滑 = 翻记录
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      d.on = true;
      try { p.setPointerCapture(e.pointerId); } catch (x) { /* 已经松手了 */ }
      p.classList.add("anim", "drag");
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    }
    const now = performance.now();
    d.v = (e.clientX - d.x) / Math.max(1, now - d.t);
    d.x = e.clientX; d.t = now;
    const pr = Math.min(1, Math.abs(dx) / innerWidth);
    p.style.transform = `translate(${dx * .9}px, ${pr * 60}px) scale(${1 - pr * .4})`;
    p.style.borderRadius = `${Math.round(pr * 90 + 12)}px`;
  });
  const up = e => {
    if (!d || e.pointerId !== d.id) return;
    const g = d; d = null;
    if (!g.on) return;
    const dx = g.x - g.x0;
    if (performance.now() - g.t > 100) g.v = 0;
    if (Math.abs(dx) > innerWidth * .22 || Math.abs(g.v) > .5 && Math.abs(dx) > 30) {
      hap("light");
      fpos.side = dx > 0 ? "r" : "l";
      fpos.tuck = false;
      store("xyFloat", JSON.stringify(fpos));
      xyMin();
      return;
    }
    p.animate([{ transform: p.style.transform, borderRadius: p.style.borderRadius }, { transform: "none", borderRadius: "0px" }],
      { duration: 320, easing: EASE }).onfinish = () => xyAnimEnd(p);
    p.style.transform = "none";
  };
  p.addEventListener("pointerup", up);
  p.addEventListener("pointercancel", up);
})();

// ---------------------------------------------------------------- 悬浮球：全 App 唯一的浮框，只在小芽通话收起时出来
// 2026-10-16 用户：「新对话已打开」「朗读」都从这里弹出一长条，除了通话的悬浮球，App 里的弹窗都不要。所以没在通话时它不出来；
// 通话收起时小芽说的话、定时提醒展开成胶囊显示几秒，再缩回球。拖到哪松手就停到最近的一边，甩到边上收成一条；点一下：收着的拉出来 / 回全屏通话
const fl = $("#xyFloat"), FB = 60;
let fpos = { side: "r", y: .2, tuck: false };
try { fpos = Object.assign(fpos, JSON.parse(store("xyFloat") || "{}")); } catch (e) { /* 用默认 */ }
const flMsg = { title: "", text: "", until: 0, tm: 0 };
const flWant = () => call.on && call.ui !== "full";
function flash(text, o) {
  text = String(text || "").trim();
  if (!text || !flWant()) return;
  o = o || {};
  flMsg.title = o.title || "";
  flMsg.text = text;
  flMsg.until = Date.now() + (o.ms || 2600 + Math.min(4500, text.length * 90));
  avOkT = flMsg.until;                                 // 弹消息的这几秒球也换成星星庆祝那一幕
  clearTimeout(flMsg.tm);
  flMsg.tm = setTimeout(flUpd, flMsg.until - Date.now() + 20);
  flUpd();
}
function flShowing() { return Date.now() < flMsg.until; }
function flUpd() {
  if (!flWant()) {
    if (!fl.hidden && !fl.classList.contains("bye")) {
      fl.classList.add("bye");
      fl.animate([{ opacity: 1, transform: fl.style.transform }, { opacity: 0, transform: fl.style.transform + " scale(.7)" }], { duration: 220, easing: EASE })
        .onfinish = () => { fl.classList.remove("bye"); if (!flWant()) fl.hidden = true; };
    }
    return;
  }
  fl.classList.remove("bye");
  let t = "", s = "";
  if (flShowing()) { t = flMsg.title; s = flMsg.text; }
  const open = !!s;
  fl.querySelector(".fl-txt b").textContent = t;
  fl.querySelector(".fl-txt span").textContent = s;
  fl.classList.toggle("notitle", !t);
  const was = fl.hidden;
  fl.classList.toggle("open", open);
  if (was) {
    fl.classList.add("drag");
    flPlace();
    fl.hidden = false;
    fl.offsetWidth;
    fl.classList.remove("drag");
    fl.animate([{ opacity: 0, transform: fl.style.transform + " scale(.7)" }, { opacity: 1, transform: fl.style.transform }], { duration: 300, easing: EASE });
  } else flPlace();
  xyLast = ""; xyUpd(); tickTimers();
}
// 在念（没在通话）：顶栏右边多一个「停止朗读」，念完收掉（原来是悬浮球展开成「正在朗读」长条）
let spWas = false;
setInterval(() => {
  const s = speaking() && !call.on;
  if (s === spWas) return;
  spWas = s;
  const pg = curPage();
  if (pg) $("#navRight").innerHTML = navRightHtml(pg);
}, 300);
function flW() { return fl.classList.contains("open") ? Math.min(340, innerWidth - 24) : FB; }
function floatXY() {
  const W = innerWidth, H = innerHeight, w = flW(), open = fl.classList.contains("open");
  const topMin = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top")) || 0;
  const y = Math.max(topMin + 60, Math.min(H - 84 - 110, fpos.y * H));
  let x = fpos.side === "l" ? 12 : W - w - 12;
  if (fpos.tuck && !open) x = fpos.side === "l" ? -FB + 18 : W - 18;   // 有文字要看时先拉出来，缩回去再收着
  return [x, y];
}
function flPlace() {
  const [x, y] = floatXY();
  fl.style.setProperty("--flw", flW() + "px");
  fl.style.transform = `translate(${x}px, ${y}px)`;
  fl.classList.toggle("tuck", fpos.tuck && !fl.classList.contains("open"));
  fl.classList.toggle("l", fpos.side === "l");
  fl.classList.toggle("r", fpos.side === "r");
}
window.addEventListener("resize", () => { if (!fl.hidden) flPlace(); });
(function floatDrag() {
  let d = null;
  fl.addEventListener("pointerdown", e => {
    e.preventDefault();
    const [x, y] = floatXY();
    d = { x0: e.clientX, y0: e.clientY, x, y, moved: false, vx: 0, lx: e.clientX, lt: performance.now() };
    fl.setPointerCapture(e.pointerId);
    fl.classList.add("drag");
  });
  fl.addEventListener("pointermove", e => {
    if (!d) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
    d.moved = true;
    const now = performance.now();
    d.vx = (e.clientX - d.lx) / Math.max(1, now - d.lt);
    d.lx = e.clientX; d.lt = now;
    fl.style.transform = `translate(${d.x + dx}px, ${d.y + dy}px)`;
    if (fpos.tuck && Math.abs(dx) > 10) fl.classList.remove("tuck");
  });
  const up = e => {
    if (!d) return;
    const g = d; d = null;
    fl.classList.remove("drag");
    if (!g.moved) {
      hap("light");
      if (fpos.tuck && !fl.classList.contains("open")) { fpos.tuck = false; flPlace(); saveF(); return; }
      flMsg.until = 0; xyOpen();
      return;
    }
    const W = innerWidth, w = flW(), x = g.x + (e.clientX - g.x0), y = g.y + (e.clientY - g.y0);
    if (performance.now() - g.lt > 120) g.vx = 0;
    fpos.side = x + w / 2 < W / 2 ? "l" : "r";
    fpos.tuck = x < -w * .3 || x > W - w * .7 || (fpos.side === "l" ? g.vx < -1.1 : g.vx > 1.1);
    fpos.y = y / innerHeight;
    if (fpos.tuck) { hap("light"); flMsg.until = 0; fl.classList.remove("open"); }
    flPlace();
    saveF();
  };
  fl.addEventListener("pointerup", up);
  fl.addEventListener("pointercancel", up);
  function saveF() { store("xyFloat", JSON.stringify(fpos)); }
})();

// ---------------------------------------------------------------- 后台运行 + 通知（原生 Link）
// 用户：通话或 Claude 在干活时锁屏、切回主页，要能后台接着跑，还要有通知。
// 安卓：开前台服务（常驻通知「小芽通话中 / Claude 正在工作」），iOS：通话时麦克风本身让 App 留在后台，Claude 干活时放静音保活。
// 结果通知（服务器发给这台的 note）由原生模块在 App 不在前台时弹；在前台就由 onNote 在悬浮球上报
const cBusy = new Set();                             // 正在干活的 Claude 会话
let bgLast = "";
function bgSync() {
  if (!Link) return;
  const o = { keep: bgOn, notify: noteOn, call: call.on, busy: cBusy.size > 0 };
  const k = JSON.stringify(o);
  if (k === bgLast) return;
  bgLast = k;
  Link.bg(o).catch(() => {});
}
// App 在前台时不弹（2026-10-16 用户：App 里的弹窗都不要）：小芽的话、定时提醒首页对话里有，Claude 做完左上角菜单按钮带点；
// iPhone 安装包 v4 起定时提醒在前台也弹系统横幅（原生）。只有通话收成悬浮球时，小芽的话、提醒照旧显示在球上
function onNote(m) {
  const pg = curPage();
  if (m.k === "xy" && !(pg && pg.key === "home")) flash(m.body, { title: "小芽" });
  if (m.k === "xz" && call.on && call.to === "xz") flash(m.body, { title: "小智" });      // 打给小智收起成悬浮球时，她答的话在球上冒一下
  if (m.k === "cron") flash(m.body, { title: m.title });
}

// ---------------------------------------------------------------- 登录（2026-10-14：安装包里不再带服务器密钥，账号密码换一个令牌）
function showLogin(msg) {
  const lg = $("#login");
  $("#lgUser").value = cfg.user || $("#lgUser").value || "";
  $("#lgErr").textContent = msg || "";
  $("#lgSrv").value = cfg.servers.join("\n");
  if (!lg.hidden) return;
  lg.hidden = false;
  lg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 });
}
function needLogin(msg) {
  cfg.token = "";
  saveCfg();
  disconnect();
  if (call.on) callEnd();
  showLogin(msg);
}
async function doLogin() {
  const user = $("#lgUser").value.trim(), pw = $("#lgPw").value, btn = $("#lgGo");
  if (!user || !pw) { $("#lgErr").textContent = "账号、密码都要填"; return; }
  if (!$("#lgSrvBox").hidden) { const s = $("#lgSrv").value.split(/\s+/).filter(Boolean); if (s.length) cfg.servers = s; }
  btn.disabled = true; btn.textContent = "正在登录…"; $("#lgErr").textContent = "";
  let err = "连不上服务器";
  for (let i = 0; i < cfg.servers.length; i++) {
    const h = cfg.servers[i];
    try {
      const ctl = window.AbortController ? new AbortController() : null;
      const tm = setTimeout(() => ctl && ctl.abort(), 10000);
      // text/plain 是「简单请求」，不用先发一次跨域预检（北京中转 1M 带宽，少一个来回）
      const r = await fetch(`http://${h}/app/login`, { method: "POST", headers: { "Content-Type": "text/plain" }, signal: ctl && ctl.signal,
        body: JSON.stringify({ user, pw, dev: DEV_ID, label: DEV_LABEL }) });
      clearTimeout(tm);
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.token) {
        cfg.token = d.token; cfg.user = d.user || user; srv = i;
        saveCfg();
        $("#lgPw").value = "";
        btn.disabled = false; btn.textContent = "登录";
        const lg = $("#login");
        lg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220 }).onfinish = () => { lg.hidden = true; };
        hap("medium");
        connect();
        return;
      }
      err = d.error || "HTTP " + r.status;
      if (r.status === 401 || r.status === 400) break;   // 密码错了不用再试别的地址
    } catch (e) { err = "连不上 " + hostName(h); }
  }
  btn.disabled = false; btn.textContent = "登录";
  $("#lgErr").textContent = err;
  hap("heavy");
}
$("#lgPw").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doLogin(); } });
$("#lgUser").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("#lgPw").focus(); } });
$("#login .lg-orb").innerHTML = LOGO;

// iOS 键盘：安装包 v3 带 @capacitor/keyboard（resize: native，整个网页让出键盘那块，跟安卓一样），顺手去掉键盘上面那条「上一项 / 下一项 / 完成」
if (Kbd && PLATFORM === "ios") { try { Kbd.setAccessoryBarVisible({ isVisible: false }).catch(() => {}); } catch (e) { /* 没有 */ } }

// ---------------------------------------------------------------- 启动（2026-10-27 起栈底是 Claude，小芽在侧栏里）
go("claude");
connect();
if (window.uiBootOk) uiBootOk();                     // 跑到这里 = 这版界面能起来，boot.js 不用回滚
