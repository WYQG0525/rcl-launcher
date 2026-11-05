'use strict';
// 客户端（启动游戏）：文件都在数据目录里（由 remote.js 下载），这里负责盘点、准备与生成启动计划。
// 登录方式见 auth.js：离线 / 微软正版 / authlib-injector 第三方（LittleSkin 等）。

const fs = require('node:fs');
const path = require('node:path');
const { resolveProfile } = require('./minecraft');
const { isReady } = require('./paths');
const bundler = require('./bundler');
const { offlineUuid } = require('./auth');

// 启动器自报版本：从 package.json 读，省得每次发版都要回来改硬编码
const APP_VERSION = require('../../package.json').version;

const MB = (n) => (n / 1048576).toFixed(1);

class ClientStore {
  constructor({ store, catalog, remote, auth }) {
    this.store = store;
    this.catalog = catalog;
    this.remote = remote;
    this.auth = auth;
    this.dirs = store.dirs;
    this._st = null;
  }

  clientJar(mc) { return this.catalog.clientJar(mc); }
  assetsRoot() { return this.dirs.assets; }
  nativesDir(mc) { return path.join(this.dirs.natives, mc); }
  versionJson(mc) { return this.catalog.versionJson(mc); }

  // 现状盘点：界面据此显示"还差什么、大概多少体积"（stat 上千个资源文件不便宜，缓存 20 秒）
  status(mc, { fresh = false } = {}) {
    if (!this.catalog.hasVersion(mc)) {
      return { mc, unknown: true, complete: false, jarReady: false, libs: { total: 0, have: 0, missing: 0 }, missingBytes: 0, assets: { ready: false, known: false, files: 0, total: 0, have: 0 } };
    }
    if (!fresh && this._st && this._st.mc === mc && Date.now() - this._st.at < 20000) return this._st.v;
    const j = this.versionJson(mc);
    const jar = this.clientJar(mc);
    const roots = this.catalog.libRoots(mc);
    const prof = resolveProfile(j, { server: false });
    const have = prof.libraries.filter((l) => !!this.catalog.findLib(l.path, roots));
    const indexFile = path.join(this.assetsRoot(), 'indexes', `${j.assets}.json`);
    let assetTotal = 0, assetHave = 0, assetCount = 0;
    if (isReady(indexFile)) {
      // 索引形如 { "icons/icon_16x16.png": {hash, size} }：键是逻辑路径，文件仍按 hash 寻址
      const map = JSON.parse(fs.readFileSync(indexFile, 'utf8')).objects || {};
      assetCount = Object.keys(map).length;
      for (const o of Object.values(map)) {
        const h = o.hash;
        if (!h) continue;
        assetTotal += o.size || 0;
        if (isReady(objectPath(this.assetsRoot(), h))) assetHave += o.size || 0;
      }
    }
    const natJars = this.nativeJarPaths(mc);
    const v = {
      mc,
      jarReady: isReady(jar),
      jarSize: (j.downloads && j.downloads.client && j.downloads.client.size) || 0,
      libs: { total: prof.libraries.length + natJars.length, have: have.length + natJars.filter((p) => p).length, missing: prof.libraries.length - have.length + natJars.filter((p) => !p).length },
      missingBytes: prof.libraries.filter((l) => !this.catalog.findLib(l.path, roots)).reduce((s, l) => s + (l.size || 0), 0) + (isReady(jar) ? 0 : ((j.downloads && j.downloads.client && j.downloads.client.size) || 0)),
      assets: { ready: assetCount > 0 && assetHave === assetTotal, known: assetCount > 0, indexId: j.assets, files: assetCount, total: assetTotal, have: assetHave },
      complete: isReady(jar) && have.length === prof.libraries.length && natJars.every((p) => !!p) && assetCount > 0 && assetHave === assetTotal,
    };
    this._st = { mc, at: Date.now(), v };
    return v;
  }

  invalidate() { this._st = null; }

  // 客户端 jar + 库 + LWJGL 原生库
  async installCore(mc) {
    const a = await this.remote.downloadClient(mc);
    const b = await this.remote.downloadLibraries(mc, { client: true });
    this.invalidate();
    return { mc, bytes: a.bytes, note: `客户端 jar ${MB(a.bytes)} · ${b.note || ''}` };
  }

  async installAssets(mc) {
    const r = await this.remote.downloadAssets(mc);
    this.invalidate();
    return r;
  }

  async install(mc, { withAssets = true, onStep } = {}) {
    const core = await this.installCore(mc);
    onStep && onStep(core.note);
    const assets = withAssets ? await this.installAssets(mc) : { files: 0, note: '跳过资源下载' };
    onStep && onStep(assets.note);
    const st = this.status(mc, { fresh: true });
    return { mc, core, assets, ready: st.complete, status: st };
  }

  // LWJGL natives 的 classifier jar（含 dll）
  nativeJarPaths(mc, json, roots = []) {
    let j = json;
    if (!j) { try { j = this.versionJson(mc); } catch { return []; } }
    const out = [];
    for (const l of j.libraries || []) {
      const want = l.natives && (l.natives.windows || l.natives['windows-x86_64']);
      if (!want || !l.downloads || !l.downloads.classifiers) continue;
      for (const [k, a] of Object.entries(l.downloads.classifiers)) {
        if (!/natives-windows/.test(k)) continue;
        out.push(this.catalog.findLib(a.path, roots));
      }
    }
    return out;
  }

  // 把 dll 解出来给 -Djava.library.path
  ensureNatives(mc, { json, roots = [] } = {}) {
    const dest = this.nativesDir(mc);
    const stamp = path.join(dest, '.rcl-natives.json');
    const jars = this.nativeJarPaths(mc, json, roots).filter(Boolean);
    const sig = jars.map((j) => `${path.basename(j)}:${fs.statSync(j).size}`).join('|');
    if (isReady(stamp)) {
      try { if (JSON.parse(fs.readFileSync(stamp, 'utf8')).sig === sig) return { dir: dest, jars: jars.length, cached: true }; } catch { /* 重来 */ }
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const jar of jars) {
      let buf;
      let entries;
      try { buf = fs.readFileSync(jar); entries = bundler.centralDir(buf); } catch { continue; }
      for (const e of entries) {
        if (e.name.endsWith('/') || e.name.startsWith('META-INF/')) continue;
        if (!/\.(dll|so|dylib|dat)$/.test(e.name)) continue;
        try { fs.writeFileSync(path.join(dest, path.basename(e.name)), bundler.entryBytes(buf, e)); } catch { /* 单个失败不致命 */ }
      }
    }
    fs.writeFileSync(stamp, JSON.stringify({ sig, at: Date.now() }), 'utf8');
    return { dir: dest, jars: jars.length };
  }

  // 解析登录态：返回 { name, uuid, token, userType, javaagent }
  resolveAuth(game) {
    const type = game.authType || 'offline';
    if (type === 'offline') return { ...this.auth.offline(game.username || 'Player') };
    if (type === 'microsoft') {
      const key = `ms:${game.authName || game.username}`;
      const acct = this.auth.get(key);
      if (!acct || !acct.token) throw new Error(`微软账号「${game.authName || game.username}」还没登录，去登录面板登录一次`);
      return { type: 'microsoft', name: acct.name, uuid: acct.uuid, token: acct.token, userType: 'msa' };
    }
    if (type === 'aai') {
      const root = game.aaiRoot || 'https://littleskin.cn/authlib';
      return { type: 'aai', name: game.username || 'Player', uuid: game.uuid || offlineUuid(game.username || 'Player'), token: '00000000000000000000000000000000', userType: 'mojang', aaiRoot: root };
    }
    throw new Error(`未知登录方式 ${type}`);
  }

  // 档案自带的库目录：导入的 .minecraft 或装进档案目录的 Forge/Fabric 库，优先于共享库
  libRoots(game) {
    const out = [];
    if (game && game.dir) {
      const d = path.join(game.dir, 'libraries');
      if (fs.existsSync(d)) out.push(d);
    }
    // 隔离策略开着时，这个版本自己的库目录也在查找路径里（共享池作只读回退）
    for (const r of this.catalog.libRoots(game ? game.mcVersion : '', null)) if (!out.includes(r)) out.push(r);
    return out;
  }

  // 启动用的 profile：原版，或把 Fabric/Forge 的库、主类、参数叠到原版之上
  launchProfile(game) {
    const base = this.versionJson(game.mcVersion);
    const l = game.loader;
    if (!l || !l.type || l.type === 'vanilla') return { json: base, loader: null, gameArgs: [], jvmArgs: [] };
    if (!l.json || !isReady(l.json)) {
      throw new Error(`档案标的是 ${l.type} ${l.version || ''}，但找不到加载器配置${l.json ? '：' + l.json : ''} —— 去「整合包/加载器」里重装一次`);
    }
    const j = JSON.parse(fs.readFileSync(l.json, 'utf8'));
    const merged = {
      ...base,
      mainClass: j.mainClass || base.mainClass,
      libraries: [...(base.libraries || []), ...(j.libraries || [])],
      javaVersion: j.javaVersion || base.javaVersion,
    };
    return {
      json: merged,
      loader: l,
      gameArgs: (j.arguments && j.arguments.game) || [],
      jvmArgs: (j.arguments && j.arguments.jvm) || [],
    };
  }

  buildPlan({ game, settings }) {
    const mc = game.mcVersion;
    const st = this.status(mc);
    if (st.unknown) throw new Error(`还没下载 ${mc} 的版本信息，去「下载」页拉取`);
    if (!st.complete) {
      const need = [];
      if (!st.jarReady) need.push('客户端 jar');
      if (st.libs.missing > 0) need.push(`${st.libs.missing} 个库`);
      if (!st.assets.ready) need.push('游戏资源');
      throw new Error(`${mc} 客户端还没准备好，缺 ${need.join('、')} —— 点「准备客户端」`);
    }
    const lp = this.launchProfile(game);
    const j = lp.json;
    const roots = this.libRoots(game);
    const prof = resolveProfile(j, { server: false });
    const cp = prof.libraries.map((l) => this.catalog.findLib(l.path, roots));
    const lost = prof.libraries.filter((l, i) => !cp[i]).map((l) => path.basename(l.path));
    if (lost.length) throw new Error(`缺 ${lost.length} 个库文件（${lp.loader ? lp.loader.type + ' 的' : ''}${lost.slice(0, 3).join('、')}${lost.length > 3 ? '…' : ''}）—— 重装一次整合包或加载器`);
    let mainClass = prof.mainClass;
    cp.push(this.clientJar(mc));
    if (!lp.loader) {
      try {
        const r = bundler.extract(this.clientJar(mc), path.join(this.catalog.versionDir(mc), 'client-bundler'));
        if (r.mainClass && /client/.test(r.mainClass)) mainClass = r.mainClass;
        for (const p of r.cp) if (!cp.includes(p)) cp.push(p);
      } catch { /* 普通 client jar，走 libraries */ }
    }

    const natives = this.ensureNatives(mc, { json: j, roots });
    const identity = this.resolveAuth(game);
    const gameDir = game.dir;
    fs.mkdirSync(gameDir, { recursive: true });
    // 相对路径：命令行更短，也避开 Java 读 @argfile 时中文路径的编码问题（cwd 就是游戏目录）
    const rp = (p) => {
      const r = path.relative(gameDir, p);
      return r && r.length < p.length ? r.replace(/\\/g, '/') : p;
    };
    const mem = game.memoryMB || settings.memoryMB || 4096;
    const jvm = [
      `-Xmx${mem}M`, `-Xms${Math.min(mem, 1024)}M`,
      `-Djava.library.path=${rp(natives.dir)}`,
      '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
      '-Dminecraft.launcher.brand=RCL', '-Dminecraft.launcher.version=' + (settings.appVersion || APP_VERSION),
    ];
    if (identity.type === 'aai') {
      const jar = this.authInjector();
      jvm.push(`-javaagent:${rp(jar)}=${identity.aaiRoot}`);
    }
    if (game.jvmArgs) jvm.push(...String(game.jvmArgs).split(/\s+/).filter(Boolean));

    const vars = {
      auth_player_name: identity.name,
      version_name: game.name || mc,
      game_directory: '.',
      assets_root: rp(this.assetsRoot()),
      assets_index_name: String(j.assets || st.assets.indexId || mc),
      auth_uuid: identity.uuid,
      uuid: identity.uuid,
      auth_access_token: identity.token,
      accessToken: identity.token,
      auth_xuid: '0',
      xuid: '0',
      auth_session: 'rcl',
      auth_session_name: 'RCL',
      clientid: identity.uuid,
      user_id: identity.uuid,
      user_properties: '{}',
      user_type: identity.userType,
      userType: identity.userType,
      version_type: 'release',
      launcher_name: 'RCL',
      launcher_version: settings.appVersion || APP_VERSION,
      natives_directory: rp(natives.dir),
      demo: 'false',
      resolution_width: game.width || null,
      resolution_height: game.height || null,
      is_display_name_auto: 'false',
      quickPlayMultiplayer: game.server || null,
    };
    const features = {
      is_demo: false,
      has_custom_resolution: !!(game.width && game.height) && !game.fullscreen,
      is_quickPlay: !!game.server,
      quickPlayMultiplayer: !!game.server,
      quickPlaySingleplayer: false,
      quickPlayRealms: false,
      is_first_run: false,
      has_agents: false,
      is_core_compatibility: false,
      supports_windows_7: false,
    };
    // 加载器自带的 JVM 参数：Forge 的 -p 模块路径里嵌了一堆 ${library_directory}，必须逐个展开
    if (lp.loader) {
      const lvars = {
        ...vars,
        library_directory: (roots[0] || this.dirs.libraries).replace(/\\/g, '/'),
        classpath_separator: path.delimiter,
        path_separator: path.delimiter,
        side: 'client',
        mc_version: mc,
        forge_version: lp.loader.version || '',
        lwjgl_version: '3.3.3',
      };
      jvm.push(...expandInline(lp.jvmArgs, lvars));
    }
    const args = clientArgs(j, vars, features);
    if (lp.gameArgs.length) args.push(...expandInline(lp.gameArgs, vars));
    if (game.fullscreen && !args.includes('--fullscreen')) args.push('--fullscreen');
    if (game.gameArgs) args.push(...String(game.gameArgs).split(/\s+/).filter(Boolean));

    return {
      core: 'client', cwd: gameDir, jvm, cp, jar: null, mainClass, gameArgs: args,
      javaMajorWanted: prof.javaMajor || this.catalog.safeJavaMajor(mc),
      identity: { type: identity.type, name: identity.name, uuid: identity.uuid },
      note: `${mc} 客户端${lp.loader ? ` + ${lp.loader.type} ${lp.loader.version || ''}`.trimEnd() : ''} · ${cp.length} 个 classpath · ${identity.type === 'offline' ? '离线登录' : identity.type === 'microsoft' ? '微软正版' : '第三方(' + identity.aaiRoot + ')'} · 原生库 ${natives.jars} 包`,
    };
  }

  authInjector() {
    const p = path.join(this.dirs.store, 'authlib-injector.jar');
    if (!isReady(p)) throw new Error('authlib-injector 还没下载，点「准备客户端」或在设置里点下载');
    return p;
  }
}

// ---- 客户端参数：必须按版本 profile 声明的来拼，多传一个未知选项客户端会直接崩 ----
function subst(token, vars) {
  if (!/^\$\{[^}]+\}$/.test(token)) return token;
  const body = token.slice(2, -1);
  const i = body.indexOf(':');
  const key = i < 0 ? body : body.slice(0, i);
  const dflt = i < 0 ? null : body.slice(i + 1);
  const v = vars[key];
  if (v === undefined || v === null || v === '') return dflt;
  return String(v);
}

// 加载器参数里的占位符是嵌在长串中间的（-p 的模块路径），跟 subst 的整串替换不是一回事
function expandInline(list, vars) {
  return (list || []).filter((x) => typeof x === 'string').map((s) => s.replace(/\$\{([A-Za-z0-9_]+)\}/g, (m, k) => {
    const v = vars[k];
    return v === undefined || v === null ? m : String(v);
  }));
}

function allowFeatures(rules, features) {
  let ok = false;
  for (const r of rules || []) {
    if (!r || (r.action !== 'allow' && r.action !== 'disallow')) continue;
    let match = true;
    if (r.os && r.os.name && r.os.name !== 'windows') match = false;
    const f = r.features || {};
    for (const k of Object.keys(f)) if (!!features[k] !== !!f[k]) match = false;
    if (!match) continue;
    ok = r.action === 'allow';
  }
  return ok;
}

function clientArgs(json, vars, features) {
  const out = [];
  const walk = (items) => {
    for (const it of items) {
      if (typeof it === 'string') { const v = subst(it, vars); if (v !== null && v !== undefined) out.push(v); continue; }
      if (it && it.rules) {
        if (!allowFeatures(it.rules, features)) continue;
        walk(Array.isArray(it.value) ? it.value : [it.value]);
      } else if (Array.isArray(it)) walk(it);
    }
  };
  const args = json.arguments && json.arguments.game;
  if (Array.isArray(args)) walk(args);
  else if (typeof json.minecraftArguments === 'string') walk(json.minecraftArguments.split(' '));
  return out;
}

function objectPath(assetsRoot, hash) {
  return path.join(assetsRoot, 'objects', hash.slice(0, 2), hash);
}

module.exports = { ClientStore, offlineUuid, objectPath, clientArgs, subst, allowFeatures, expandInline };
