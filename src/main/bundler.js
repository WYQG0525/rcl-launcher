'use strict';
// Mojang bundler 格式处理：专用服务端 jar 里内嵌了全部依赖与真正的游戏 jar，
// 解包一次到共享目录后，所有实例、Paper/Fabric 都能复用，不用每个服重复解包。

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function centralDir(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这个 jar 不是 zip，读不懂');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncompSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryBytes(buf, e) {
  const lo = e.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error(`本地头损坏：${e.name}`);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的压缩方式 ${e.method}：${e.name}`);
}

function readTextEntry(buf, entries, name) {
  const e = entries.find((x) => x.name === name);
  return e ? entryBytes(buf, e).toString('utf8').trim() : null;
}

// 解出 META-INF/libraries/** 与 META-INF/versions/**，返回可直接拼 classpath 的绝对路径
function extract(serverJar, destDir, onStep) {
  const marker = path.join(destDir, '.mcl-bundler.json');
  const stat = fs.statSync(serverJar);
  if (fs.existsSync(marker)) {
    try {
      const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (m.jarSize === stat.size && m.jarMtime === stat.mtimeMs && m.cp.every((p) => fs.existsSync(path.join(destDir, p)))) {
        return { dir: destDir, mainClass: m.mainClass, cp: m.cp.map((p) => path.join(destDir, p)), cached: true };
      }
    } catch { /* 重新解 */ }
  }

  const buf = fs.readFileSync(serverJar);
  const entries = centralDir(buf);
  const mainClass = readTextEntry(buf, entries, 'META-INF/main-class') || 'net.minecraft.server.Main';
  const classpathJoined = readTextEntry(buf, entries, 'META-INF/classpath-joined');
  const wanted = entries.filter((e) => !e.name.endsWith('/') && (e.name.startsWith('META-INF/libraries/') || e.name.startsWith('META-INF/versions/')));
  if (!wanted.length) throw new Error(`${path.basename(serverJar)} 不是 bundler 格式（没有内嵌依赖），请改用版本库依赖下载`);

  fs.mkdirSync(destDir, { recursive: true });
  const rel = [];
  let i = 0;
  for (const e of wanted) {
    const out = e.name.replace(/^META-INF\//, '');
    const target = path.join(destDir, out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entryBytes(buf, e));
    rel.push(out.split(path.sep).join('/'));
    if (onStep && ++i % 12 === 0) onStep(`${i}/${wanted.length}`);
  }
  // classpath 顺序以 Mojang 自己给的列表为准（游戏 jar 在最后）
  const cp = classpathJoined ? classpathJoined.split(';').map((s) => s.trim()).filter((s) => rel.includes(s)) : rel;
  const ordered = cp.length === rel.length ? cp : [...rel.filter((r) => !r.startsWith('versions/')), ...rel.filter((r) => r.startsWith('versions/'))];
  fs.writeFileSync(marker, JSON.stringify({ jarSize: stat.size, jarMtime: stat.mtimeMs, mainClass, cp: ordered }, null, 2), 'utf8');
  return { dir: destDir, mainClass, cp: ordered.map((p) => path.join(destDir, p)), cached: false, count: ordered.length };
}

module.exports = { extract, centralDir, entryBytes, readTextEntry };
