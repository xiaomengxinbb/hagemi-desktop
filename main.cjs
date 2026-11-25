'use strict';
/**
 * Hagemi 桌面宿主。
 *
 * 插件本身只会住进 Antigravity 的渲染进程；这里给它一间自己的房子：一个透明、置顶、全屏的
 * Electron 窗口。窗口对外表现为「Antigravity 的应用页面」——给 sidecar 一个 DevTools 端口，
 * 页面里有 __APP_CONFIG__ 和 /main.js，于是 sidecar 用原封不动的 CDP 代码把她挂上来。
 * 插件一行不改，插件更新也不影响宿主。
 *
 * 宿主自己只负责四件事：窗口与托盘、点击穿透、sidecar 的生死监护、开机自启。
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, shell, ipcMain, dialog, powerMonitor } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { createServer } = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOME = os.homedir();
// 代码在哪（main.cjs、preload.cjs 所在目录）——打包成 .app 之后它在 Resources/app 里。
const APP_DIR = __dirname;
// 数据在哪。不能跟代码放一起：装进 /Applications 之后那里是只读的。
const STATE_DIR = process.env.HAGEMI_STATE_DIR || path.join(app.getPath('appData'), 'HagemiDesktop');
const PROFILE_DIR = path.join(STATE_DIR, 'profile');
const DATA_DIR = path.join(STATE_DIR, 'data');
const LOG_DIR = path.join(STATE_DIR, 'logs');
const PLUGIN_DIR = process.env.HAGEMI_PLUGIN_DIR || path.join(HOME, '.gemini', 'config', 'plugins', 'hagemi-pet-agy');
const SIDECAR = path.join(PLUGIN_DIR, 'sidecars', 'pet', 'main.mjs');
const PLUGIN_LOGO = path.join(PLUGIN_DIR, 'assets', 'logo.png');
const ANTIGRAVITY_DATA = path.join(HOME, '.gemini', 'antigravity', 'sidecar_data', 'hagemi-pet-agy', 'pet', 'data');
const LEGACY_DIR = path.join(HOME, '.hagemi-desktop');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const STATE_FILE = path.join(DATA_DIR, 'host-state.json');
const HOST_LOG = path.join(LOG_DIR, 'host.log');
const SIDECAR_LOG = path.join(LOG_DIR, 'sidecar.log');
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', 'com.hagemi.desktop.plist');

const TICK_MS = 45;
const FOCUS_WINDOW_MS = 90_000; // 借用键盘焦点的最长时间
const IDLE_POLL_MS = 400; // 光标不动时，每隔这么久重问一次命中（她会自己走过来）
const SYNTH_IDLE_LIMIT_S = 600; // 整机闲置超过这么久就不再补鼠标移动，让她能真的睡过去
// 她的窗口不再「铺满一块屏」，而是一个 900×800 的小盒子 —— 和 dsh 桌宠的窗口同样大。
// 盒子里是她的整个坐标系：走动、蹦跳、贴边、气泡、菜单、设置面板全在里面。
// 盒子不会把她关死：拖她的时候盒子跟着光标走（followDrag），她走到哪儿盒子跟到哪儿，
// 所以整块桌面她照样去得了，只是窗口本身始终只有她周围这一小圈。
const BOX = { w: 900, h: 800 };
const DRAG_EDGE = 150; // 光标离盒子边缘多近就把盒子跟过去（拖她的时候用）
const PROBE_MS = 150; // 多久问她一次「你走到哪儿了」

// 早期版本把数据放在代码目录里，搬家时顺手接过来，别让她忘了自己站在哪儿。
function adoptLegacyState() {
  if (STATE_DIR === LEGACY_DIR) return;
  for (const name of ['data', 'profile', 'logs']) {
    const from = path.join(LEGACY_DIR, name);
    const to = path.join(STATE_DIR, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    try { fs.renameSync(from, to); } catch { try { fs.cpSync(from, to, { recursive: true }); } catch { /* 接不过来就算了，重来一遍 */ } }
  }
}

adoptLegacyState();
for (const dir of [LOG_DIR, DATA_DIR, PROFILE_DIR]) fs.mkdirSync(dir, { recursive: true });
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}\n`;
  try { fs.appendFileSync(HOST_LOG, line); } catch { /* 记日志永远不能把她弄挂 */ }
  if (process.env.HAGEMI_DEBUG) process.stdout.write(line);
}

app.setName('Hagemi Pet');
app.setPath('userData', PROFILE_DIR);
// 自己开一个 DevTools 端口：sidecar 正是从这里找到她的窗口。
app.commandLine.appendSwitch('remote-debugging-port', '0');

let win = null;
let tray = null;
let server = null;
let sidecar = null;
let quitting = false;
let restartDelay = 500;
let startedWith = ''; // sidecar 启动那一刻用的 language server 凭据（端口:token），变了就重启她
let pointerDown = false;
let hitBusy = false;
let ignoring = true;
let lastCursor = { x: -1, y: -1 };
let focusTimer = null;
let displayId = null; // 她安家在哪块屏
let lastBounds = null;
let lastPollAt = 0;
let overNow = false; // 上一轮轮询里光标是不是在她身上
let herNow = null; // 最近一次问到的她（盒子内的坐标，px）
let dragPointer = null; // 拖动途中浏览器报来的指针位置（她的 client 坐标）
let lastPointerAt = 0; // 最近一次收到指针事件的时间，用来识破「松手松在窗口外面」
let probing = false;
let settled = false; // 首次挂上后把她的绝对位置放回去，只做一次

// ---- 点击穿透 -----------------------------------------------------------------------
//
// 她的命中框由 pet.js 自己维护：只有光标压在画出来的像素上，closed shadow root 里的 .hit
// 才会 pointer-events:auto。所以对宿主来说，elementFromPoint 返回宿主元素就等于
// 「光标正在她、她的气泡或她弹出的菜单/面板上」——不需要任何几何估算，也不用打开影子根。

function setIgnore(ignore) {
  if (!win || win.isDestroyed() || ignore === ignoring) return;
  ignoring = ignore;
  // forward：穿透状态下鼠标移动照旧送进页面，她才能判断光标有没有落到自己身上。
  win.setIgnoreMouseEvents(ignore, { forward: true });
  if (process.env.HAGEMI_DEBUG) log(`ignore=${ignore}`);
}

// 她的命中框是跟着「最近一次鼠标移动」刷新的：她只有被指针扫过才会重新算自己身上哪些像素是实的。
// 光标停着不动、她自己走到光标底下时，页面里就永远等不到那次移动，命中框还是 stale 的。
// 所以先替她把一次 pointermove 补上（位置就是真实光标），再问 elementFromPoint。
function overHer(point) {
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  const x = Math.round(point.x), y = Math.round(point.y);
  const expression = `(() => {
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: ${x}, clientY: ${y}, bubbles: true }));
    const el = document.elementFromPoint(${x}, ${y});
    return !!el && el.id === 'hagemi-pet-host';
  })()`;
  return win.webContents.executeJavaScript(expression, true).catch(() => false);
}

// 上面那一发 pointermove 是合成的，浏览器的悬停状态不认它。她身上那块 .hit 刚刚才被改成
// pointer-events:auto，要等下一次「真正的」输入，浏览器才会重做命中测试并发 pointerenter——
// 她的额度小气泡就挂在这个事件上。所以光标落到她身上的那一刻，补一发输入管线级别的移动。
// 必须排在 setIgnore(false) 之后：窗口还在穿透状态时，灌进去的事件会被直接丢掉。
function hoverInject(point) {
  if (!win || win.isDestroyed()) return;
  const x = Math.round(point.x), y = Math.round(point.y);
  // 先偏一格再回来：浏览器对「停在原地」的移动不发事件，来回一次才算真的挪动了。
  const send = (px, py) => {
    try { win.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py }); } catch { /* 窗口正在销毁 */ }
  };
  send(x + 1, y + 1);
  setTimeout(() => send(x, y), 16);
}

// ---- 小窗口里的她 -------------------------------------------------------------------
//
// 她整个坐标系都建立在 window.innerWidth/innerHeight 上（pet.js:150 的 viewW/viewH）：
// 默认站位、走动范围、气泡往哪边翻、菜单往哪边弹，全按窗口算。窗口只有 900×800 之后，
// 这些计算照样是对的，代价是她的活动范围也只剩这 900×800 —— 所以盒子要会跟着她挪。
//
// 挪法：每 150ms 问她一次位置。她贴近盒壁、还想继续往外走时，盒子朝那个方向让开，
// 让开的同时把她钉在原地（moveBoxKeepingHer）—— 她不会察觉窗口动过，只觉得前面又空出来了。

// 她的 JS 世界是 CDP 建的隔离世界（sidecars/pet/lib/cdp.mjs 里的 createIsolatedWorld，
// worldName 'hagemi-pet'）：它和主世界共用 DOM，但 `window.__hagemiPet` 只活在那个世界里，
// 主世界的 executeJavaScript 看不到它（elementFromPoint 倒是能用，因为 DOM 是共用的）。
// 所以要读位置、要推位置，都得先挂到那个世界上去。
//
// 挂在宿主自己的 DevTools 端口上即可：一个 target 允许多个 CDP 会话，sidecar 那条连接不受影响
// （早先用独立探针脚本同时连着试过很多轮）。
const PET_WORLD = 'hagemi-pet';

function devtoolsPort() {
  try {
    const text = fs.readFileSync(path.join(PROFILE_DIR, 'DevToolsActivePort'), 'utf8');
    const port = Number(text.split(/\r?\n/)[0]);
    return Number.isInteger(port) && port > 0 ? port : 0;
  } catch { return 0; }
}

let pet = null;      // 与她自己那个世界的会话
let petOpening = null;

function openPetWorld() {
  if (pet) return Promise.resolve(pet);
  if (petOpening) return petOpening;
  petOpening = (async () => {
    const port = devtoolsPort();
    if (!port) throw new Error('no devtools port');
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = list.find(item => item.type === 'page' && /^https?:\/\/(127\.0\.0\.1|localhost)/.test(item.url || ''));
    if (!target) throw new Error('no page target');
    const session = await connectPetWorld(target.webSocketDebuggerUrl);
    pet = session;
    return session;
  })().finally(() => { petOpening = null; });
  return petOpening;
}

// 一条极简 CDP 会话：只要能发命令、能认出她的世界什么时候建好/销毁。
function connectPetWorld(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const session = { socket, contextId: null, nextId: 0, pending: new Map(), closed: false };
    const timer = setTimeout(() => { session.closed = true; try { socket.close(); } catch { /* 已关 */ } reject(new Error('pet world timed out')); }, 5000);
    session.send = (method, params = {}, timeout = 4000) => new Promise((res, rej) => {
      if (session.closed || socket.readyState !== 1) return rej(new Error('pet world closed'));
      const id = ++session.nextId;
      const guard = setTimeout(() => { session.pending.delete(id); rej(new Error(`${method} timed out`)); }, timeout);
      session.pending.set(id, { res, rej, guard });
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id) {
        const item = session.pending.get(message.id);
        if (!item) return;
        session.pending.delete(message.id);
        clearTimeout(item.guard);
        if (message.error) item.rej(new Error(message.error.message)); else item.res(message.result || {});
        return;
      }
      const { method, params } = message;
      if (method === 'Runtime.executionContextCreated' && params.context?.name === PET_WORLD) session.contextId = params.context.id;
      if (method === 'Runtime.executionContextDestroyed' && params.executionContextId === session.contextId) session.contextId = null;
      if (method === 'Runtime.executionContextsCleared') session.contextId = null;
    });
    socket.addEventListener('close', () => {
      session.closed = true;
      clearTimeout(timer);
      for (const item of session.pending.values()) { clearTimeout(item.guard); item.rej(new Error('pet world closed')); }
      session.pending.clear();
      if (pet === session) pet = null;
    });
    socket.addEventListener('error', () => { clearTimeout(timer); session.closed = true; reject(new Error('pet world failed')); }, { once: true });
    socket.addEventListener('open', async () => {
      try {
        await session.send('Runtime.enable');
        clearTimeout(timer);
        resolve(session);
      } catch (error) { clearTimeout(timer); session.closed = true; reject(error); }
    }, { once: true });
  });
}

// 在那个世界里跑一句。她还没挂上（世界还没建）时返回 null，不抛。
async function inHerWorld(expression) {
  let session;
  try { session = await openPetWorld(); } catch { return null; }
  if (!session.contextId) return null;
  try {
    const result = await session.send('Runtime.evaluate', { expression, contextId: session.contextId, returnByValue: true });
    if (result.exceptionDetails) return null;
    return result.result ? result.result.value : null;
  } catch { return null; }
}

// 问她在盒子里的坐标（画布中心，px）。读的是插件自己的 API，不碰影子根。
async function readHer() {
  const text = await inHerWorld('window.__hagemiPet ? JSON.stringify(window.__hagemiPet.position) : ""');
  if (!text) return null;
  try {
    const her = JSON.parse(text);
    return Number.isFinite(her.x) && Number.isFinite(her.y) ? her : null;
  } catch { return null; }
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(0.985, Math.max(0.015, value));
}

// 把她推到盒子里的某个比例位置。hello 是插件给的正式入口：重算尺寸、重新站位，
// 状态、动画、气泡一概不动，也不会往 sidecar 报一次「我被拖了」（pet.js:709-715）。
function pushHer(fraction) {
  const message = { t: 'hello', settings: { position: { x: clamp01(fraction.x), y: clamp01(fraction.y) } } };
  inHerWorld(`window.__hagemiPet && window.__hagemiPet.receive(${JSON.stringify(message)}), 0`).catch(() => {});
}

// 只挪盒子，不碰她。她记的是「窗口比例」，所以盒子一动、她的绝对位置就跟着跑；
// 想让她的绝对位置不动，得配合 moveBoxKeepingHer 或者随后推一次比例。
function setBox(x, y) {
  if (!win || win.isDestroyed()) return false;
  const box = win.getBounds();
  const area = preferDisplay().workArea;
  const next = {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - BOX.w)),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - BOX.h)),
    width: BOX.w,
    height: BOX.h,
  };
  if (next.x === box.x && next.y === box.y && next.width === box.width && next.height === box.height) return false;
  win.setBounds(next);
  lastBounds = next;
  writeState({ box: { x: next.x, y: next.y } });
  return true;
}

// 挪盒子并把她钉在原地：先记下她在桌面上的绝对坐标，挪完按新盒子反算比例推回去。
// 「她不动、盒子在动」是这套小窗口方案的核心手感 —— 用户只会看见她周围那圈空气在换地方。
function moveBoxKeepingHer(x, y) {
  if (!win || win.isDestroyed() || !herNow) return setBox(x, y);
  const box = win.getBounds();
  const absolute = { x: box.x + herNow.x, y: box.y + herNow.y };
  if (!setBox(x, y)) return false;
  const after = win.getBounds();
  // 换屏的时候盒子会一下跳到很远的另一块屏上，她的绝对坐标就落到了盒子外面。
  // 插件那边 pushHer 会把她夹回盒子里，所以这里也跟着夹一次，账本和画面对得上。
  const local = {
    x: Math.min(Math.max(absolute.x - after.x, after.width * 0.02), after.width * 0.98),
    y: Math.min(Math.max(absolute.y - after.y, after.height * 0.02), after.height * 0.98),
  };
  herNow = local;
  pushHer({ x: local.x / after.width, y: local.y / after.height });
  return true;
}

// 每 150ms 问她一次在哪儿，顺手把「她在桌面上的绝对坐标」记到账本里。
// 记这个是为了下次启动能把她放回原处：窗口换了地方、换了大小时，她不该跟着跳。
function probeHer() {
  if (!win || win.isDestroyed() || !win.isVisible() || probing) return;
  probing = true;
  readHer().then(her => {
    probing = false;
    if (!her || !Number.isFinite(her.x) || !Number.isFinite(her.y)) return;
    herNow = her;
    const box = win.getBounds();
    const at = { x: Math.round(box.x + her.x), y: Math.round(box.y + her.y) };
    const saved = readState();
    if (!saved.herAt || Math.abs(saved.herAt.x - at.x) > 6 || Math.abs(saved.herAt.y - at.y) > 6) writeState({ herAt: at });
    if (!settled) { settled = true; settleHerAtStartup(her); return; }
    if (pointerDown) followDrag(box);
    else panWithHer(box, her);
  }).catch(() => { probing = false; });
}

// 拖动时盒子跟着光标走。她自己的拖拽是「她跟着光标走」的：clientX 一超出窗口，
// 她就会被 keepInBounds 钳在边上，手一松还判定成「贴边」—— 小窗口里这手感是坏的。
// 所以拖动期间把窗口朝光标方向带过去，让 clientX 始终留在窗口中间那片安全区里。
// 这里绝不能钉住她：她的坐标本来就跟着光标走，盒子一动、clientX 相对变小，
// 她的绝对位置才不会跑。
function followDrag(box) {
  const cursor = screen.getCursorScreenPoint();
  let localX = cursor.x - box.x, localY = cursor.y - box.y;
  // 有更好的数据就用它：preload 报来的是浏览器眼里的 clientX，正好是她的坐标系。
  if (dragPointer) { localX = dragPointer.x; localY = dragPointer.y; }
  const safeX = Math.min(DRAG_EDGE, Math.round(box.width / 2));
  const safeY = Math.min(DRAG_EDGE, Math.round(box.height / 2));
  let dx = 0, dy = 0;
  if (localX > box.width - safeX) dx = localX - (box.width - safeX);
  else if (localX < safeX) dx = localX - safeX;
  if (localY > box.height - safeY) dy = localY - (box.height - safeY);
  else if (localY < safeY) dy = localY - safeY;
  if (!dx && !dy) return;
  // 注意：这里只挪窗口，绝不能顺手把她钉住。
  // 她记的是「光标在窗口里的位置」，窗口往右挪 dx，光标在窗口里的坐标就小了 dx，
  // 她自己会往左走 dx —— 绝对位置刚好不动，还是老老实实挂在指头底下。
  // 要是这里再把她钉一次，两边就会互相较劲，松手时她会偏出去小半个身位。
  setBox(box.x + dx, box.y + dy);
  if (dragPointer) { dragPointer = { x: localX - dx, y: localY - dy }; }
}

// 她走近盒壁时，盒子朝那个方向让开，好让她继续往外走 —— 否则她的活动范围就被永久
// 锁死在 900×800 里，桌面中间凭空多出一堵看不见的墙。
//
// 让开的方式是「钉住她、挪盒子」：盒子往左 6px，她的 client 坐标就往右 6px，
// 绝对位置一像素都没变，而左边又空出了 6px 可以走。要是不钉住她，
// 盒子每 150ms 往左挪一点就等于把她一路推着走，她会自己滑到屏幕边上。
//
// 贴边（docked）是例外：插件把她钉死在窗口的左/右边缘（pet.js:152），
// 钉住她就等于让她一直贴着盒子边、盒子一路滑到那块屏的边上 —— 这正是想要的效果。
const PAN_EDGE = 170;
const PAN_STEP = 6;
function panWithHer(box, her) {
  const area = preferDisplay().workArea;
  const gapLeft = box.x - area.x;
  const gapRight = area.x + area.width - (box.x + box.width);
  const gapTop = box.y - area.y;
  const gapBottom = area.y + area.height - (box.y + box.height);
  // 贴边是一步到位：她已经挂在盒壁上了，盒子再慢慢挪 6px 就成了「墙在慢慢退」，
  // 看上去要好几秒才挪到屏边。这里直接把盒子搬到那块屏的边上，她跟着一起过去。
  if (her.x <= 0.5) { if (gapLeft > 0) setBox(area.x, box.y); return; }
  if (her.x >= box.width - 0.5) { if (gapRight > 0) setBox(area.x + area.width - box.width, box.y); return; }
  if (her.x < PAN_EDGE && gapLeft > 0) { moveBoxKeepingHer(box.x - Math.min(PAN_STEP, PAN_EDGE - her.x, gapLeft), box.y); return; }
  if (box.width - her.x < PAN_EDGE && gapRight > 0) { moveBoxKeepingHer(box.x + Math.min(PAN_STEP, PAN_EDGE - (box.width - her.x), gapRight), box.y); return; }
  if (her.y < PAN_EDGE && gapTop > 0) { moveBoxKeepingHer(box.x, box.y - Math.min(PAN_STEP, PAN_EDGE - her.y, gapTop)); return; }
  if (box.height - her.y < PAN_EDGE && gapBottom > 0) moveBoxKeepingHer(box.x, box.y + Math.min(PAN_STEP, PAN_EDGE - (box.height - her.y), gapBottom));
}

// 开机第一件事：把她放回上次待的那块桌面位置。
// 以前窗口铺满整屏，她存的是「占整屏的比例」；现在只有 900×800，直接套用会让她跳到角落。
// 她的比例没变（窗口 resize 时插件按比例把她带过来了），所以用旧窗口尺寸还原成绝对坐标。
function settleHerAtStartup(her) {
  if (!win || win.isDestroyed()) return;
  const box = win.getBounds();
  const saved = readState();
  let at = saved.herAt;
  if (!at) {
    // 老宿主铺满整块工作区：用她「占整屏的比例 × 那块屏」还原成绝对坐标，
    // 再拿它去摆新盒子，看上去她才像原地没动过。
    const previous = saved.lastBox || preferDisplay().workArea;
    at = { x: previous.x + (her.x / box.width) * previous.width, y: previous.y + (her.y / box.height) * previous.height };
  }
  setBox(at.x - her.x, at.y - her.y);
  log(`her on desktop at ${Math.round(at.x)},${Math.round(at.y)}; box ${win.getBounds().x},${win.getBounds().y} ${BOX.w}x${BOX.h}`);
}

// 菜单/面板只认她自己世界里的 pointerdown；合成一个「点在外面」的按下，等于替用户点了下空白。
function closeHerUi() {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(
    `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true })), 0`,
    true,
  ).catch(() => {});
}

// 她的气泡和菜单要能接收键盘（设置面板里的下拉框、输入框），所以窗口平时不可聚焦、
// 只在她的菜单被叫出来的时候借用一会儿焦点，用完自动还回去。
function grantFocus() {
  if (!win || win.isDestroyed()) return;
  win.setFocusable(true);
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.setFocusable(false); }, FOCUS_WINDOW_MS);
}

async function tick() {
  if (!win || win.isDestroyed() || !win.isVisible() || hitBusy) return;
  const cursor = screen.getCursorScreenPoint();
  const moved = cursor.x !== lastCursor.x || cursor.y !== lastCursor.y;
  lastCursor = cursor;
  if (pointerDown) {
    // 松手松在窗口外面的时候，pointerup 送不到页面，pointerDown 会一直卡着：
    // 她会停在「被拖住」的姿势，窗口也会跟着最后那个坐标乱跑。超过 1.5 秒没有任何
    // 指针事件就当手已经松开了。
    if (Date.now() - lastPointerAt > 1500) { pointerDown = false; dragPointer = null; }
    else { setIgnore(false); return; }
  }
  // 光标没动也要偶尔重问一次：她自己在屏幕上走来走去，随时可能走到光标底下；
  // 只跟着光标走的话，她蹭过来时仍然是穿透的，右键菜单就点不出来。
  //
  // 但整套「替你补一次鼠标移动」的做法会让她的内部时钟以为你一直在动，
  // 于是她再也不会打盹。所以整台机器超过十分钟没人碰之后就不再补，
  // 正好也是她该睡觉的时候——睡着的猫不需要接住停在她身上的光标。
  const now = Date.now();
  if (!moved && now - lastPollAt < IDLE_POLL_MS) return;
  const machineIdle = safeSystemIdle();
  if (!moved && machineIdle > SYNTH_IDLE_LIMIT_S) return;
  lastPollAt = now;
  const bounds = win.getBounds();
  const point = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
  // 窗口只是她周围那 900×800 的一圈，光标绝大多数时候根本不在里面。
  // 不在里面就一定不在她身上 —— 省掉一次 IPC，也不会误碰她的命中框。
  if (point.x < 0 || point.y < 0 || point.x >= bounds.width || point.y >= bounds.height) {
    if (overNow) { overNow = false; setIgnore(true); if (moved) closeHerUi(); }
    else setIgnore(true);
    return;
  }
  hitBusy = true;
  const wasOver = overNow;
  overNow = await overHer(point);
  hitBusy = false;
  if (process.env.HAGEMI_DEBUG && wasOver !== overNow) log(`over=${overNow} at ${cursor.x},${cursor.y} (window ${bounds.x},${bounds.y})`);
  setIgnore(!overNow);
  // 刚落到她身上的这一下，浏览器还没认；补一发真的输入，她的 pointerenter 才会来（额度气泡）。
  if (overNow && !wasOver) hoverInject(point);
  // 只在「光标真的挪开、并且刚好从她身上离开」的那一刻收一次 UI。
  // 不能连光标没动的轮询也算：她的设置面板是从菜单里点开的，面板往往不盖在光标底下，
  // 刚打开的那一轮轮询光标还停在原处，一补这个 pointerdown 就等于替用户立刻把面板点掉了。
  if (moved && wasOver && !overNow) closeHerUi();
}

// 整机多久没被人碰过（秒）。拿不到时按 0 处理：宁可多问几次，也别让她不理人。
function safeSystemIdle() {
  try { return powerMonitor.getSystemIdleTime(); } catch { return 0; }
}

// ---- 页面 ---------------------------------------------------------------------------

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Hagemi</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body { -webkit-user-select: none; user-select: none; }
</style></head><body>
<script>window.__APP_CONFIG__ = { host: 'hagemi-desktop' };</script>
<script src="/main.js"></script>
</body></html>`;

function startServer() {
  server = createServer((request, response) => {
    if (request.url === '/main.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('/* the app bundle the pet looks for; this host has none */\n');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// 换屏（或显示器参数变了）时，把盒子挪到那块屏上。盒子只有 900×800，
// 盖不到菜单栏，所以早先那条「菜单栏材质会把窗口内容采样进去、留下一条分割线」的坑
// 自然就不存在了 —— 窗口再也不会碰到菜单栏那一带。
function coverDisplay() {
  if (!win || win.isDestroyed()) return;
  const wanted = preferDisplay();
  const area = wanted.workArea;
  const box = win.getBounds();
  // 尽量待在原来的位置上；放不下就贴到那块屏的右下角（她默认也待在那儿）。
  const wantedX = box.width === BOX.w && box.x >= area.x && box.x + BOX.w <= area.x + area.width
    ? box.x : area.x + area.width - BOX.w;
  const wantedY = box.height === BOX.h && box.y >= area.y && box.y + BOX.h <= area.y + area.height
    ? box.y : area.y + area.height - BOX.h;
  if (wantedX === box.x && wantedY === box.y) return; // 盒子已经在这块屏上了，别把她晃一下
  moveBoxKeepingHer(wantedX, wantedY);
  log(`window ${BOX.w}x${BOX.h} @${wanted.scaleFactor}x on display ${wanted.id} (${wanted.label || 'unnamed'}) workArea`);
}

// 她在哪块屏上就留在哪块屏上：默认是主屏（带菜单栏那块，也是用户最常看的一块），
// 要换屏从托盘里选，选完记住。盒子跟着她走，所以换成小窗也不会限制她去哪。
function preferDisplay() {
  const all = screen.getAllDisplays();
  if (displayId != null) {
    const found = all.find(d => d.id === displayId);
    if (found) return found;
  }
  return screen.getPrimaryDisplay();
}

// 宿主的自己的小账本（哪块屏、窗口开着没有）。跟她的设置分开：
// settings.json 归插件所有，宿主不该往里塞别的东西。
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

let stateCache = null;
function writeState(patch) {
  // 普惠段每 150ms 就会调一次，没必要每次都读盘：读一次、改一笔，落盘也不频繁。
  if (!stateCache) stateCache = readState();
  stateCache = { ...stateCache, ...patch };
  try { fs.writeFileSync(STATE_FILE, `${JSON.stringify(stateCache, null, 2)}\n`); } catch (error) { log('state write failed', error.message); }
}

async function createWindow() {
  const port = await startServer();
  const saved = readState();
  if (displayId == null && Number.isFinite(saved.displayId)) displayId = saved.displayId;
  const display = preferDisplay();
  displayId = display.id;
  writeState({ displayId });
  // 盒子放在上次待的地方；第一次跑就贴右下角（她默认也站那儿）。
  // 老宿主铺满整屏，把那个尺寸记下来：她存的「比例」要按它才能还原成绝对坐标。
  const box = boxPosition(saved);
  if (!saved.lastBox) writeState({ lastBox: { x: display.workArea.x, y: display.workArea.y, width: display.workArea.width, height: display.workArea.height } });
  lastBounds = { x: box.x, y: box.y, width: BOX.w, height: BOX.h };
  win = new BrowserWindow({
    ...lastBounds,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    focusable: false,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  ignoring = true;
  win.webContents.on('context-menu', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  win.showInactive();
  log(`window ${BOX.w}x${BOX.h} at ${lastBounds.x},${lastBounds.y} @${display.scaleFactor}x, page:${port}`);
}

// 盒子的初始位置：上次停的地方；从没停过就贴那块屏的右下角。
function boxPosition(saved) {
  const area = preferDisplay().workArea;
  const fit = (x, y) => ({
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - BOX.w)),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - BOX.h)),
  });
  if (saved.box && Number.isFinite(saved.box.x) && Number.isFinite(saved.box.y)) return fit(saved.box.x, saved.box.y);
  return fit(area.x + area.width - BOX.w - 40, area.y + area.height - BOX.h - 40);
}

// ---- sidecar 监护 -------------------------------------------------------------------

// 插件的 ls-client 只认两个环境变量（ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN），
// 没有的话就自己去猜：翻 `ps` 找 language_server 的 argv 里的 --csrf_token。
// Antigravity 2.35 起这条路断了 —— token 从命令行挪进了进程环境，argv 里只剩
// `--read_host_bridge_token_from_stdin`。于是 sidecar 每次轮询都报
// 「Language server exposes no CSRF token」，HUD 上就是「Antigravity 未连接」。
//
// 新版本换了发牌方式：daemon/hub_<httpPort>.json 里明文写着 pid / 端口 / csrfToken。
// 宿主替她把这份凭据读出来，按插件本来就支持的方式用环境变量递过去 —— 插件一行不用改。
const ANTIGRAVITY_HOME = path.join(HOME, '.gemini', 'antigravity');
const HUB_DIR = path.join(ANTIGRAVITY_HOME, 'daemon');

// 换了 pid 的旧 hub 文件要跳过：只认进程还活着的那个。
function aliveLanguageServer(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readLanguageServer() {
  let names = [];
  try { names = fs.readdirSync(HUB_DIR).filter(name => /^hub_.*\.json$/.test(name)); } catch { return null; }
  let newest = null;
  for (const name of names) {
    try {
      const hub = JSON.parse(fs.readFileSync(path.join(HUB_DIR, name), 'utf8'));
      if (!hub || !hub.csrfToken || !hub.httpPort) continue;
      if (!aliveLanguageServer(Number(hub.pid))) continue;
      const stamp = Number(hub.httpPort); // 端口随重启递增，比文件 mtime 更可靠
      if (!newest || stamp > newest.stamp) newest = { hub, stamp, name };
    } catch { /* 文件正在被重写，下一轮再看 */ }
  }
  return newest;
}

function languageServerEnv() {
  const newest = readLanguageServer();
  if (!newest) return {};
  const { hub, name } = newest;
  log(`language server from ${name}: port ${hub.httpPort}, ls ${hub.lsVersion || '?'}`);
  return {
    ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${hub.httpPort}`,
    ANTIGRAVITY_CSRF_TOKEN: hub.csrfToken,
    ...(hub.lsVersion ? { ANTIGRAVITY_LS_VERSION: hub.lsVersion } : {}),
  };
}

// Antigravity 每次重启都会换端口、换 token，而环境变量只在 spawn 那一刻生效。
// 所以盯着这份凭据：一变就把 sidecar 重新拉起来（只拉她，不动 Antigravity）。
function watchLanguageServer() {
  setInterval(() => {
    if (quitting || !sidecar) return;
    const newest = readLanguageServer();
    if (!newest) return;
    const fingerprint = `${newest.hub.httpPort}:${newest.hub.csrfToken}`;
    if (!startedWith || fingerprint === startedWith) return;
    log(`language server changed (${startedWith.slice(0, 12)}… → ${fingerprint.slice(0, 12)}…), restarting sidecar`);
    startedWith = fingerprint;
    restartSidecar();
  }, 20000);
}

function seedSettings() {
  if (fs.existsSync(SETTINGS_FILE)) return;
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(path.join(ANTIGRAVITY_DATA, 'settings.json'), 'utf8')); } catch { /* 第一次跑，没有可继承的 */ }
  const seeded = { version: 2 };
  // 接着她在 Antigravity 窗口里的位置放，用户不用重新找一遍。
  if (previous.position) seeded.position = previous.position;
  // 桌面宿主不是 Antigravity 窗口，document.hasFocus() 几乎永远是 false；
  // 保持默认的 onlyWhenFocused 会让她彻底不说话。频率和额度上限照旧生效。
  seeded.ai = { onlyWhenFocused: false };
  try {
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(seeded, null, 2)}\n`);
    log('seeded settings', JSON.stringify(seeded));
  } catch (error) { log('seed failed', error.message); }
}

function startSidecar() {
  if (quitting) return;
  if (!fs.existsSync(SIDECAR)) {
    log('sidecar missing:', SIDECAR);
    dialog.showErrorBox(
      '找不到 Hagemi 插件',
      `请先安装插件：\nagy plugin install https://github.com/KCFindstr/hagemi-pet-agy\n\n期望位置：${PLUGIN_DIR}`,
    );
    app.quit();
    return;
  }
  seedSettings();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1', // 用 Electron 自带的 node 跑插件，不依赖系统里装没装 node 22
    HAGEMI_PROFILE_DIR: PROFILE_DIR, // 让她去找这个窗口的 DevTools 端口
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: DATA_DIR, // 设置和额度账本放宿主自己的目录
    ...languageServerEnv(), // Antigravity 2.35 起得由宿主把凭据递过去，见上面的注释
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_USE_ENV_PROXY;
  // 记下这次用的是哪一套凭据，watcher 靠它判断 Antigravity 有没有换过端口/token。
  startedWith = env.ANTIGRAVITY_CSRF_TOKEN ? `${env.ANTIGRAVITY_LS_ADDRESS.split(':')[1]}:${env.ANTIGRAVITY_CSRF_TOKEN}` : '';
  const out = fs.openSync(SIDECAR_LOG, 'a');
  fs.writeSync(out, `\n=== sidecar started ${new Date().toISOString()} ===\n`);
  const child = spawn(process.execPath, [SIDECAR], { cwd: path.join(PLUGIN_DIR, 'sidecars', 'pet'), env, stdio: ['ignore', out, out] });
  sidecar = child;
  log('sidecar pid', child.pid);
  child.on('exit', (code, signal) => {
    log(`sidecar exited code=${code} signal=${signal}`);
    try { fs.closeSync(out); } catch { /* already closed */ }
    // 只有「当前这一只」退出才需要再拉一只。restartSidecar() 会先把 sidecar 置空再杀，
    // 那次退出不该触发第二次 spawn，否则每换一次凭据就多攒一只孤儿。
    if (sidecar !== child) return;
    sidecar = null;
    if (quitting) return;
    // 插件自更新会让她自己退出一次，宿主负责把她请回来。
    restartDelay = Math.min(restartDelay * 2, 15000);
    setTimeout(startSidecar, restartDelay);
  });
  child.on('error', error => log('sidecar spawn failed', error.message));
}

function restartSidecar() {
  const previous = sidecar;
  sidecar = null;
  if (previous) { try { previous.kill('SIGTERM'); } catch { /* already gone */ } }
  restartDelay = 500;
  setTimeout(startSidecar, 800);
}

// ---- 开机自启 -----------------------------------------------------------------------
//
// 宿主不是一个 .app 包，所以走 LaunchAgent：LaunchAgent 里写的就是「这个 Electron 二进制
// 加这个目录」，和现在手动启动完全同一条命令。

function autoStartEnabled() { return fs.existsSync(PLIST); }

function launchctl(args) {
  execFile('launchctl', args, error => { if (error) log('launchctl', args[0], error.message); });
}

// 打包成 .app 之后，开机自启该启动的是那个包，而不是「二进制 + 目录」。
// 打包成 .app 之后，开机自启直接跑包里的可执行文件：这样 launchd 盯着的就是宿主本身，
// 它崩了会被拉起来；用 `open` 的话 launchd 只看得到 open 早就退出了。
function launchTarget() {
  if (process.platform !== 'darwin') return [process.execPath, APP_DIR, '--launchd'];
  const bundle = path.resolve(process.execPath, '..', '..', '..'); // .../X.app/Contents/MacOS/X → X.app
  if (bundle.endsWith('.app') && fs.existsSync(path.join(bundle, 'Contents', 'Info.plist'))) {
    return [process.execPath, '--launchd'];
  }
  return [process.execPath, APP_DIR, '--launchd'];
}

function setAutoStart(enabled) {
  try {
    if (enabled) {
      const args = launchTarget().map(arg => `    <string>${arg}</string>`).join('\n');
      fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.hagemi.desktop</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>${path.join(LOG_DIR, 'launchd.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(LOG_DIR, 'launchd.err.log')}</string>
</dict></plist>
`);
      launchctl(['bootout', `gui/${process.getuid()}`, PLIST]);
      launchctl(['bootstrap', `gui/${process.getuid()}`, PLIST]);
    } else {
      launchctl(['bootout', `gui/${process.getuid()}`, PLIST]);
      fs.rmSync(PLIST, { force: true });
    }
  } catch (error) {
    log('auto start failed', error.message);
  }
  refreshTray();
}

// ---- 托盘 ---------------------------------------------------------------------------

// 屏幕不止一块时，让她去指定的那块。选完记下来，下次开机还在原地。
function moveToDisplay(id) {
  const found = screen.getAllDisplays().find(d => d.id === id);
  if (!found) return;
  displayId = found.id;
  writeState({ displayId });
  coverDisplay();
  refreshTray();
}

function displayMenuItems() {
  const all = screen.getAllDisplays();
  if (all.length < 2) return [];
  return [{
    label: '她在哪块屏',
    submenu: all.map((display, index) => ({
      label: `${display.label || `显示器 ${index + 1}`} · ${display.bounds.width}×${display.bounds.height}`,
      type: 'radio',
      checked: display.id === displayId,
      click: () => moveToDisplay(display.id),
    })),
  }];
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: win && win.isVisible() ? '隐藏她' : '显示她',
      click: () => {
        if (!win) return;
        if (win.isVisible()) win.hide(); else win.showInactive();
        refreshTray();
      },
    },
    { type: 'separator' },
    { label: '让她重新醒来', click: () => restartSidecar() },
    ...displayMenuItems(),
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: autoStartEnabled(), click: item => setAutoStart(item.checked) },
    { label: '打开设置文件夹', click: () => shell.openPath(DATA_DIR) },
    { label: '查看日志', click: () => shell.openPath(LOG_DIR) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  let image = nativeImage.createEmpty();
  try { image = nativeImage.createFromPath(PLUGIN_LOGO).resize({ width: 18, height: 18 }); } catch { /* 没图标也能用 */ }
  tray = new Tray(image);
  tray.setToolTip('Hagemi');
  refreshTray();
}

// ---- 启动 ---------------------------------------------------------------------------

// 命令行开关：给安装脚本和排查用，不需要点托盘。
function cliFlag(name) { return process.argv.includes(`--${name}`); }

if (cliFlag('autostart') || cliFlag('no-autostart')) {
  // 光跑开关不该把她叫醒，起文件系统动作后立刻退出。
  app.whenReady().then(() => {
    setAutoStart(cliFlag('autostart'));
    log(`autostart ${cliFlag('autostart') ? 'enabled' : 'disabled'} via cli`);
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) win.showInactive(); });
  ipcMain.on('hagemi-desktop:pointer-down', () => { pointerDown = true; lastPointerAt = Date.now(); grantFocus(); });
  ipcMain.on('hagemi-desktop:pointer-up', () => { pointerDown = false; dragPointer = null; lastPointerAt = Date.now(); });
  // 拖动途中每一帧都跟：等 150ms 的轮询再挪窗口太慢，光标一快就直接出窗，
  // 出窗之后浏览器不再给她 pointermove，她当场停住——所以这里收到一帧就挪一帧。
  ipcMain.on('hagemi-desktop:pointer-move', (event, point) => {
    if (!pointerDown || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    dragPointer = { x: point.x, y: point.y };
    lastPointerAt = Date.now();
    if (!win || win.isDestroyed()) return;
    followDrag(win.getBounds());
  });
  ipcMain.on('hagemi-desktop:menu', () => grantFocus());

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    await createWindow();
    createTray();
    startSidecar();
    watchLanguageServer();
    setInterval(tick, TICK_MS);
    // 她什么时候挂上是 sidecar 决定的（CDP 一连上她就出现），所以位置这件事只能轮询着等。
    setInterval(probeHer, PROBE_MS);
    setInterval(coverDisplay, 5000);
    screen.on('display-metrics-changed', () => coverDisplay());
    screen.on('display-added', () => coverDisplay());
    screen.on('display-removed', () => coverDisplay());
    powerMonitor.on('resume', () => { coverDisplay(); if (win) win.showInactive(); });
    log('host ready');
  });

  app.on('window-all-closed', event => event.preventDefault());
  app.on('before-quit', () => {
    quitting = true;
    if (sidecar) { try { sidecar.kill('SIGTERM'); } catch { /* already gone */ } }
    if (server) { try { server.close(); } catch { /* already closed */ } }
  });
}
