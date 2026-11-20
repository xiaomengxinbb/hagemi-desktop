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
let pointerDown = false;
let hitBusy = false;
let ignoring = true;
let lastCursor = { x: -1, y: -1 };
let focusTimer = null;
let displayId = null; // 她安家在哪块屏
let lastBounds = null;
let lastPollAt = 0;
let overNow = false; // 上一轮轮询里光标是不是在她身上

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
  if (pointerDown) { setIgnore(false); return; }
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

// 窗口铺满「工作区」而不是整块屏：菜单栏那 30px 不能盖。
// 盖住菜单栏的时候，macOS 会把菜单栏的半透明材质改成「采样窗口内容」，
// 于是菜单栏下沿会出现一条明显的亮/暗分界线——大屏上尤其刺眼。
// 反正她本来也进不去菜单栏（keepInBounds 会把她推下来），窗口退让 30px 没有损失。
function coverDisplay() {
  if (!win || win.isDestroyed()) return;
  const wanted = preferDisplay();
  const bounds = wanted.workArea;
  if (lastBounds && lastBounds.x === bounds.x && lastBounds.y === bounds.y && lastBounds.width === bounds.width && lastBounds.height === bounds.height) return;
  lastBounds = bounds;
  win.setBounds(bounds);
  log(`window ${bounds.width}x${bounds.height} @${wanted.scaleFactor}x on display ${wanted.id} (${wanted.label || 'unnamed'}) workArea`);
}

// 她在哪块屏上就留在哪块屏上：默认是主屏（带菜单栏那块，也是用户最常看的一块），
// 要换屏从托盘里选，选完记住。整窗铺满是为了让她的坐标系和屏幕一致。
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

function writeState(patch) {
  try { fs.writeFileSync(STATE_FILE, `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`); } catch (error) { log('state write failed', error.message); }
}

async function createWindow() {
  const port = await startServer();
  const saved = readState();
  if (displayId == null && Number.isFinite(saved.displayId)) displayId = saved.displayId;
  const display = preferDisplay();
  displayId = display.id;
  writeState({ displayId });
  lastBounds = display.workArea;
  win = new BrowserWindow({
    ...display.workArea,
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
  log(`window ${display.workArea.width}x${display.workArea.height} @${display.scaleFactor}x, page:${port}`);
}

// ---- sidecar 监护 -------------------------------------------------------------------

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
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_USE_ENV_PROXY;
  const out = fs.openSync(SIDECAR_LOG, 'a');
  fs.writeSync(out, `\n=== sidecar started ${new Date().toISOString()} ===\n`);
  sidecar = spawn(process.execPath, [SIDECAR], { cwd: path.join(PLUGIN_DIR, 'sidecars', 'pet'), env, stdio: ['ignore', out, out] });
  log('sidecar pid', sidecar.pid);
  sidecar.on('exit', (code, signal) => {
    log(`sidecar exited code=${code} signal=${signal}`);
    sidecar = null;
    try { fs.closeSync(out); } catch { /* already closed */ }
    if (quitting) return;
    // 插件自更新会让她自己退出一次，宿主负责把她请回来。
    restartDelay = Math.min(restartDelay * 2, 15000);
    setTimeout(startSidecar, restartDelay);
  });
  sidecar.on('error', error => log('sidecar spawn failed', error.message));
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
  ipcMain.on('hagemi-desktop:pointer-down', () => { pointerDown = true; grantFocus(); });
  ipcMain.on('hagemi-desktop:pointer-up', () => { pointerDown = false; });
  ipcMain.on('hagemi-desktop:menu', () => grantFocus());

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    await createWindow();
    createTray();
    startSidecar();
    setInterval(tick, TICK_MS);
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
