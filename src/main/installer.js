'use strict';
// 核心安装器：Paper / Fabric / Forge。文件一律落到数据目录，并写回 index.json 供启动时查。

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { getJson } = require('./downloader');
const { mirrorUrls, paperVersionUrl, paperBuildUrl, fabricLoadersUrl, fabricProfileUrl, fabricInstallersUrl, forgeFileUrl, forgeMetadataUrl, neoforgeFileUrl, neoforgeVersionsUrl, neoforgeMetadataUrl, neoforgeModuleUrl, neoforgeMcFromModule, neoforgePrefix, resolveProfile } = require('./minecraft');
const { findForgeArgsFile } = require('./profiles');
const { isReady, dirSizeSync } = require('./paths');
const bundler = require('./bundler');

const MB = (n) => (n / 1048576).toFixed(1);

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, o) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); }

class Installer extends EventEmitter {
  constructor({ store, catalog, remote }) {
    super();
    this.store = store;
    this.catalog = catalog;
    this.remote = remote;
    this.dirs = store.dirs;
    remote.onProgress = (p) => this.emit('progress', p);
  }

  log(l) { this.emit('log', l); }

  // ---------- Paper ----------
  async listPaper(mc) {
    const local = this.catalog.paperIndex[mc];
    try {
      const meta = await getJson(paperVersionUrl(mc), this.store.settings.mirror);
      return { online: true, installed: local ? local.build : null, builds: (meta.builds || []).slice(0, 40), minJava: meta.version && meta.version.java && meta.version.java.version && meta.version.java.version.minimum, support: meta.version && meta.version.support && meta.version.support.status, jvmFlags: (meta.version.java && meta.version.java.flags && meta.version.java.flags.recommended) || [] };
    } catch (e) {
      return { online: false, installed: local ? local.build : null, builds: local ? [local.build] : [], error: e.message };
    }
  }

  async installPaper(mc, build) {
    const list = await this.listPaper(mc);
    const want = build || (list.builds && list.builds[0]);
    if (!want) throw new Error(`拿不到 ${mc} 的 Paper 构建号${list.online ? '' : '（离线且本地没装过）'}`);
    const detail = await getJson(paperBuildUrl(mc, want), this.store.settings.mirror);
    const dl = detail.downloads || {};
    const file = dl['server:default'] || Object.values(dl)[0];
    if (!file || !file.url) throw new Error('Paper 没给下载地址');
    const target = path.join(this.dirs.paper, mc, file.name);
    if (!isReady(target)) {
      const r = await this.remote._queue(`下载 Paper ${mc} build ${want}`, [{ name: file.name, target, url: file.url, candidates: mirrorUrls(file.url, this.store.settings.mirror), sha256: file.checksums && file.checksums.sha256, size: file.size || 0 }]).run();
      if (r.errors.length) throw new Error('Paper 下载失败：' + r.errors[0]);
    }
    const idx = readJson(path.join(this.dirs.paper, 'index.json'), {});
    idx[mc] = {
      build: want, file: file.name, path: target, size: file.size || 0,
      minJava: (list.minJava) || null, jvmFlags: list.jvmFlags || [], support: list.support || null,
      url: file.url, sha256: file.checksums && file.checksums.sha256,
    };
    writeJson(path.join(this.dirs.paper, 'index.json'), idx);
    this.catalog.paperIndex = idx;
    this.log(`Paper ${mc} build ${want} 已就位（${MB(file.size || 0)}）`);
    return { mc, build: want, file: target, size: file.size };
  }

  // ---------- Fabric ----------
  async listFabric(mc) {
    const local = this.catalog.fabricIndex[mc];
    try {
      const loaders = await getJson(fabricLoadersUrl(mc), this.store.settings.mirror);
      return { online: true, installed: local ? local.loader : null, loaders: (loaders || []).slice(0, 20).map((l) => ({ loader: l.loader.version, stable: l.loader.stable })) };
    } catch (e) {
      return { online: false, installed: local ? local.loader : null, loaders: local ? [{ loader: local.loader, stable: true }] : [], error: e.message };
    }
  }

  async installFabric(mc, loader) {
    const list = await this.listFabric(mc);
    const want = loader || (list.loaders && list.loaders[0] && list.loaders[0].loader);
    if (!want) throw new Error(`拿不到 ${mc} 的 Fabric loader 版本`);
    const profile = await getJson(fabricProfileUrl(mc, want), this.store.settings.mirror);
    const dir = path.join(this.dirs.fabric, mc);
    writeJson(path.join(dir, 'server-profile.json'), profile);
    const prof = resolveProfile(profile, { server: false });
    const libs = prof.libraries.map((l) => ({ path: l.path, urls: l.urls || [l.url], sha1: l.sha1, size: l.size || 0 }));
    // 加载器库跟着隔离策略走：隔离时进版本目录，删版本就能一起回收
    const libRoot = this.remote.libRoot(mc, { loader: true });
    const roots = [libRoot];
    const missing = libs.filter((l) => !this.catalog.findLib(l.path, roots));
    if (missing.length) {
      // 一批库合成一个任务，下载管理里不会刷屏成 8 条
      const tasks = missing.map((l) => ({ name: path.basename(l.path), target: path.join(libRoot, l.path), url: l.urls[0], candidates: l.urls.flatMap((u) => mirrorUrls(u, this.store.settings.mirror)), sha1: l.sha1, size: l.size || 0 }));
      const r = await this.remote._queue(`下载 Fabric ${mc} 依赖`, tasks, { version: mc, kind: 'fabric' }).run();
      if (r.errors.length) throw new Error(`Fabric 库下载失败：${r.errors[0]}`);
    }
    const got = missing.length;
    let installerVersion = null;
    try {
      const inst = await getJson(fabricInstallersUrl(), this.store.settings.mirror);
      installerVersion = ((inst.find((i) => i.stable) || inst[0] || {}).version) || null;
    } catch { /* 只是记录用 */ }
    const idx = readJson(path.join(this.dirs.fabric, 'index.json'), {});
    idx[mc] = { loader: want, libs: libs.length, installedLibs: got, installer: installerVersion, profile: path.join(dir, 'server-profile.json'), mainClass: prof.mainClass };
    writeJson(path.join(this.dirs.fabric, 'index.json'), idx);
    this.catalog.fabricIndex = idx;
    this.log(`Fabric ${mc} loader ${want} 已就位（新下 ${got}/${libs.length} 个库）`);
    return { mc, loader: want, libs: libs.length, got };
  }

  // ---------- Forge ----------
  async listForge(mc) {
    const local = this.catalog.forgeIndex[mc] || [];
    try {
      const { readBody } = require('./downloader');
      let xml = '';
      for (const u of mirrorUrls(forgeMetadataUrl(), this.store.settings.mirror)) { try { xml = (await readBody(u)).toString('utf8'); break; } catch { /* 下一个源 */ } }
      const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).filter((s) => s.startsWith(`${mc}-`));
      const cmp = (a, b) => {
        const pa = a.split('-').slice(1).join('.').split('.').map(Number);
        const pb = b.split('-').slice(1).join('.').split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pb[i] || 0) - (pa[i] || 0); if (d) return d; }
        return 0;
      };
      const versions = all.sort(cmp).slice(0, 40);
      const idx = readJson(path.join(this.dirs.forge, 'index.json'), {});
      idx[mc] = versions;
      writeJson(path.join(this.dirs.forge, 'index.json'), idx);
      this.catalog.forgeIndex = idx;
      return { online: true, versions, recommended: versions[0] || local[0] || null };
    } catch (e) {
      return { online: false, versions: local, recommended: local[0] || null, error: e.message };
    }
  }

  // ---------- NeoForge ----------
  // 没有可用的 promotions 接口，命名规则也推不准（26.1.2.126 对应 MC 26.1.2，三段），
  // 所以：前缀粗筛候选 → 读 Gradle .module 里的 neoform 依赖确认 → 结果缓存
  // 版本排序：maven 给的是升序，必须反过来，否则"推荐"会变成最老的那个版本
  static neoCmp(a, b) {
    const key = (v) => {
      const m = /^(\d+(?:\.\d+)*)(.*)$/.exec(String(v)) || ['', '0', ''];
      return { nums: m[1].split('.').map(Number), tail: m[2].toLowerCase() };
    };
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.max(ka.nums.length, kb.nums.length); i++) {
      const d = (kb.nums[i] || 0) - (ka.nums[i] || 0);
      if (d) return d;
    }
    // 同数字时正式版排在 beta 前面
    return ka.tail.localeCompare(kb.tail);
  }

  // NeoForge 版本清单：优先 maven-metadata.xml（BMCLAPI 有镜像），拿不到再退回官方 API
  async neoforgeVersionList() {
    const { readBody } = require('./downloader');
    for (const u of mirrorUrls(neoforgeMetadataUrl(), this.store.settings.mirror)) {
      try {
        const xml = (await readBody(u)).toString('utf8');
        const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
        if (all.length) return { versions: all, via: 'metadata' };
      } catch { /* 换下一个源 */ }
    }
    const j = await getJson(neoforgeVersionsUrl(), this.store.settings.mirror);
    return { versions: j.versions || [], via: 'api' };
  }

  async listNeoForge(mc) {
    const file = path.join(this.dirs.neoforge, 'index.json');
    const idx = readJson(file, { map: {}, byMc: {} });
    const local = idx.byMc[mc] || [];
    try {
      const { versions: all, via } = await this.neoforgeVersionList();
      const p = neoforgePrefix(mc);
      if (!p) return { online: true, versions: [], recommended: null, note: `${mc} 这个版本号段里没有 NeoForge` };
      const cand = all.filter((v) => v.startsWith(p)).sort(Installer.neoCmp);
      const need = cand.filter((v) => idx.map[v] === undefined).slice(0, 12);
      // 每个 .module 约 20KB，顺序探要十几秒；并发探 6 个一批
      for (let i = 0; i < need.length; i += 6) {
        await Promise.all(need.slice(i, i + 6).map(async (v) => {
          try { idx.map[v] = neoforgeMcFromModule(await getJson(neoforgeModuleUrl(v), this.store.settings.mirror)) || ''; }
          catch { idx.map[v] = ''; }   // 老版本的 beta 常常不发 .module，跳过就是了
        }));
      }
      const ok = cand.filter((v) => idx.map[v] === mc);
      idx.byMc[mc] = ok.length ? ok.slice(0, 40) : local;
      writeJson(file, idx);
      return { online: true, versions: idx.byMc[mc], recommended: idx.byMc[mc][0] || null, probed: need.length, total: cand.length, via };
    } catch (e) {
      return { online: false, versions: local, recommended: local[0] || null, error: e.message };
    }
  }

  // 安装器自己要下的依赖：先由我们走镜像备好，它见到文件在、校验过就直接跳过。
  // 不做这步的话，国内直连 maven.neoforged.net 会大面积超时（实测 117 次只成 21 次），安装器只丢一句
  // "There was an error during installation" 就退出，异常全被它吞掉。
  async preInstallLibraries(jar, dir) {
    let profile;
    try {
      const buf = fs.readFileSync(jar);
      const entry = bundler.centralDir(buf).find((e) => e.name === 'install_profile.json');
      if (!entry) return { files: 0, note: '安装器里没有 install_profile.json' };
      profile = JSON.parse(bundler.entryBytes(buf, entry).toString('utf8'));
    } catch (e) { return { files: 0, note: `读安装器依赖清单失败：${e.message}` }; }
    const tasks = [];
    for (const l of profile.libraries || []) {
      const a = l.downloads && l.downloads.artifact;
      if (!a || !a.path) continue;
      const target = path.join(dir, 'libraries', a.path.split('/').join(path.sep));
      if (isReady(target) && a.size && fs.statSync(target).size === a.size) continue;
      const urls = mirrorUrls(a.url, this.store.settings.mirror);
      tasks.push({ name: path.basename(a.path), target, url: urls[0], candidates: urls, sha1: a.sha1 || null, size: a.size || 0 });
    }
    if (!tasks.length) return { files: 0, note: '安装器依赖已备齐' };
    const q = this.remote._queue(`准备安装器依赖（${path.basename(jar)}）`, tasks, { kind: 'libs' });
    const r = await q.run();
    if (r.errors.length) throw new Error(`安装器依赖有 ${r.errors.length} 个下载失败：${r.errors[0]}`);
    return { files: tasks.length, bytes: q.totalBytes, note: `已备好 ${tasks.length} 个安装器依赖（${MB(q.totalBytes)}）` };
  }

  // Forge / NeoForge 的安装器同构（version.json + install_profile.json + data/win_args.txt），命令行也一样
  async installerJar(kind, dir, mc, version, localInstaller) {
    if (localInstaller) return localInstaller;
    fs.mkdirSync(dir, { recursive: true });
    const base = kind === 'neoforge' ? 'neoforge' : 'forge';
    const jar = path.join(dir, `${base}-${version}-installer.jar`);
    if (!isReady(jar)) {
      const url = kind === 'neoforge' ? neoforgeFileUrl(version, 'installer') : forgeFileUrl(mc, version, 'installer');
      const r = await this.remote._queue(`下载 ${kind === 'neoforge' ? 'NeoForge' : 'Forge'} ${version}`, [{ name: path.basename(jar), target: jar, url, candidates: mirrorUrls(url, this.store.settings.mirror), size: 0 }]).run();
      if (r.errors.length) throw new Error(`${base} installer 下载失败：${r.errors[0]}`);
    }
    return jar;
  }

  async runForgeInstaller(jar, dir, args, mc, kind = 'forge') {
    const wantMajor = this.catalog.safeJavaMajor(mc);
    const jre = this.pickJava({ javaPath: null }, wantMajor);
    const java = jre && jre.java && jre.java.path;
    if (!java) throw new Error(`找不到 Java ${wantMajor}+，先在「下载」页取一个 Java`);
    const tag = kind === 'neoforge' ? 'NeoForge' : 'Forge';
    this.log(`[${tag} 安装] java -jar ${path.basename(jar)} ${args.join(' ')}`);
    return new Promise((resolve) => {
      const child = spawn(java, ['-jar', jar, ...args], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const onData = (b) => { for (const line of b.toString('utf8').split(/\r?\n/)) if (line.trim()) this.log(`[${tag}] ${line.trim()}`); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => { this.log(`[${tag} 安装出错] ${e.message}`); resolve(-1); });
      child.on('close', resolve);
    });
  }

  // 服务端：装进实例目录，之后靠安装器自己生成的 win_args.txt 启动
  async installForge(inst, version, { localInstaller, kind = 'forge' } = {}) {
    const name = kind === 'neoforge' ? 'NeoForge' : 'Forge';
    const dir = this.store.instanceDir(inst);
    fs.mkdirSync(dir, { recursive: true });
    const jar = await this.installerJar(kind, dir, inst.mcVersion, version, localInstaller);
    // 安装器会自己抓原版服务端 jar；先放一份免得重复下 50MB，也避开它卡在那一步
    const serverJar = path.join(dir, 'server.jar');
    if (!isReady(serverJar)) {
      try { fs.linkSync(this.catalog.serverJar(inst.mcVersion), serverJar); }
      catch { try { fs.copyFileSync(this.catalog.serverJar(inst.mcVersion), serverJar); } catch { /* 没有就让它自己下 */ } }
    }
    const pre = await this.preInstallLibraries(jar, dir);
    if (pre.files) this.log(`[${name} 安装] ${pre.note}`);
    const code = await this.runForgeInstaller(jar, dir, ['--installServer'], inst.mcVersion, kind);
    if (!findForgeArgsFile(dir)) throw new Error(`${name} 安装器退出码 ${code}，没生成参数文件（多半是网络或镜像源问题）`);
    if (!localInstaller) { try { fs.rmSync(jar, { force: true }); } catch { /* 留着也行 */ } }
    return { ok: true, core: kind, note: `${name} ${version} 安装完成`, argsFile: findForgeArgsFile(dir) };
  }

  async installNeoForge(inst, version, opts = {}) { return this.installForge(inst, version, { ...opts, kind: 'neoforge' }); }

  forgeClientProfiles(dir) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, 'versions')); } catch { return []; }
    const out = [];
    for (const d of names) {
      if (!/forge/i.test(d)) continue;
      const f = path.join(dir, 'versions', d, `${d}.json`);
      if (isReady(f)) out.push(f);
    }
    return out;
  }

  // 客户端 Forge / NeoForge：官方安装器只认"游戏根目录"，所以装进档案自己的目录，产出直接当 loader.json 用
  async installForgeClient(game, version, { localInstaller, kind = 'forge' } = {}) {
    const name = kind === 'neoforge' ? 'NeoForge' : 'Forge';
    const dir = this.store.gameDir(game);
    const mc = game.mcVersion;
    fs.mkdirSync(dir, { recursive: true });
    // 安装器进门先找 launcher_profiles.json，没有就直接报错退出，所以得先备一份最小可用的
    const profiles = path.join(dir, 'launcher_profiles.json');
    if (!isReady(profiles)) fs.writeFileSync(profiles, JSON.stringify({ profiles: {}, version: 3 }, null, 2));
    // 安装器不负责下载原版客户端 jar，得先把共享库里那份放到位（同盘硬链接，跨盘退回复制）
    const vanillaJar = path.join(dir, 'versions', mc, `${mc}.jar`);
    if (!isReady(vanillaJar)) {
      const src = this.catalog.clientJar(mc);
      if (!isReady(src)) throw new Error(`装 ${name} 要先有 ${mc} 的原版客户端 jar —— 先在档案页点「准备客户端」`);
      fs.mkdirSync(path.dirname(vanillaJar), { recursive: true });
      try { fs.linkSync(src, vanillaJar); } catch { fs.copyFileSync(src, vanillaJar); }
    }
    const jar = await this.installerJar(kind, path.join(this.dirs[kind === 'neoforge' ? 'neoforge' : 'forge'], mc), mc, version, localInstaller);
    const pre = await this.preInstallLibraries(jar, dir);
    if (pre.files) this.log(`[${name} 安装] ${pre.note}`);
    const had = new Set(this.forgeClientProfiles(dir));
    const code = await this.runForgeInstaller(jar, dir, ['--installClient', dir], mc, kind);
    const json = this.forgeClientProfiles(dir).find((p) => !had.has(p)) || this.forgeClientProfiles(dir)[0];
    if (!json) throw new Error(`${name} 安装器退出码 ${code}，没在 ${dir}\\versions 里生成可用的 profile`);
    if (!localInstaller) { try { fs.rmSync(jar, { force: true }); } catch { /* 忽略 */ } }
    try { fs.rmSync(path.join(dir, `${path.basename(jar)}.log`), { force: true }); } catch { /* 安装器留的日志 */ }
    const j = readJson(json, {});
    return { json, id: j.id || path.basename(json, '.json'), loader: { type: kind, version, json }, note: `${name} ${version} 客户端已装进档案目录` };
  }

  async installNeoForgeClient(game, version, opts = {}) { return this.installForgeClient(game, version, { ...opts, kind: 'neoforge' }); }

  // ---------- 整合包（Modrinth .mrpack）----------
  async installModpack({ file, game, withAssets = true }) {
    const mp = require('./modpack');
    if (!this.client) throw new Error('内部错误：安装器没接上客户端模块');
    const pack = mp.readMrpack(file);
    const l = mp.loaderOfIndex(pack.index);
    if (!l.mc) throw new Error('整合包没写明要哪个 Minecraft 版本（dependencies.minecraft）');
    if (l.type === 'quilt') throw new Error('Quilt 整合包还不能自动装，目前支持原版 / Fabric / Forge / NeoForge');
    const dest = this.store.gameDir(game);
    fs.mkdirSync(dest, { recursive: true });
    const name = pack.index.name || path.basename(file, '.mrpack');
    this.log(`[整合包] ${name} · ${l.mc} · ${l.type}${l.version ? ' ' + l.version : ''} → ${dest}`);

    // 先把原版客户端装齐（jar + 库 + 资源），整合包都是叠在它上面的东西
    const core = await this.client.install(l.mc, { withAssets });
    this.log(`[整合包] 原版客户端就绪：${core.core.note}；${core.assets.note || ''}`);

    let loader = null;
    if (l.type === 'fabric') {
      const f = await this.remote.fabricClientProfile(l.mc, l.version);
      loader = { type: 'fabric', version: f.version || l.version, json: f.json };
      this.log(`[整合包] ${f.note}`);
    } else if (l.type === 'forge' || l.type === 'neoforge') {
      const f = await this.installForgeClient({ ...game, mcVersion: l.mc, dir: dest }, l.version, { kind: l.type });
      loader = f.loader;
      this.log(`[整合包] ${f.note}`);
    }

    // 包里的模组/材质走下载队列，进度与取消才会出现在「下载管理」
    const { tasks, skipped } = mp.clientTasks(pack.index, dest);
    const q = tasks.length ? this.remote._queue(`整合包文件 ${name}`, tasks, { kind: 'modpack', version: l.mc }) : null;
    let got = 0;
    let bytes = 0;
    if (q) {
      const r = await q.run();
      if (r.errors.length) throw new Error(`整合包有 ${r.errors.length} 个文件下载失败：${r.errors[0]}`);
      got = tasks.length;
      bytes = q.totalBytes;
    }
    const ov = mp.extractOverrides(pack, dest);
    // 加载器必须当场记到档案上：只返回不写盘的话，档案会按原版启动，mods 里的模组一个都不生效
    const saved = this.store.patchGame(game.id, { mcVersion: l.mc, loader });
    this.client.invalidate();
    return {
      name, mc: l.mc, loader, game: saved, files: got, skipped, bytes, overrides: ov.count,
      note: `${name}：${got} 个文件 ${MB(bytes)}，铺了 ${ov.count} 个覆盖配置${skipped ? `，跳过 ${skipped} 个服务端专用文件` : ''}`,
    };
  }

  usage() {
    const info = this.catalog.localInfo();
    return {
      store: info.bytes,
      versions: info.versions,
      instances: this.store.instances.map((i) => {
        const d = this.store.instanceDir(i);
        return { id: i.id, name: i.name, bytes: dirSizeSync(d), world: dirSizeSync(path.join(d, 'world')) };
      }),
      games: this.store.games.map((g) => {
        const d = this.store.gameDir(g);
        return { id: g.id, name: g.name, bytes: dirSizeSync(d), saves: dirSizeSync(path.join(d, 'saves')) };
      }),
      jres: info.jres,
    };
  }
}

module.exports = { Installer };
