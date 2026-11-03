'use strict';
// 整合包：Modrinth 的 .mrpack 就是一个 zip，里面
//   modrinth.index.json  —— 清单（files[].hashes.sha1 / env / downloads，dependencies 里带加载器）
//   overrides/**         —— 要直接铺进游戏目录的配置、脚本
//   client-overrides/**  —— 只有客户端要的覆盖（服务端整合包用不上）
// 这里只做"读懂 + 铺文件"，下载交给 remote 的队列，进度和取消才能出现在「下载管理」里。

const fs = require('node:fs');
const path = require('node:path');
const bundler = require('./bundler');

const MB = (n) => (Number(n || 0) / 1048576).toFixed(1);

// dependencies 里的键 → RCL 的加载器类型
const LOADERS = {
  'fabric-loader': 'fabric',
  'quilt-loader': 'quilt',
  forge: 'forge',
  neoforge: 'neoforge',
};

function readMrpack(file) {
  const buf = fs.readFileSync(file);
  let entries;
  try { entries = bundler.centralDir(buf); } catch { throw new Error('这个 .mrpack 不是有效的 zip，可能下载坏了'); }
  const e = entries.find((x) => x.name === 'modrinth.index.json');
  if (!e) throw new Error('这个压缩包里找不到 modrinth.index.json，不是 Modrinth 整合包（CurseForge 的 zip 结构不一样）');
  let index;
  try { index = JSON.parse(bundler.entryBytes(buf, e).toString('utf8')); } catch { throw new Error('modrinth.index.json 读不懂（文件坏了）'); }
  if (!index || !Array.isArray(index.files)) throw new Error('modrinth.index.json 缺 files 列表');
  return { buf, entries, index };
}

function loaderOfIndex(index) {
  const dep = index.dependencies || {};
  const mc = dep.minecraft || null;
  for (const [k, type] of Object.entries(LOADERS)) {
    if (dep[k]) return { mc, type, version: String(dep[k]) };
  }
  return { mc, type: 'vanilla', version: '' };
}

function summarize(file) {
  const { index, entries } = readMrpack(file);
  const l = loaderOfIndex(index);
  const files = index.files.filter((f) => f && f.path && (f.downloads || []).length);
  const skip = index.files.filter((f) => f && f.path && f.env && f.env.client === 'unsupported');
  const ov = entries.filter((e) => !e.name.endsWith('/') && /^(overrides|client-overrides)\//.test(e.name));
  return {
    name: index.name || path.basename(file, path.extname(file)),
    version: index.versionId || '',
    mc: l.mc,
    loader: { type: l.type, version: l.version },
    files: files.length,
    skipped: skip.length,
    bytes: files.reduce((s, f) => s + (f.fileSize || 0), 0),
    overrides: ov.length,
    formatVersion: index.formatVersion,
    folders: [...new Set(files.map((f) => f.path.split('/')[0]).filter(Boolean))].join(', '),
  };
}

// 目标路径必须老老实实待在档案目录里：整合包是别人写的，path 不能信
function safeJoin(root, rel) {
  const clean = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.join(root, ...clean.split('/'));
  const r = path.relative(root, target);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error(`整合包里有越界路径：${rel}`);
  return target;
}

// 客户端要下的文件清单（env.client=unsupported 的一律跳过）
function clientTasks(index, dest) {
  const tasks = [];
  let skipped = 0;
  for (const f of index.files || []) {
    if (!f || !f.path || !(f.downloads || []).length) continue;
    if (f.env && f.env.client === 'unsupported') { skipped++; continue; }
    const hash = (f.hashes && f.hashes.sha1) || null;
    tasks.push({
      name: path.basename(f.path),
      target: safeJoin(dest, f.path),
      url: f.downloads[0],
      candidates: f.downloads,
      sha1: hash,
      size: f.fileSize || 0,
    });
  }
  return { tasks, skipped };
}

// overrides 后铺（client-overrides 覆盖 overrides），返回铺了多少文件
function extractOverrides(pack, dest) {
  const { buf, entries } = pack;
  let count = 0;
  let bytes = 0;
  for (const layer of ['overrides', 'client-overrides']) {
    const pre = `${layer}/`;
    for (const e of entries) {
      if (!e.name.startsWith(pre) || e.name.endsWith('/')) continue;
      const rel = e.name.slice(pre.length);
      let target;
      try { target = safeJoin(dest, rel); } catch { continue; }
      const data = bundler.entryBytes(buf, e);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      count++;
      bytes += data.length;
    }
  }
  return { count, bytes };
}

module.exports = { readMrpack, summarize, loaderOfIndex, clientTasks, extractOverrides, safeJoin, MB };
