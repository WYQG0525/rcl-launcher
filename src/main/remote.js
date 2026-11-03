'use strict';
// 在线资源层：不再内置 MC 内容，所有版本文件、Java、模组/光影/材质都走这里下载。
// 镜像优先（默认 BMCLAPI），失败自动回落官方源；元数据缓存在数据目录，离线时仍能用缓存。

const fs = require('node:fs');
const path = require('node:path');
const { DownloadQueue, getJson, readBody } = require('./downloader');
const { resolveProfile, mirrorUrls } = require('./minecraft');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MODRINTH_API = 'https://api.modrinth.com/v2';
// CurseForge：社区免密钥镜像已全部下线，只剩官方接口（必须 x-api-key）
const CURSE_SEARCH = 'https://api.curseforge.com/v1';
const TUNA_ADOPTIUM = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium';
const ADOPTIUM_API = 'https://api.adoptium.net/v3';

const TYPES = {
  mod: { modrinth: 'mod', curse: 6, label: '模组' },
  modpack: { modrinth: 'modpack', curse: 447, label: '整合包' },
  resourcepack: { modrinth: 'resourcepack', curse: 12, label: '材质包' },
  shader: { modrinth: 'shader', curse: 6552, label: '光影' },
  world: { modrinth: 'mod', curse: 17, label: '地图' },
};

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
function readJsonSafe(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
const MB = (n) => (n / 1048576).toFixed(1);

class Remote {
  constructor({ store, dirs }) {
    this.store = store;
    this.dirs = dirs;
    this.root = dirs.root;
    this.metaDir = ensureDir(path.join(dirs.root, 'store', 'meta'));
    this.jreRoot = ensureDir(path.join(dirs.root, 'runtime'));
  }

  get settings() { return this.store.settings; }

  // ---------- 版本清单 ----------
  async versionList({ refresh = false } = {}) {
    const cache = path.join(this.metaDir, 'version_manifest_v2.json');
    if (!refresh && fs.existsSync(cache)) {
      const c = readJsonSafe(cache, null);
      if (c && c.versions) return { ...c, cached: true };
    }
    try {
      const m = await getJson(MANIFEST_URL, this.settings.mirror);
      fs.writeFileSync(cache, JSON.stringify(m));
      return { ...m, cached: false };
    } catch (e) {
      const c = readJsonSafe(cache, null);
      if (c && c.versions) return { ...c, cached: true, note: `联网失败，用本地缓存：${e.message}` };
      throw new Error(`拿不到版本清单，而且本地也没有缓存（网络问题？）：${e.message}`);
    }
  }

  async versionJson(mc, { refresh = false } = {}) {
    const dir = path.join(this.dirs.versions, mc);
    const file = path.join(dir, `${mc}.json`);
    if (!refresh && fs.existsSync(file)) return readJsonSafe(file, null) || throwJson(mc);
    const m = await this.versionList();
    const entry = m.versions.find((v) => v.id === mc);
    if (!entry) throw new Error(`清单里没有 ${mc} 这个版本`);
    const j = await getJson(entry.url, this.settings.mirror);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    return j;
  }

  // 某个版本在本地的落地情况
  installed(mc) {
    const dir = path.join(this.dirs.versions, mc);
    const json = path.join(dir, `${mc}.json`);
    const server = path.join(dir, `${mc}-server.jar`);
    const client = path.join(dir, `${mc}-client.jar`);
    return {
      mc,
      hasJson: fs.existsSync(json),
      server: fs.existsSync(server) ? fs.statSync(server).size : 0,
      client: fs.existsSync(client) ? fs.statSync(client).size : 0,
      dir,
    };
  }

  listInstalled() {
    try {
      return fs.readdirSync(this.dirs.versions).filter((d) => fs.statSync(path.join(this.dirs.versions, d)).isDirectory()).map((d) => this.installed(d));
    } catch { return []; }
  }

  // ---------- 下载：客户端 / 服务端 / 库 / 资源 ----------
  _queue(label, tasks, meta = {}) {
    const q = new DownloadQueue({ concurrency: this.settings.concurrency || 8, mirrorId: this.settings.mirror, label, meta: { version: meta.version || '', kind: meta.kind || 'download', ...meta } });
    tasks.forEach((t) => q.add(t));
    let done = 0;
    const t0 = Date.now();
    q.onEvent = (ev) => {
      if (!['done', 'cached', 'error'].includes(ev.type)) return;
      done++;
      if (this.onProgress) this.onProgress({ label, name: ev.name, done, total: q.tasks.length, bytes: q.bytesMoved, speed: q.bytesMoved / ((Date.now() - t0) / 1000 || 1), state: ev.type, message: ev.message });
    };
    return q;
  }

  async downloadServer(mc) {
    const j = await this.versionJson(mc);
    const d = j.downloads && j.downloads.server;
    if (!d) throw new Error(`${mc} 没有官方服务端 jar`);
    const target = path.join(this.dirs.versions, mc, `${mc}-server.jar`);
    const q = this._queue(`下载服务端 ${mc}`, [{ name: `${mc}-server.jar`, target, url: d.url, candidates: mirrorUrls(d.url, this.settings.mirror), sha1: d.sha1, size: d.size }]);
    const r = await q.run();
    if (r.errors.length) throw new Error('服务端下载失败：' + r.errors[0]);
    return { mc, file: target, bytes: d.size };
  }

  async downloadClient(mc) {
    const j = await this.versionJson(mc);
    const d = j.downloads && j.downloads.client;
    if (!d) throw new Error(`${mc} 没有官方客户端 jar`);
    const target = path.join(this.dirs.versions, mc, `${mc}-client.jar`);
    const tasks = [{ name: `${mc}-client.jar`, target, url: d.url, candidates: mirrorUrls(d.url, this.settings.mirror), sha1: d.sha1, size: d.size }];
    const q = this._queue(`下载客户端 ${mc}`, tasks);
    const r = await q.run();
    if (r.errors.length) throw new Error('客户端下载失败：' + r.errors[0]);
    return { mc, file: target, bytes: d.size };
  }

  // 库（含 LWJGL natives classifier）
  async downloadLibraries(mc, { client = true } = {}) {
    const j = await this.versionJson(mc);
    const prof = resolveProfile(j, { server: !client });
    const tasks = [];
    for (const l of prof.libraries) {
      if (this.findLib(l.path)) continue;
      tasks.push({ name: path.basename(l.path), target: path.join(this.dirs.libraries, l.path), url: l.urls ? l.urls[0] : l.url, candidates: (l.urls || [l.url]).flatMap((u) => mirrorUrls(u, this.settings.mirror)), sha1: l.sha1, size: l.size || 0 });
    }
    if (client) {
      for (const l of j.libraries || []) {
        const want = l.natives && (l.natives.windows || l.natives['windows-x86_64']);
        if (!want || !l.downloads || !l.downloads.classifiers) continue;
        for (const [k, a] of Object.entries(l.downloads.classifiers)) {
          if (!/natives-windows/.test(k) || this.findLib(a.path)) continue;
          tasks.push({ name: path.basename(a.path), target: path.join(this.dirs.libraries, a.path), url: a.url, candidates: mirrorUrls(a.url, this.settings.mirror), sha1: a.sha1, size: a.size });
        }
      }
    }
    if (!tasks.length) return { mc, files: 0, note: '库已齐全' };
    const q = this._queue(`下载依赖库 ${mc}`, tasks);
    const r = await q.run();
    if (r.errors.length) throw new Error(`有 ${r.errors.length} 个库下载失败：${r.errors[0]}`);
    return { mc, files: tasks.length, bytes: q.totalBytes, note: `已下载 ${tasks.length} 个库（${MB(q.totalBytes)}）` };
  }

  findLib(rel) {
    const p = path.join(this.dirs.libraries, rel);
    return fs.existsSync(p) ? p : null;
  }

  // 加载器 profile 自带的库（Fabric loader 那几个），一律落到共享库目录
  async downloadProfileLibraries(libs, label) {
    const tasks = [];
    for (const l of libs) {
      if (!l.path || this.findLib(l.path)) continue;
      const urls = l.urls && l.urls.length ? l.urls : [l.url];
      tasks.push({
        name: path.basename(l.path), target: path.join(this.dirs.libraries, l.path),
        url: urls[0], candidates: urls.filter(Boolean).flatMap((u) => mirrorUrls(u, this.settings.mirror)),
        sha1: l.sha1 || null, size: l.size || 0,
      });
    }
    if (!tasks.length) return { files: 0, bytes: 0, note: '库已齐全' };
    const q = this._queue(label, tasks);
    const r = await q.run();
    if (r.errors.length) throw new Error(`有 ${r.errors.length} 个库下载失败：${r.errors[0]}`);
    return { files: tasks.length, bytes: q.totalBytes, note: `已下载 ${tasks.length} 个库（${MB(q.totalBytes)}）` };
  }

  // Fabric 客户端 profile（KnotClient）：整合包和模组档案要用，跟服务端的 server-profile 是两份
  async fabricClientProfile(mc, loaderVersion) {
    const file = path.join(this.dirs.fabric, mc, 'client-profile.json');
    let j = fs.existsSync(file) ? readJsonSafe(file, null) : null;
    if (!j || (loaderVersion && !String(j.id || '').includes(loaderVersion))) {
      const lv = loaderVersion || (j && String(j.id || '').split('-')[2]) || '';
      const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mc)}${lv ? '/' + encodeURIComponent(lv) : ''}/profile/json`;
      j = await getJson(url, this.settings.mirror);
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
    }
    const libs = resolveProfile(j, { server: false }).libraries;
    const dl = await this.downloadProfileLibraries(libs, `下载 Fabric ${mc} 库`);
    const ver = (String(j.id || '').split('-')[2]) || '';
    return { json: file, version: ver, libs: libs.length, bytes: dl.bytes, note: `Fabric ${ver} 客户端 profile（${libs.length} 个库，${dl.note}）` };
  }

  async downloadAssetIndex(mc) {
    const j = await this.versionJson(mc);
    if (!j.assetIndex) return null;
    const file = path.join(this.dirs.assets, 'indexes', `${j.assets}.json`);
    if (fs.existsSync(file)) return file;
    const q = this._queue('下载资源索引', [{ name: `index-${j.assets}.json`, target: file, url: j.assetIndex.url, candidates: mirrorUrls(j.assetIndex.url, this.settings.mirror), sha1: j.assetIndex.sha1, size: j.assetIndex.size }]);
    const r = await q.run();
    if (r.errors.length) throw new Error('资源索引下载失败：' + r.errors[0]);
    return file;
  }

  async downloadAssets(mc) {
    const file = await this.downloadAssetIndex(mc);
    if (!file) return { files: 0, note: '没有资源索引' };
    const map = readJsonSafe(file, { objects: {} }).objects || {};
    const tasks = [];
    for (const [, o] of Object.entries(map)) {
      const h = o.hash;
      if (!h) continue;
      const target = path.join(this.dirs.assets, 'objects', h.slice(0, 2), h);
      if (fs.existsSync(target) && fs.statSync(target).size === o.size) continue;
      const url = `https://resources.download.minecraft.net/${h.slice(0, 2)}/${h}`;
      tasks.push({ name: h.slice(0, 10), target, url, candidates: mirrorUrls(url, this.settings.mirror), sha1: h, size: o.size });
    }
    if (!tasks.length) return { files: 0, note: `资源已完整（${Object.keys(map).length} 个）` };
    const q = new DownloadQueue({ concurrency: Math.max(this.settings.concurrency || 8, 24), mirrorId: this.settings.mirror, label: `下载游戏资源 ${mc}`, meta: { version: mc, kind: 'assets' } });
    tasks.forEach((t) => q.add(t));
    let dn = 0;
    const t0 = Date.now();
    q.onEvent = (ev) => {
      if (!['done', 'cached', 'error'].includes(ev.type)) return;
      dn++;
      if (this.onProgress && (dn % 50 === 0 || dn === q.tasks.length)) this.onProgress({ label: `下载游戏资源 ${mc}`, name: ev.name, done: dn, total: q.tasks.length, bytes: q.bytesMoved, speed: q.bytesMoved / ((Date.now() - t0) / 1000 || 1), state: ev.type });
    };
    const r = await q.run();
    if (r.errors.length) throw new Error(`资源下载失败 ${r.errors.length} 个：${r.errors[0]}`);
    return { files: tasks.length, bytes: q.totalBytes, note: `已下载 ${tasks.length} 个资源文件（${MB(q.totalBytes)}）` };
  }

  // ---------- Java 运行时 ----------
  async jreList() {
    try {
      return fs.readdirSync(this.jreRoot).filter((d) => /^jre-\d+$/.test(d)).map((d) => Number(d.slice(4))).sort((a, b) => a - b);
    } catch { return []; }
  }

  async downloadJre(major, { onStep } = {}) {
    const dest = path.join(this.jreRoot, `jre-${major}`);
    if (fs.existsSync(path.join(dest, 'bin', 'java.exe'))) return { major, note: `Java ${major} 已存在` };
    const files = await this._jreFileNames(major, onStep);
    const url = `${TUNA_ADOPTIUM}/${major}/jre/x64/windows/${files.file}`;
    const target = path.join(this.jreRoot, files.file);
    const q = this._queue(`下载 Java ${major}`, [{ name: `jre-${major}`, target, url, candidates: [url, `https://api.adoptium.net/v3/binary/latest/${major}/ga/windows/x64/jre/hotspot/normal/eclipse`], sha256: files.sha256 || null, size: files.size || 0 }]);
    const r = await q.run();
    if (r.errors.length) throw new Error(`Java ${major} 下载失败：${r.errors[0]}`);
    const { execFile } = require('node:child_process');
    const tmp = path.join(this.jreRoot, `_x${major}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    await new Promise((resolve, reject) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${target}' -DestinationPath '${tmp}' -Force`], (e) => (e ? reject(e) : resolve()));
    });
    const inner = path.join(tmp, fs.readdirSync(tmp)[0]);
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(inner, dest, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(target, { force: true });
    return { major, note: `Java ${major} 已下载`, dir: dest };
  }

  async _jreFileNames(major) {
    let want = null;
    try {
      const j = await getJson(`${ADOPTIUM_API}/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`, 'official');
      const rn = j[0] && j[0].release_name;
      if (rn) want = rn.replace(/^jdk-/, '').replace('+', '_');
      const b = j[0] && j[0].binary;
      if (b && b.name) return { file: b.name, size: b.size, sha256: b.checksum };
    } catch { /* 退回抓列表 */ }
    const html = (await readBody(`${TUNA_ADOPTIUM}/${major}/jre/x64/windows/`)).toString('utf8');
    const files = [...new Set([...html.matchAll(/OpenJDK\d+U-jre_x64_windows_hotspot_[^"'?]+\.zip/g)].map((m) => m[0]))];
    if (!files.length) throw new Error(`没找到 Java ${major} 的下载地址`);
    files.sort();
    return { file: (want && files.find((f) => f.includes(want))) || files[files.length - 1] };
  }

  // ---------- 模组 / 光影 / 材质 ----------
  async search({ source = 'modrinth', type = 'mod', query = '', mcVersion = '', loader = '', limit = 30, offset = 0 } = {}) {
    const kind = TYPES[type] || TYPES.mod;
    if (source === 'curse') return this._searchCurse({ kind, query, mcVersion, loader, limit, offset });
    return this._searchModrinth({ kind, query, mcVersion, loader, limit, offset });
  }

  async _searchModrinth({ kind, query, mcVersion, loader, limit, offset }) {
    const facets = [['project_type:' + kind.modrinth]];
    if (mcVersion) facets.push([`versions:${mcVersion}`]);
    if (loader) facets.push([`categories:${loader}`]);
    const params = new URLSearchParams({
      query: query || (kind.modrinth === 'shader' ? 'shader' : kind.modrinth === 'resourcepack' ? 'texture' : ''),
      limit: String(limit), offset: String(offset), index: 'relevance',
      facets: JSON.stringify(facets),
    });
    const url = `${MODRINTH_API}/search?${params}`;
    const j = await getJson(url, 'official');
    return {
      source: 'modrinth',
      total: j.totalHits ?? j.total_hits ?? (j.hits || []).length,
      items: (j.hits || []).map((h) => ({
        source: 'modrinth',
        id: h.project_id,
        slug: h.slug,
        name: h.title,
        author: (h.authors || []).join('/'),
        desc: h.description,
        downloads: h.downloads,
        icon: h.icon_url,
        types: h.project_type,
        versions: h.versions || [],
        url: `https://modrinth.com/${h.project_type}/${h.slug}`,
      })),
    };
  }

  async _searchCurse({ kind, query, mcVersion, loader, limit, offset }) {
    // 实测：社区免密钥镜像（cursemeta.dries007.net / addons-ecs.forgesvc.net）均已下线，
    // 官方 api.curseforge.com 强制 x-api-key，没 Key 就只能用 Modrinth。
    const key = (this.settings.curseApiKey || '').trim();
    if (!key) {
      return {
        source: 'curse', needsKey: true, items: [], total: 0,
        error: 'CurseForge 官方接口必须有 API Key（社区免密钥镜像已全部下线）。到 https://console.curseforge.com/ 免费申请一个，填到「设置 → CurseForge API Key」即可使用；不填就用 Modrinth，模组/光影/材质都有。',
      };
    }
    const params = new URLSearchParams({ gameId: '43', classId: String(kind.curse), searchFilter: query || '', pageSize: String(Math.min(limit, 50)), index: String(Math.floor(offset / limit)), sortField: '2', sortOrder: 'desc' });
    if (mcVersion) params.set('gameVersionsFilter[]', mcVersion);
    const { readBody: rb } = require('./downloader');
    const buf = await rb(`${CURSE_SEARCH}/mods/search?${params}`, { headers: { 'x-api-key': key, 'user-agent': 'RCL/1.0' } });
    const j = JSON.parse(buf.toString('utf8'));
    return {
      source: 'curse', via: '官方 API', total: j.pagination ? j.pagination.totalCount : j.data.length,
      items: (j.data || []).map((m) => ({
        source: 'curse', id: m.id, slug: m.slug, name: m.name, author: (m.authors || []).map((a) => a.name).join('/'),
        desc: m.summary, downloads: m.downloadCount, icon: (m.links || {}).thumbnailUrl, url: m.websiteUrl,
        latestFiles: (m.latestFiles || []).map((f) => ({ id: f.id, name: f.fileName, url: f.url, size: f.fileSize, versions: f.gameVersions })),
      })),
    };
  }

  // 版本列表：热门包能有几百个版本，整表拉回来是 2.6MB / 10 秒，所以分页交给服务端做
  async modrinthFiles(projectId, mcVersion, loader, limit = 24, offset = 0) {
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (mcVersion) q.set('game_versions', JSON.stringify([mcVersion]));
    if (loader) q.set('loaders', JSON.stringify([loader]));
    const j = await getJson(`${MODRINTH_API}/project/${projectId}/version?${q}`, 'official');
    let list = Array.isArray(j) ? j : [];
    if (mcVersion) list = list.filter((v) => (v.game_versions || []).includes(mcVersion));
    if (loader) list = list.filter((v) => (v.loaders || []).includes(loader));
    return list.slice(0, limit).map((v) => ({
      id: v.id, name: v.name, version: v.version_number, loader: (v.loaders || []).join('/'),
      mc: (v.game_versions || []).join(','), files: v.files.map((f) => ({ url: f.url, name: f.filename, size: f.size })),
      date: v.date_published, changelog: (v.changelog || '').slice(0, 4000),
    }));
  }

  async curseFiles(projectId, fileId) {
    const key = (this.settings.curseApiKey || '').trim();
    if (!key) throw new Error('CurseForge 需要 API Key（见设置）');
    const { readBody: rb } = require('./downloader');
    const pick = async (id) => {
      const buf = await rb(`${CURSE_SEARCH}/mods/${projectId}/files/${id}`, { headers: { 'x-api-key': key, 'user-agent': 'RCL/1.0' } });
      return JSON.parse(buf.toString('utf8')).data;
    };
    if (fileId) return normCurse(await pick(fileId));
    const list = await rb(`${CURSE_SEARCH}/mods/${projectId}/files?pageSize=12&sortField=1&sortOrder=desc`, { headers: { 'x-api-key': key, 'user-agent': 'RCL/1.0' } });
    return JSON.parse(list.toString('utf8')).data.map(normCurse);
  }

  // 把文件下载到目标目录（模组→mods，光影→shaderpacks，材质→resourcepacks）
  async downloadFileTo(url, dir, fileName) {
    ensureDir(dir);
    const name = (fileName || url.split('/').pop().split('?')[0]).replace(/[\\/:*?"<>|]/g, '_');
    const target = path.join(dir, name);
    const q = this._queue(`下载 ${name}`, [{ name, target, url, candidates: [url], size: 0 }]);
    const r = await q.run();
    if (r.errors.length) throw new Error('文件下载失败：' + r.errors[0]);
    return { file: target, bytes: fs.statSync(target).size };
  }
}

function throwJson(mc) { throw new Error(`${mc} 的版本信息损坏，请重新下载`); }

function normCurse(d) {
  return {
    id: d.id,
    name: d.displayName || d.fileName,
    fileName: d.fileName,
    url: d.downloadUrl || null,
    size: d.fileSize,
    versions: d.gameVersions || [],
    loaders: (d.dependencies || []).filter((x) => /fabric|forge|neoforge|quilt/i.test(x.relationType || '')).map((x) => x.modId),
  };
}

module.exports = { Remote, TYPES };
