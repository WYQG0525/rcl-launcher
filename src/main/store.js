'use strict';
// 设置与实例登记（JSON 落盘，原子写入）

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { dataRoot, ensureDirs, sanitizeName } = require('./paths');

const DEFAULT_SETTINGS = {
  theme: 'dark',
  mirror: 'bmclapi',
  subRoot: '',            // 相对默认数据目录的服务器根，留空则用默认
  memoryMB: 4096,
  jvmPreset: 'paper',     // none | paper(Paper 推荐) | aikar | custom
  jvmArgs: '',
  autoEula: true,
  autoRestart: false,
  maxRestarts: 3,
  closeAction: 'ask',      // ask 每次问 | tray 关到托盘 | quit 直接退出
  trayTipShown: false,
  javaAuto: true,
  javaByMajor: {},        // "17": "D:/xx/bin/java.exe"
  showDebugLine: false,
  concurrency: 8,
  curseApiKey: '',        // CurseForge 官方接口必须，留空则该源不可用
  msClientId: '',         // 微软正版登录用的 Azure 应用客户端 ID
  updateFeed: '',         // RCL 自身更新源：返回 {version,url,notes} 的 JSON 地址
  isolation: 'all',       // 版本隔离策略：off | all | modded | modded-nonrelease（只影响新建档案）
  contentSource: 'modrinth',
};

const DEFAULT_INSTANCE = {
  core: 'vanilla',
  coreVersion: null,
  paperJar: null,
  memoryMB: null,
  jvmPreset: null,
  jvmArgs: '',
  javaMajor: null,
  javaPath: null,
  port: 25565,
  onlineMode: true,
  maxPlayers: 20,
  motd: '一个新的 Minecraft 服务器！',
  levelName: 'world',
  difficulty: 'easy',
  viewDistance: 10,
  gamemode: 'survival',
  autoRestart: null,
  installed: false,
  createdAt: Date.now(),
  lastStart: null,
  lastExit: null,
};

const DEFAULT_GAME = {
  mcVersion: '1.21.1',
  username: 'Player',
  authType: 'offline',      // offline | microsoft | aai
  authName: '',             // 微软/第三方账号名，留空则用 username
  aaiRoot: '',              // authlib-injector 服务器地址（type=aai 时生效）
  uuid: null,
  dir: null,                // 指向磁盘上已有的游戏目录（导入的档案），为空则用数据目录下的 games/<档案名>
  loader: null,             // { type: 'fabric'|'forge', version } —— 整合包或导入的模组档案才有的
  memoryMB: null,
  jvmArgs: '',
  gameArgs: '',
  javaPath: null,
  width: 1280,
  height: 720,
  fullscreen: false,
  server: '',
  installed: false,
  createdAt: Date.now(),
  lastStart: null,
  lastExit: null,
};

class Store {
  constructor(root) {
    this.root = root || dataRoot();
    this.dirs = ensureDirs(this.root);
    this.legacyMoved = this.migrateLegacy();
    this.settings = { ...DEFAULT_SETTINGS };
    this.instances = [];
    this.games = [];
    this.load();
  }

  // 老版本（RCL 之前叫 MCServerLauncher）的数据目录迁移：只补空，绝不覆盖已有文件
  migrateLegacy() {
    const moved = [];
    const old = path.join(path.dirname(this.root), 'MCServerLauncher');
    if (!fs.existsSync(old) || path.resolve(old) === path.resolve(this.root)) return moved;
    for (const f of ['settings.json', 'instances.json', 'games.json']) {
      const src = path.join(old, f);
      const dst = path.join(this.root, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.copyFileSync(src, dst); moved.push(f); } catch { /* 复制失败就用新目录 */ }
      }
    }
    for (const d of ['servers', 'games']) {
      const src = path.join(old, d);
      const dst = path.join(this.root, d);
      let has = [];
      try { has = fs.readdirSync(src); } catch { continue; }
      let empty = true;
      try { empty = fs.readdirSync(dst).length === 0; } catch { /* 目标不存在，视为空 */ }
      if (has.length && empty) {
        try { fs.cpSync(src, dst, { recursive: true }); moved.push(d + '/'); } catch { /* 占用则跳过 */ }
      }
    }
    return moved;
  }

  load() {
    try {
      const raw = fs.readFileSync(this.dirs.settings, 'utf8');
      this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { /* 首次运行 */ }
    try {
      this.instances = JSON.parse(fs.readFileSync(this.dirs.instances, 'utf8'));
      if (!Array.isArray(this.instances)) this.instances = [];
    } catch { this.instances = []; }
    try {
      this.games = JSON.parse(fs.readFileSync(this.dirs.gamesIndex, 'utf8'));
      if (!Array.isArray(this.games)) this.games = [];
    } catch { this.games = []; }
  }

  static writeAtomic(file, text) {
    const tmp = file + '.tmp';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  }

  saveSettings() { Store.writeAtomic(this.dirs.settings, JSON.stringify(this.settings, null, 2)); }
  saveInstances() { Store.writeAtomic(this.dirs.instances, JSON.stringify(this.instances, null, 2)); }

  patchSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.saveSettings();
    return this.settings;
  }

  serversRoot() {
    const sub = this.settings.subRoot;
    if (!sub) return this.dirs.servers;
    return path.isAbsolute(sub) ? sub : path.join(this.dirs.servers, sanitizeName(sub));
  }

  instanceDir(inst) { return path.join(this.serversRoot(), sanitizeName(inst.name)); }

  createInstance(input) {
    const name = sanitizeName(input.name || `服务器 ${this.instances.length + 1}`);
    if (this.instances.some((i) => sanitizeName(i.name) === name)) throw new Error('已有同名实例，换一个名字');
    const inst = { ...DEFAULT_INSTANCE, id: crypto.randomUUID(), name };
    for (const k of ['mcVersion', 'core', 'coreVersion', 'paperJar', 'memoryMB', 'jvmPreset', 'jvmArgs', 'gameArgs', 'javaMajor', 'javaPath', 'port', 'onlineMode', 'maxPlayers', 'motd', 'levelName', 'difficulty', 'viewDistance', 'gamemode', 'autoRestart']) {
      if (input[k] !== undefined && input[k] !== null && input[k] !== '') inst[k] = input[k];
    }
    fs.mkdirSync(this.instanceDir(inst), { recursive: true });
    this.instances.push(inst);
    this.saveInstances();
    return inst;
  }

  get(id) { return this.instances.find((i) => i.id === id) || null; }

  patch(id, patch) {
    const inst = this.get(id);
    if (!inst) throw new Error('实例不存在');
    const oldDir = this.instanceDir(inst);
    Object.assign(inst, patch);
    if (patch.name) inst.name = sanitizeName(patch.name);
    this.saveInstances();
    const newDir = this.instanceDir(inst);
    if (newDir !== oldDir && fs.existsSync(oldDir)) {
      try { fs.renameSync(oldDir, newDir); } catch { /* 目录被占用时保留旧目录，下次再试 */ }
    }
    return inst;
  }

  remove(id, { deleteFiles = false } = {}) {
    const inst = this.get(id);
    if (!inst) return false;
    this.instances = this.instances.filter((i) => i.id !== id);
    this.saveInstances();
    if (deleteFiles) {
      try { fs.rmSync(this.instanceDir(inst), { recursive: true, force: true }); } catch { /* 运行中无法删除 */ }
    }
    return true;
  }

  /* ---------------- 游戏（客户端）档案 ---------------- */
  saveGames() { Store.writeAtomic(this.dirs.gamesIndex, JSON.stringify(this.games, null, 2)); }

  // 导入的档案直接用它原来的目录，不搬家也不复制
  gameDir(game) { return game && game.dir ? path.resolve(game.dir) : path.join(this.dirs.games, sanitizeName(game ? game.name : 'game')); }

  createGame(input) {
    const name = sanitizeName(input.name || `玩家 ${this.games.length + 1}`);
    if (this.games.some((g) => sanitizeName(g.name) === name)) throw new Error('已有同名游戏档案，换一个名字');
    if (input.dir) {
      const d = path.resolve(input.dir);
      const ours = path.resolve(path.dirname(d)) === path.resolve(this.dirs.games);
      if (fs.existsSync(d)) {
        if (!fs.statSync(d).isDirectory()) throw new Error(`那个位置是个文件不是目录：${d}`);
      } else if (!ours) {
        // 隔离策略的共享根允许还不存在（下面会建）；导入别人已有目录必须已经存在
        throw new Error(`目录不存在：${d}`);
      }
    }
    const g = { ...DEFAULT_GAME, id: crypto.randomUUID(), name };
    // 登录方式与账号必须一起落盘，否则建完档案永远是离线
    for (const k of ['mcVersion', 'username', 'authType', 'authName', 'aaiRoot', 'uuid', 'memoryMB', 'jvmArgs', 'gameArgs', 'javaPath', 'width', 'height', 'fullscreen', 'server', 'dir', 'loader']) {
      if (input[k] !== undefined && input[k] !== null && input[k] !== '') g[k] = input[k];
    }
    if (!g.username) g.username = name.replace(/\s/g, '').slice(0, 16) || 'Player';
    fs.mkdirSync(this.gameDir(g), { recursive: true });
    this.games.push(g);
    this.saveGames();
    return g;
  }

  getGame(id) { return this.games.find((g) => g.id === id) || null; }

  patchGame(id, patch) {
    const g = this.getGame(id);
    if (!g) throw new Error('游戏档案不存在');
    const oldDir = this.gameDir(g);
    Object.assign(g, patch);
    if (patch.name) g.name = sanitizeName(patch.name);
    this.saveGames();
    const newDir = this.gameDir(g);
    // 导入的档案目录是用户自己的，改档案名不能顺手把人家的文件夹搬走
    if (!g.dir && newDir !== oldDir && fs.existsSync(oldDir)) {
      try { fs.renameSync(oldDir, newDir); } catch { /* 占用时保留旧目录 */ }
    }
    return g;
  }

  removeGame(id, { deleteFiles = false } = {}) {
    const g = this.getGame(id);
    if (!g) return false;
    this.games = this.games.filter((x) => x.id !== id);
    this.saveGames();
    if (deleteFiles && !g.dir) {
      try { fs.rmSync(this.gameDir(g), { recursive: true, force: true }); } catch { /* 运行中 */ }
    }
    return true;
  }
}

/* ---------------- 导入：探测磁盘上已有的游戏目录 ---------------- */

const MC_IN_ID = /\d+\.\d+(\.\d+)?/;

function mainClassOf(j) {
  if (typeof j.mainClass === 'string') return j.mainClass;
  if (j.mainClass && typeof j.mainClass === 'object') return j.mainClass.client || j.mainClass.common || j.mainClass.server || '';
  return '';
}

// 从版本 json 里认加载器：Fabric 看 KnotClient / loader 库，Forge 看 bootstraplauncher
function loaderOf(j) {
  const main = mainClassOf(j);
  const id = String(j.id || '');
  const libs = (j.libraries || []).map((l) => String(l.name || ''));
  if (/knot\.Knot/i.test(main) || /fabricmc/.test(libs.join(' ')) || /fabric/i.test(id)) {
    const hit = libs.find((n) => /net\.fabricmc:fabric-loader:/.test(n));
    return { type: 'fabric', version: (hit || '').split(':').pop() || (id.match(/fabric-loader[-_:]?([\d.]+)/) || [])[1] || '' };
  }
  if (/bootstraplauncher|ForgeClientLauncher|net\.minecraftforge/.test(main) || /libraries\/net\/minecraftforge/.test(libs.join(' ')) || /(^|[^a-z])forge([^a-z]|$)/i.test(id)) {
    const hit = libs.find((n) => /:forge:|:fmlloader:/.test(n));
    return { type: 'forge', version: (hit || '').split(':').pop() || (id.match(/forge[-_ ]?([\d.]+(?:-[\w.]+)?)/i) || [])[1] || '' };
  }
  if (/neoforge/i.test(main) || /neoforge/i.test(libs.join(' ')) || /neoforge/i.test(id)) {
    return { type: 'neoforge', version: (id.match(/neoforge[-_ ]?([\d.]+)/i) || [])[1] || '' };
  }
  return null;
}

function readJsonFile(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function subdirs(d) { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } }
function filesIn(d, re) { try { return fs.readdirSync(d).filter((f) => re.test(f)); } catch { return []; } }

function probeGameDir(dir) {
  const abs = path.resolve(String(dir || ''));
  let stat;
  try { stat = fs.statSync(abs); } catch { throw new Error('这个路径读不到，检查一下有没有写错'); }
  if (!stat.isDirectory()) throw new Error('这不是一个目录');
  const has = (p) => fs.existsSync(path.join(abs, p));

  const versions = [];
  const seen = new Set();
  const take = (jsonFile, fallbackId) => {
    const j = readJsonFile(jsonFile);
    if (!j || (!j.mainClass && !j.inheritsFrom)) return;
    const id = String(j.id || fallbackId);
    if (seen.has(id)) return;
    seen.add(id);
    versions.push({
      id,
      mc: j.inheritsFrom || (id.match(MC_IN_ID) || [])[0] || null,
      loader: loaderOf(j),
      mainClass: mainClassOf(j),
      json: jsonFile,
      hasJar: fs.existsSync(jsonFile.replace(/\.json$/i, '.jar')),
    });
  };

  for (const d of subdirs(path.join(abs, 'versions'))) {
    const vd = path.join(abs, 'versions', d);
    const exact = path.join(vd, `${d}.json`);
    if (fs.existsSync(exact)) take(exact, d);
    else for (const f of filesIn(vd, /\.json$/i)) take(path.join(vd, f), d);
  }
  // 也可能直接指到某个版本目录本身（里面就一个同名 json）
  if (!versions.length) for (const f of filesIn(abs, /\.json$/i)) take(path.join(abs, f), path.basename(abs));

  versions.sort((a, b) => String(b.mc || b.id).localeCompare(String(a.mc || a.id), undefined, { numeric: true }));
  const mods = filesIn(path.join(abs, 'mods'), /\.(jar|zip)$/i);
  return {
    dir: abs,
    name: path.basename(abs),
    isGameRoot: has('versions') || has('assets') || has('saves') || has('mods') || has('logs') || has('launcher_profiles.json'),
    versions,
    saves: subdirs(path.join(abs, 'saves')).length,
    resourcepacks: filesIn(path.join(abs, 'resourcepacks'), /\.zip$/i).length,
    shaderpacks: filesIn(path.join(abs, 'shaderpacks'), /\.zip$/i).length,
    mods: mods.length,
    modBytes: mods.reduce((s, f) => { try { return s + fs.statSync(path.join(abs, 'mods', f)).size; } catch { return s; } }, 0),
  };
}

module.exports = { Store, DEFAULT_SETTINGS, DEFAULT_INSTANCE, DEFAULT_GAME, probeGameDir, loaderOf };
