'use strict';
/**
 * 页面与宿主之间唯一的一条通道。
 *
 * 平时窗口是点击穿透的，只有光标落到她身上才接管鼠标。她一旦被按住拖动，指针很快
 * 就会离开她的身体，但拖动还没结束——宿主得知道这段时间不能把鼠标还回去。
 *
 * 只认可信事件：宿主自己会合成 pointerdown 去关掉她的菜单，那种事件不能算「用户按着」。
 */
const { ipcRenderer } = require('electron');

const DOWN = 'hagemi-desktop:pointer-down';
const UP = 'hagemi-desktop:pointer-up';
const MENU = 'hagemi-desktop:menu';
const MOVE = 'hagemi-desktop:pointer-move';

window.addEventListener('pointerdown', event => {
  if (!event.isTrusted) return;
  ipcRenderer.send(DOWN);
  // 菜单（右键）和设置面板（从菜单里点开）需要键盘：这时才向系统借一次焦点。
  if (event.button === 2) ipcRenderer.send(MENU);
}, true);

// 拖动途中把指针位置实时报给宿主。窗口只有 900×800，她一旦被拖到窗口边上，
// 光标再动就出窗了 —— 出窗之后 clientX 会超过 innerWidth，她自己会把自己钳在边上，
// 看起来就是「不跟手、还突然贴到边上去了」。宿主拿到每一帧的 clientX 就能把窗口
// 跟着光标挪走，光标永远待在窗口里。
window.addEventListener('pointermove', event => {
  if (!event.isTrusted || !event.buttons) return;
  ipcRenderer.send(MOVE, { x: event.clientX, y: event.clientY });
}, true);

for (const type of ['pointerup', 'pointercancel']) {
  window.addEventListener(type, event => { if (event.isTrusted) ipcRenderer.send(UP); }, true);
}
window.addEventListener('blur', () => ipcRenderer.send(UP), true);
window.addEventListener('contextmenu', event => {
  if (event.isTrusted) ipcRenderer.send(MENU);
}, true);
