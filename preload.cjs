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

window.addEventListener('pointerdown', event => {
  if (!event.isTrusted) return;
  ipcRenderer.send(DOWN);
  // 菜单（右键）和设置面板（从菜单里点开）需要键盘：这时才向系统借一次焦点。
  if (event.button === 2) ipcRenderer.send(MENU);
}, true);

for (const type of ['pointerup', 'pointercancel']) {
  window.addEventListener(type, event => { if (event.isTrusted) ipcRenderer.send(UP); }, true);
}
window.addEventListener('blur', () => ipcRenderer.send(UP), true);
window.addEventListener('contextmenu', event => {
  if (event.isTrusted) ipcRenderer.send(MENU);
}, true);
