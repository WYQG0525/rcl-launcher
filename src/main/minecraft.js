'use strict';
// 各来源（Mojang / Paper / Fabric / Forge / Temurin）的资源解析。
// 下载与校验在 downloader.js，本模块只负责"某个东西应该从哪里拿、放在哪"。

const path = require('node:path');

const VERSIONS = [
  { id: '1.19.2', name: 'Minecraft 1.19.2', note: 'The Wild Update' },
  { id: '1.20.1', name: 'Minecraft 1.20.1', note: 'Trails & Tales' },
  { id: '1.21.1', name: 'Minecraft 1.21.1', note: 'Tricky Trials' },
  { id: '26.3', name: 'Minecraft 26.3', note: '当前正式版' },
];

// Mojang 运行时组件名 -> JDK 大版本
const RUNTIME_MAJOR = {
  'java-runtime-alpha': 8,
  'java-runtime-beta': 11,
  'java-runtime-gamma': 17,
  'java-runtime-delta': 21,
  'java-runtime-epsilon': 25,
};

// 镜像：先试镜像，失败自动回落官方源
const MIRRORS = {
  official: { id: 'official', name: '官方源', rules: [] },
  bmclapi: {
    id: 'bmclapi',
    name: 'BMCLAPI（国内加速）',
    rules: [
      ['https://piston-meta.mojang.com', 'https://bmclapi2.bangbang93.com'],
      ['https://launchermeta.mojang.com', 'https://bmclapi2.bangbang93.com'],
      ['https://launcher.mojang.com', 'https://bmclapi2.bangbang93.com'],
      ['https://piston-data.mojang.com', 'https://bmclapi2.bangbang93.com'],
      ['https://resources.download.minecraft.net', 'https://bmclapi2.bangbang93.com/objects'],
      ['https://libraries.minecraft.net', 'https://bmclapi2.bangbang93.com/maven2'],
      ['https://maven.minecraftforge.net', 'https://bmclapi2.bangbang93.com/maven'],
      // NeoForge 官方站在国内直连经常超时（实测 117 次下载只成 21 次），BMCLAPI 整套镜像了
      ['https://maven.neoforged.net/releases', 'https://bmclapi2.bangbang93.com/maven'],
      ['https://meta.fabricmc.net', 'https://bmclapi2.bangbang93.com/fabric-meta'],
      ['https://fill.papermc.io', 'https://bmclapi2.bangbang93.com/paper'],
    ],
  },
};

function mirrorUrls(url, mirrorId) {
  const m = MIRRORS[mirrorId] || MIRRORS.official;
  const out = [];
  if (m.rules.length) {
    for (const [from, to] of m.rules) {
      if (url.startsWith(from)) { out.push(to + url.slice(from.length)); break; }
    }
  }
  out.push(url); // 官方源永远兜底
  return [...new Set(out)];
}

function mavenPath(coord) {
  const [g, a, v, c] = coord.split(':');
  return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${c ? '-' + c : ''}.jar`;
}

// 库的候选仓库：Fabric 用 url(字符串或数组)，Forge/原版用 repository，默认官方 libraries
function repoBases(l) {
  const out = [];
  const push = (u) => { if (u && !out.includes(String(u).replace(/\/$/, ''))) out.push(String(u).replace(/\/$/, '')); };
  if (Array.isArray(l.url)) l.url.forEach(push); else push(l.url);
  push(l.repository);
  push('https://libraries.minecraft.net');
  return out;
}

// 服务端主类：清单里给的是客户端 profile，专用服务端需要覆盖成 server 入口
const SERVER_MAIN_CLASS = 'net.minecraft.server.Main';

// 判断 library 规则在当前平台是否成立（平台规则 + 特性规则；服务端不满足 is_demo 等客户端特性）
function allowRules(rules) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const r of rules) {
    if (!r || (r.action !== 'allow' && r.action !== 'disallow')) continue;
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== 'windows') match = false;
      if (r.os.arch === 'x86' && process.arch === 'x64') match = false;
    }
    const features = r.features || {};
    for (const key of Object.keys(features)) {
      const want = features[key];
      const have = SERVER_FEATURES[key] === true;
      if (want !== have) match = false;
    }
    if (!match) continue;
    allowed = r.action === 'allow';
  }
  return allowed;
}

// 我们的场景恒为专用服务端
const SERVER_FEATURES = { is_server: true, is_demo: false, has_infinibug: false, is_quickPlay: false };

// Mojang 格式的 version JSON（原版 / Forge / Fabric / 通用）-> 启动所需信息
// classifiers(natives) 一律跳过：专用服务端不需要 LWJGL 原生库，JNA 自带 dll。
function resolveProfile(json, opts = {}) {
  const libs = [];
  for (const l of json.libraries || []) {
    if (!allowRules(l.rules)) continue;
    const art = l.downloads && l.downloads.artifact;
    if (art) {
      libs.push({ path: art.path, url: art.url, sha1: art.sha1, size: art.size });
    } else if (l.name) {
      const p = mavenPath(l.name);
      // Fabric 用 url(字符串或仓库数组)，Forge/原版用 repository / mavenProviders
      const bases = repoBases(l);
      libs.push({ path: p, urls: bases.map((b) => `${b}/${p}`), url: bases[0] + '/' + p, sha1: null, size: 0 });
    }
  }
  let main = json.mainClass && typeof json.mainClass === 'object'
    ? (json.mainClass.server || json.mainClass.client || json.mainClass.common)
    : json.mainClass;
  // 清单给的是客户端 profile；服务端要用服务端入口（Fabric 的 KnotServer 等自带，不覆盖）
  if (opts.server !== false && main && /client\.main\.Main$/.test(main)) main = SERVER_MAIN_CLASS;
  const comp = (json.javaVersion || {}).component;
  return {
    id: json.id,
    mainClass: main,
    libraries: libs,
    javaMajor: (json.javaVersion && json.javaVersion.major) || RUNTIME_MAJOR[comp] || null,
    inheritsFrom: json.inheritsFrom || null,
    javaComponent: comp,
    serverArguments: extractServerArgs(json),
    assets: json.assets,
    assetIndex: json.assetIndex ? { url: json.assetIndex.url, sha1: json.assetIndex.sha1, size: json.assetIndex.size } : null,
  };
}

// version JSON 里的游戏参数：挑出 dedicated_server 的 profile（含 port / world 等占位符）
function extractServerArgs(json) {
  const lists = [json.minecraftArguments, json.arguments];
  for (const raw of lists) {
    if (!raw) continue;
    if (typeof raw === 'string') {
      return raw.split(' ').filter((a) => !a.startsWith('${') && !a.includes('=')).map(unescapeArg);
    }
    const featureProfiles = raw.game && raw.game.find((g) => g.target === 'args');
    const flat = flattenArgs(raw.game || [], json);
    if (flat.length) return flat;
    if (featureProfiles) return flattenArgs(featureProfiles.value, json);
  }
  return [];
}

function flattenArgs(items, json) {
  const out = [];
  const walk = (arr) => {
    for (const it of arr) {
      if (typeof it === 'string') { out.push(unescapeArg(it)); continue; }
      if (it && it.rules) {
        let ok = true;
        for (const r of it.rules || []) {
          const f = r.features || {};
          if ('is_demo' in f) ok = false;
          if (f.is_server) ok = true;
          if (f.has_agents || f.is_quickPlay || f.is_core_compatibility) ok = false;
          if (r.os && r.os.name && r.os.name !== 'windows') ok = false;
        }
        if (ok && it.value) walk(Array.isArray(it.value) ? it.value : [it.value]);
      }
    }
  };
  walk(items);
  // 服务端不认 client 专属参数
  return out.filter((a) => !['--clientId', '--username', '--version', '--assetIndex', '--assetsDir'].includes(a));
}

const unescapeArg = (a) => a.replace(/^"|"$/g, '').replace('""', '"');

// ---- 核心（Paper / Fabric / Forge）下载地址 ----
const PAPER_API = 'https://fill.papermc.io/v3';
const FABRIC_API = 'https://meta.fabricmc.net/v2';
const FORGE_MAVEN = 'https://maven.minecraftforge.net';
// NeoForge 的仓库是 Reposilite，没有 promotions 接口（api.neoforged.com 已经 301 到官网）
// 注意两个 base 不一样：构件在 /releases/... 下，版本 API 在 /api/maven/... 下
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases';
const NEOFORGE_API = 'https://maven.neoforged.net/api';
const ADOPTIUM_API = 'https://api.adoptium.net/v3';

function paperVersionUrl(mc) { return `${PAPER_API}/projects/paper/versions/${encodeURIComponent(mc)}`; }
function paperBuildUrl(mc, build) { return `${PAPER_API}/projects/paper/versions/${encodeURIComponent(mc)}/builds/${build}`; }

function fabricLoadersUrl(mc) { return `${FABRIC_API}/versions/loader/${encodeURIComponent(mc)}`; }
function fabricInstallersUrl() { return `${FABRIC_API}/versions/installer`; }
function fabricProfileUrl(mc, loader) { return `${FABRIC_API}/versions/loader/${encodeURIComponent(mc)}/${loader}/server/json`; }

function forgeMetadataUrl() { return `${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`; }
function forgeFileUrl(mcVersion, forgeVersion, classifier) {
  const file = classifier ? `forge-${forgeVersion}-${classifier}.jar` : `forge-${forgeVersion}.jar`;
  return `${FORGE_MAVEN}/net/minecraftforge/forge/${forgeVersion}/${file}`;
}

function jreAssetsUrl(major) {
  return `${ADOPTIUM_API}/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`;
}

function neoforgeVersionsUrl() { return `${NEOFORGE_API}/maven/versions/releases/net/neoforged/neoforge`; }
// 版本清单优先用 maven-metadata.xml：它在 BMCLAPI 上有镜像，而 /api/maven 没有
function neoforgeMetadataUrl() { return `${NEOFORGE_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`; }
function neoforgeFileUrl(neoVersion, classifier) {
  const file = classifier ? `neoforge-${neoVersion}-${classifier}.jar` : `neoforge-${neoVersion}.jar`;
  return `${NEOFORGE_MAVEN}/net/neoforged/neoforge/${neoVersion}/${file}`;
}
// MC 版本只能从 Gradle 元数据里的 neoform 依赖读出来（16-21KB，比下载 7MB 安装器便宜得多）
function neoforgeModuleUrl(neoVersion) { return `${NEOFORGE_MAVEN}/net/neoforged/neoforge/${neoVersion}/neoforge-${neoVersion}.module`; }
function neoforgeMcFromModule(j) {
  const deps = ((j || {}).variants || []).flatMap((v) => v.dependencies || []);
  const hit = deps.find((d) => d.group === 'net.neoforged' && d.module === 'neoform');
  const req = hit && hit.version && (hit.version.requires || hit.version.preferred);
  return req ? String(req).split('-')[0] : null;
}

// NeoForge 版本号是按 MC 派生的：MC 1.21.1 → 21.1.*，MC 26.1.2 → 26.1.2.*
// 只是粗筛用的前缀，最终仍以 .module 里的 neoform 依赖为准
function neoforgePrefix(mc) {
  const old = /^1\.(\d+)\.(\d+)/.exec(String(mc || ''));
  if (old) return `${old[1]}.${old[2]}.`;
  const three = /^(\d+)\.(\d+)\.(\d+)/.exec(String(mc || ''));
  if (three) return `${three[1]}.${three[2]}.${three[3]}.`;
  const two = /^(\d+)\.(\d+)$/.exec(String(mc || ''));
  return two ? `${two[1]}.${two[2]}.` : null;
}

module.exports = {
  VERSIONS, RUNTIME_MAJOR, MIRRORS,
  mirrorUrls, mavenPath, allowRules, resolveProfile,
  paperVersionUrl, paperBuildUrl,
  fabricLoadersUrl, fabricInstallersUrl, fabricProfileUrl, repoBases,
  forgeMetadataUrl, forgeFileUrl, jreAssetsUrl,
  neoforgeVersionsUrl, neoforgeMetadataUrl, neoforgeFileUrl, neoforgeModuleUrl, neoforgeMcFromModule, neoforgePrefix,
};
