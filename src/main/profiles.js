'use strict';
// 启动计划：把"实例 + 核心 + 本地已下载的文件"翻译成可执行的 java 命令行。
// 所有文件都在数据目录（%APPDATA%\RCL\store）里，由 remote.js 负责下载，程序本体不再内置 MC 内容。

const fs = require('node:fs');
const path = require('node:path');
const { resolveProfile } = require('./minecraft');
const { isReady } = require('./paths');
const bundler = require('./bundler');

const VANILLA_SERVER_MAIN = 'net.minecraft.server.Main';

// 实测能启动的 JVM 参数预设（Paper 的推荐参数在安装核心时按版本写入 paper/index.json）
const JVM_PRESETS = {
  none: { name: '不加额外参数', flags: [] },
  aikar: {
    name: 'Aikar 流式 GC 参数（经典）',
    flags: ['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch', '-XX:+PerfDisableSharedMem', '-XX:G1NewSizePercent=40', '-XX:G1MaxNewSizePercent=50', '-XX:G1HeapRegionSize=16M', '-XX:G1ReservePercent=15', '-XX:G1MixedGCCountTarget=4', '-XX:InitiatingHeapOccupancyPercent=20', '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32', '-XX:MaxTenuringThreshold=1'],
  },
  vanilla: { name: '官方默认（G1）', flags: ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=200'] },
};

class Catalog {
  constructor(dirs) {
    this.dirs = dirs;
    this.extractCache = new Map();
    this.settings = null;   // 用 boot() 里挂的 isolationMode() 读，别缓存 store.settings（patchSettings 会整体换对象）
    this.paperIndex = readJson(path.join(dirs.paper, 'index.json'), {});
    this.fabricIndex = readJson(path.join(dirs.fabric, 'index.json'), {});
    this.forgeIndex = readJson(path.join(dirs.forge, 'index.json'), {});
    this.neoforgeIndex = (readJson(path.join(dirs.neoforge, 'index.json'), {}) || {}).byMc || {};
  }

  versionDir(mc) { return path.join(this.dirs.versions, mc); }
  versionJsonPath(mc) { return path.join(this.versionDir(mc), `${mc}.json`); }
  serverJar(mc) { return path.join(this.versionDir(mc), `${mc}-server.jar`); }
  clientJar(mc) { return path.join(this.versionDir(mc), `${mc}-client.jar`); }

  versionJson(mc) {
    const p = this.versionJsonPath(mc);
    if (!isReady(p)) throw new Error(`还没下载 ${mc} 的版本信息，去「下载」页拉取`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  hasVersion(mc) { return isReady(this.versionJsonPath(mc)); }

  javaMajor(mc) {
    const j = this.versionJson(mc);
    return (j.javaVersion && j.javaVersion.major) || require('./minecraft').RUNTIME_MAJOR[(j.javaVersion || {}).component] || 17;
  }

  // extraRoots：档案自带的 libraries（导入的 Forge/Fabric 目录、整合包装出来的），优先于共享库
  findLib(mavenPathRel, extraRoots = []) {
    for (const root of extraRoots) {
      const p = path.join(root, mavenPathRel);
      if (isReady(p)) return p;
    }
    const p = path.join(this.dirs.libraries, mavenPathRel);
    return isReady(p) ? p : null;
  }

  // 隔离策略（照 PCL2 的五档）决定库放哪：
  //   off=全共享；all=全隔离；modded=带加载器的版本隔离；nonrelease=非正式版隔离；modded-nonrelease=两者之一
  versionIsRelease(mc) {
    try {
      const t = readJson(this.versionJsonPath(mc), {}).type;
      return !t || t === 'release';
    } catch { return true; }
  }

  hasLoader(mc) {
    return !!(this.fabricIndex[mc] || this.neoforgeIndex[mc] || (this.forgeIndex[mc] && this.forgeIndex[mc].length));
  }

  isolatedFor(mc, { loader = false } = {}) {
    const mode = (typeof this.isolationMode === 'function' ? this.isolationMode() : 'all') || 'all';
    if (mode === 'off') return false;
    if (mode === 'all') return true;
    const modded = loader || this.hasLoader(mc);
    if (mode === 'modded') return modded;
    if (mode === 'nonrelease') return !this.versionIsRelease(mc);
    if (mode === 'modded-nonrelease') return modded || !this.versionIsRelease(mc);
    return false;
  }

  // 隔离时加载器/版本的库放版本目录里，删版本就能彻底回收；共享池仍作只读回退，避免老数据重下
  versionLibDir(mc) { return path.join(this.versionDir(mc), 'libraries'); }

  libRoots(mc, gameDir) {
    const out = [];
    if (gameDir) out.push(path.join(gameDir, 'libraries'));
    if (mc && this.isolatedFor(mc)) out.push(this.versionLibDir(mc));
    return out;
  }

  checkLibs(libs, extraRoots = []) {
    const missing = [];
    const resolved = [];
    for (const l of libs) {
      const hit = this.findLib(l.path, extraRoots);
      if (hit) resolved.push(hit);
      else missing.push({ path: l.path, urls: l.urls || [l.url], sha1: l.sha1 || null, size: l.size || 0 });
    }
    return { resolved, missing };
  }

  // 原版服务端：bundler jar 自包含，解包一次后各实例共用
  vanilla(mc) {
    if (this.extractCache.has(mc)) return this.extractCache.get(mc);
    const jar = this.serverJar(mc);
    if (!isReady(jar)) throw new Error(`还没下载 ${mc} 的服务端 jar，去「下载」页选「服务端」`);
    let out;
    try {
      const dest = path.join(this.versionDir(mc), 'bundler');
      const r = bundler.extract(jar, dest);
      out = { mc, dir: dest, mainClass: r.mainClass || VANILLA_SERVER_MAIN, cp: r.cp, source: 'bundler', missing: [], javaMajor: this.safeJavaMajor(mc), note: r.cached ? `${mc} 依赖已解包，直接复用` : `${mc} 首次解包 ${r.count} 个内嵌 jar（各服共用）` };
    } catch (e) {
      const prof = resolveProfile(this.versionJson(mc), { server: true });
      const check = this.checkLibs(prof.libraries, this.libRoots(mc));
      let main = prof.mainClass;
      if (!main || /client\.main\.Main$/.test(main)) main = VANILLA_SERVER_MAIN;
      out = { mc, dir: this.dirs.libraries, mainClass: main, cp: [...check.resolved, jar], source: 'libs', missing: check.missing, javaMajor: prof.javaMajor || this.safeJavaMajor(mc), note: `非 bundler 格式，走外部库（缺 ${check.missing.length} 个需下载）：${e.message}` };
    }
    this.extractCache.set(mc, out);
    return out;
  }

  safeJavaMajor(mc) { try { return this.javaMajor(mc); } catch { return 17; } }

  fabric(mc) {
    const info = this.fabricIndex[mc];
    if (!info) return null;
    const p = path.join(this.dirs.fabric, mc, 'server-profile.json');
    if (!isReady(p)) return null;
    const prof = resolveProfile(JSON.parse(fs.readFileSync(p, 'utf8')), { server: false });
    const check = this.checkLibs(prof.libraries, this.libRoots(mc));
    return { mainClass: prof.mainClass, loader: info.loader, resolved: check.resolved, missing: check.missing, note: `Fabric loader ${info.loader}（${check.resolved.length}/${prof.libraries.length} 个库就绪）` };
  }

  paperJar(mc) {
    const info = this.paperIndex[mc];
    if (!info) return null;
    const p = info.path ? path.resolve(info.path) : path.join(this.dirs.paper, mc, info.file);
    return isReady(p) ? p : null;
  }

  // 本地已有什么：给「下载」页和首页显示
  localInfo() {
    const installed = this.listInstalledVersions();
    return {
      versions: installed,
      paper: Object.entries(this.paperIndex).map(([mc, v]) => ({ mc, build: v.build, ready: !!this.paperJar(mc), size: v.size || 0, minJava: v.minJava, jvmFlags: v.jvmFlags || [] })),
      fabric: Object.entries(this.fabricIndex).map(([mc, v]) => ({ mc, loader: v.loader, ready: isReady(path.join(this.dirs.fabric, mc, 'server-profile.json')), libs: v.libs })),
      forge: Object.entries(this.forgeIndex).map(([mc, v]) => ({ mc, latest: Array.isArray(v) ? v[0] : v, count: Array.isArray(v) ? v.length : 1 })),
      jres: (() => { try { return fs.readdirSync(this.dirs.runtime).filter((d) => /^jre-\d+$/.test(d)).map((d) => Number(d.slice(4))); } catch { return []; } })(),
      bytes: {
        versions: dirSize(this.dirs.versions),
        libraries: dirSize(this.dirs.libraries),
        assets: dirSize(this.dirs.assets),
        paper: dirSize(this.dirs.paper),
        fabric: dirSize(this.dirs.fabric),
        runtime: dirSize(this.dirs.runtime),
      },
    };
  }

  // 删掉一个版本下载的东西；顺带可以回收没人用的共享库
  uninstallVersion(mc) {
    const dir = this.versionDir(mc);
    if (!fs.existsSync(dir)) return { removed: false, bytes: 0 };
    const bytes = dirSize(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* Windows 上正在被 java 占用的 jar 删不掉 */ }
    const left = isReady(dir) ? dirSize(dir) : 0;
    if (left) throw new Error(`${mc} 还有 ${(left / 1048576).toFixed(1)}MB 删不掉——这个版本正被运行中的服务器或游戏占用，先停掉再删`);
    this.extractCache.delete(mc);
    return { removed: true, bytes };
  }

  // 版本详情页的「清除本版本文件」：只删这个版本自己的东西。
  // 不碰 runtime（Java 是多版本共用的），也不碰 libraries/assets（共享库交给「回收无用依赖」处理）
  purgeVersion(mc) {
    const targets = [
      ['版本 jar 与版本信息', this.versionDir(mc)],
      ['Paper', path.join(this.dirs.paper, mc)],
      ['Fabric', path.join(this.dirs.fabric, mc)],
      ['Forge', path.join(this.dirs.forge, mc)],
      ['NeoForge', path.join(this.dirs.neoforge, mc)],
    ];
    const out = [];
    let bytes = 0;
    for (const [label, dir] of targets) {
      if (!isReady(dir)) continue;
      const size = dirSize(dir);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* 占用 */ }
      if (isReady(dir)) throw new Error(`${label}（${mc}）有文件被占用删不掉——先停掉在用这个版本的服务器或游戏`);
      bytes += size;
      out.push({ label, bytes: size });
      if (label === '版本 jar 与版本信息') this.extractCache.delete(mc);
    }
    // 加载器索引里把这个版本摘掉，免得界面还显示"已装"
    for (const [key, idx] of [['paper', this.paperIndex], ['fabric', this.fabricIndex], ['forge', this.forgeIndex]]) {
      if (idx[mc]) {
        delete idx[mc];
        try { writeJson(path.join(this.dirs[key], 'index.json'), idx); } catch { /* 索引写不回就下次重算 */ }
      }
    }
    const neoFile = path.join(this.dirs.neoforge, 'index.json');
    const neo = readJson(neoFile, null);
    if (neo && neo.byMc && neo.byMc[mc]) {
      delete neo.byMc[mc];
      try { writeJson(neoFile, neo); } catch { /* 同上 */ }
    }
    return { mc, bytes, parts: out };
  }

  // 当前所有已装内容仍然需要的库路径集合
  neededLibPaths() {
    const need = new Set();
    const add = (libs) => { for (const l of libs || []) need.add(l.path.split('/').join(path.sep)); };
    for (const v of this.listInstalledVersions()) {
      if (!v.hasJson) continue;
      try {
        add(resolveProfile(this.versionJson(v.mc), { server: false }).libraries);
        for (const l of this.versionJson(v.mc).libraries || []) {
          const nat = l.natives && (l.natives.windows || l.natives['windows-x86_64']);
          if (!nat || !l.downloads || !l.downloads.classifiers) continue;
          for (const [k, a] of Object.entries(l.downloads.classifiers)) if (/natives-windows/.test(k)) need.add(a.path.split('/').join(path.sep));
        }
      } catch { /* 版本信息坏了就保守跳过 */ }
    }
    for (const mc of Object.keys(this.fabricIndex)) {
      const f = this.fabric(mc);
      if (!f) continue;
      try {
        add(resolveProfile(JSON.parse(fs.readFileSync(path.join(this.dirs.fabric, mc, 'server-profile.json'), 'utf8')), { server: false }).libraries);
      } catch { /* 档案还没落盘，保守跳过 */ }
    }
    return need;
  }

  // 清理没人用的共享库：先给 dryRun 看能回收多少
  cleanOrphanLibs({ dryRun = true } = {}) {
    const need = this.neededLibPaths();
    const root = this.dirs.libraries;
    const orphans = [];
    let bytes = 0;
    (function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(jar|json)$/.test(e.name)) {
          if (!need.has(path.relative(root, p))) { orphans.push(p); bytes += fs.statSync(p).size; }
        }
      }
    })(root);
    if (dryRun) return { count: orphans.length, bytes, dryRun: true };
    let freed = 0;
    let removedCount = 0;
    for (const p of orphans) {
      try {
        freed += fs.statSync(p).size;
        fs.rmSync(p);
        removedCount++;
      } catch { /* 文件被 java 占用，下轮再回收 */ }
    }
    pruneEmpty(root);
    return { count: removedCount, bytes: freed, dryRun: false };
  }

  listInstalledVersions() {
    let names = [];
    try { names = fs.readdirSync(this.dirs.versions).filter((d) => fs.statSync(path.join(this.dirs.versions, d)).isDirectory()); } catch { return []; }
    return names.map((mc) => {
      const server = this.serverJar(mc);
      const client = this.clientJar(mc);
      return {
        mc,
        hasJson: isReady(this.versionJsonPath(mc)),
        server: isReady(server) ? fs.statSync(server).size : 0,
        client: isReady(client) ? fs.statSync(client).size : 0,
        extracted: isReady(path.join(this.versionDir(mc), 'bundler', '.mcl-bundler.json')),
        javaMajor: (() => { try { return this.javaMajor(mc); } catch { return null; } })(),
        bytes: dirSize(this.versionDir(mc)),
      };
    }).sort((a, b) => b.mc.localeCompare(a.mc, undefined, { numeric: true }));
  }
}

// 自底向上删掉空目录，避免回收后 store/libraries 里留一堆壳
function pruneEmpty(root) {
  let removed = true;
  while (removed) {
    removed = false;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      if (d !== root && entries.length === 0) {
        try { fs.rmdirSync(d); removed = true; continue; } catch { /* 还有文件 */ }
      }
      for (const e of entries) if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
}

function dirSize(dir) {
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

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

// 给 Paper 的 Paperclip 铺 Mojang 目录结构（硬链接，几乎不占额外空间）
function ensureVanillaLayout(catalog, instanceDir, mc) {
  const v = catalog.vanilla(mc);
  const srcRoot = v.dir;
  const gameJar = v.cp.find((p) => p.includes(`${path.sep}versions${path.sep}`));
  fs.mkdirSync(path.join(instanceDir, 'versions', mc), { recursive: true });
  const made = [];
  const put = (src, dstRel) => {
    const dst = path.join(instanceDir, dstRel);
    if (isReady(dst) || !isReady(src)) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    try { fs.linkSync(src, dst); } catch { try { fs.copyFileSync(src, dst); } catch { /* 只读盘 */ } }
    made.push(dstRel);
  };
  if (gameJar) {
    put(gameJar, path.join('versions', mc, `${mc}.jar`));
    put(gameJar, path.join('versions', mc, `server-${mc}.jar`));
  }
  for (const p of v.cp) {
    if (p === gameJar || !p.startsWith(srcRoot)) continue;
    put(p, path.join('libraries', path.relative(srcRoot, p)));
  }
  const official = catalog.serverJar(mc);
  if (isReady(official)) {
    fs.mkdirSync(path.join(instanceDir, 'cache'), { recursive: true });
    const dst = path.join(instanceDir, 'cache', `mojang_${mc}.jar`);
    if (!isReady(dst)) {
      try { fs.linkSync(official, dst); } catch { try { fs.copyFileSync(official, dst); } catch { /* 只读盘 */ } }
    }
    made.push(path.join('cache', `mojang_${mc}.jar`));
  }
  return made;
}

function jvmArgs(instance, settings, catalog) {
  const mem = instance.memoryMB || settings.memoryMB || 4096;
  const out = [`-Xmx${mem}M`, `-Xms${Math.min(mem, 1024)}M`];
  // 中文 Windows 控制台默认 GBK，统一按 UTF-8 读写，避免日志乱码
  out.push('-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8');
  const preset = instance.jvmPreset || settings.jvmPreset || 'aikar';
  let flags = [];
  if (preset === 'paper') {
    const p = catalog.paperIndex[instance.mcVersion];
    flags = (p && p.jvmFlags && p.jvmFlags.length && p.jvmFlags) || JVM_PRESETS.aikar.flags;
  } else if (JVM_PRESETS[preset]) flags = JVM_PRESETS[preset].flags;
  out.push(...flags);
  const extra = [settings.jvmArgs, instance.jvmArgs].filter(Boolean).join(' ');
  if (extra.trim()) out.push(...splitArgs(extra));
  return out;
}

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function buildPlan({ instance, settings, catalog }) {
  const dir = instance.dir;
  const mc = instance.mcVersion;
  const core = instance.core || 'vanilla';
  const gameArgs = ['nogui', ...splitArgs(instance.gameArgs || '')];
  const jvm = jvmArgs(instance, settings, catalog);

  if (core === 'paper') {
    const jar = instance.paperJar || catalog.paperJar(mc);
    if (!jar) throw new Error(`还没下载 ${mc} 的 Paper，去「下载」页选核心`);
    ensureVanillaLayout(catalog, dir, mc);
    const v = catalog.vanilla(mc);
    const info = catalog.paperIndex[mc] || {};
    return { core, cwd: dir, jvm, cp: [], jar, mainClass: null, gameArgs, javaMajorWanted: info.minJava || v.javaMajor, note: `Paper build ${info.build || '?'} · 原版 jar/库已铺进实例目录` };
  }

  if (core === 'fabric') {
    const f = catalog.fabric(mc);
    if (!f) throw new Error(`还没下载 ${mc} 的 Fabric loader，去「下载」页选核心`);
    if (f.missing.length) throw new Error(`Fabric 还缺 ${f.missing.length} 个库，去「下载」页重新拉取`);
    const v = catalog.vanilla(mc);
    return { core, cwd: dir, jvm, cp: [...f.resolved, ...v.cp], jar: null, mainClass: f.mainClass, gameArgs, javaMajorWanted: v.javaMajor, note: `${f.note} + 原版内嵌库 ${v.cp.length} 个` };
  }

  if (core === 'forge' || core === 'neoforge') {
    const argsFile = findForgeArgsFile(dir, core);
    if (!argsFile) throw new Error(`这个实例还没装 ${core === 'neoforge' ? 'NeoForge' : 'Forge'}，去版本详情页点安装（要联网拉依赖）`);
    const jvmFile = writeUserJvmArgs(dir, jvm);
    const v = catalog.vanilla(mc);
    return {
      core, cwd: dir, jvm: [], cp: [], jar: null, mainClass: null, gameArgs: [],
      forgeArgs: [`@${rel(dir, jvmFile)}`, `@${rel(dir, argsFile)}`, 'nogui'],
      javaMajorWanted: v.javaMajor,
      note: `${core === 'neoforge' ? 'NeoForge' : 'Forge'} 用官方生成的相对路径参数文件启动（${path.basename(argsFile)}）`,
    };
  }

  const v = catalog.vanilla(mc);
  if (v.missing && v.missing.length) throw new Error(`缺 ${v.missing.length} 个依赖库，去「下载」页补齐`);
  return { core: 'vanilla', cwd: dir, jvm, cp: v.cp, jar: null, mainClass: v.mainClass, gameArgs, javaMajorWanted: v.javaMajor, note: v.note };
}

const rel = (base, p) => path.relative(base, p).replace(/\\/g, '/');

// 相对化路径：既缩短命令行，也绕开 Java 读 @argfile 时中文路径的编码坑
function shorten(base, p) {
  if (!p || !path.isAbsolute(p)) return p;
  const r = path.relative(base, p);
  return r && !path.isAbsolute(r) && r.length < p.length ? r : p;
}

// classpath 很长时（>7000 字符）Windows 命令行放不下，改用 @argfile
function toCommand(plan) {
  if (plan.forgeArgs) return { argv: [...plan.forgeArgs], argfile: null };
  const cwd = plan.cwd || process.cwd();
  const jvm = (plan.jvm || []).map((a) => {
    const i = a.indexOf('=');
    if (i < 0) return a;
    const v = a.slice(i + 1);
    return path.isAbsolute(v) ? a.slice(0, i + 1) + shorten(cwd, v) : a;
  });
  const head = plan.jar ? ['-jar', shorten(cwd, plan.jar)] : [];
  const cpArg = plan.cp && plan.cp.length ? ['-cp', plan.cp.map((p) => shorten(cwd, p)).join(path.delimiter)] : [];
  const tail = plan.mainClass ? [plan.mainClass, ...plan.gameArgs] : plan.gameArgs;
  const full = [...jvm, ...cpArg, ...head, ...tail];
  if (full.join(' ').length < 7500) return { argv: full, argfile: null };
  return { argv: null, argfile: full };
}

function writeArgfile(dir, lines) {
  const file = path.join(dir, 'mcl-args.txt');
  const body = lines.map((l) => {
    if (l === '-cp' || l === '-jar') return l;
    const p = l.replace(/\\/g, '/');
    return /[";\s]/.test(p) ? `"${p}"` : p;
  });
  fs.writeFileSync(file, body.join('\n'), 'utf8');
  return file;
}

// Forge 与 NeoForge 的安装器都会生成一份 win_args.txt，只是 groupId 不同
function findForgeArgsFile(dir, kind) {
  const roots = kind === 'neoforge'
    ? [path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge')]
    : [path.join(dir, 'libraries', 'net', 'minecraftforge', 'forge'), path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge')];
  for (const root of roots) {
    let versions = [];
    try { versions = fs.readdirSync(root); } catch { continue; }
    for (const v of versions) {
      const d = path.join(root, v);
      let files = [];
      try { files = fs.readdirSync(d).filter((f) => /args\.txt$/.test(f)); } catch { continue; }
      // 给的是 win_args.txt / unix_args.txt（老版本叫 win32_x86_64_args.txt），必须挑 Windows 那份
      const win = files.filter((f) => /^win/i.test(f));
      const prefer = win.find((f) => /64/.test(f)) || win[0] || files.find((f) => !/^unix/i.test(f)) || files[0];
      if (prefer) return path.join(d, prefer);
    }
  }
  return null;
}

function writeUserJvmArgs(dir, jvm) {
  const file = path.join(dir, 'user_jvm_args.txt');
  fs.writeFileSync(file, jvm.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join('\n') + '\n', 'utf8');
  return file;
}

module.exports = { Catalog, buildPlan, toCommand, writeArgfile, jvmArgs, ensureVanillaLayout, JVM_PRESETS, splitArgs, findForgeArgsFile, writeUserJvmArgs, dirSize, VANILLA_SERVER_MAIN };
