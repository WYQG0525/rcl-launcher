'use strict';
// 路径定位：内置资源（只读）与用户数据（可写）分离。
// 内置资源在打包后位于 Electron resources/assets，开发态位于仓库 assets。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function isReady(p) { try { return fs.existsSync(p); } catch { return false; } }

// Electron 环境用 appData；脚本/测试环境回落到 %APPDATA%（便于脱离界面单测启动内核）
function dataRoot() {
  if (process.env.MCL_DATA) return process.env.MCL_DATA;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('appData'), 'RCL');
  } catch { /* 非 Electron */ }
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'RCL');
}

function ensureDirs(root) {
  const dirs = {
    root,
    servers: path.join(root, 'servers'),
    games: path.join(root, 'games'),
    runtime: path.join(root, 'runtime'),
    store: path.join(root, 'store'),
    versions: path.join(root, 'store', 'versions'),
    libraries: path.join(root, 'store', 'libraries'),
    assets: path.join(root, 'store', 'assets'),
    paper: path.join(root, 'store', 'paper'),
    fabric: path.join(root, 'store', 'fabric'),
    forge: path.join(root, 'store', 'forge'),
    natives: path.join(root, 'store', 'natives'),
    meta: path.join(root, 'store', 'meta'),
    logs: path.join(root, 'logs'),
    settings: path.join(root, 'settings.json'),
    instances: path.join(root, 'instances.json'),
    gamesIndex: path.join(root, 'games.json'),
  };
  for (const k of ['root', 'servers', 'games', 'runtime', 'store', 'versions', 'libraries', 'assets', 'paper', 'fabric', 'natives', 'meta', 'logs']) {
    try { fs.mkdirSync(dirs[k], { recursive: true }); } catch { /* 只读盘时留给上层报错 */ }
  }
  return dirs;
}

function sanitizeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'server';
}

function dirSizeSync(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* ignore */ } }
    }
  }
  return total;
}

module.exports = { dataRoot, ensureDirs, sanitizeName, dirSizeSync, isReady };
