'use strict';
// Java 运行环境：内置 JRE + 系统 JDK 探测与选择

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const os = require('node:os');

const cache = new Map();

function runJavaVersion(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['-version'], { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      const text = `${stderr || ''}${stdout || ''}`;
      const m = text.match(/version\s+"([^"]+)"/);
      if (!m) return resolve(null);
      const v = m[1];
      const major = /^1\./.test(v) ? parseInt(v.split('.')[1], 10) : parseInt(v.split('.')[0], 10);
      resolve({ major, raw: v, build: text.split('\n')[0].trim() });
    });
  });
}

function exeIn(dir) {
  const p = path.join(dir, 'bin', 'java.exe');
  return fs.existsSync(p) ? p : null;
}

function scanDir(dir) {
  const hits = [];
  const self = exeIn(dir);
  if (self) hits.push(self);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return hits; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    const j = exeIn(p) || exeIn(path.join(p, 'jre')) || exeIn(path.join(p, 'latest'));
    if (j) hits.push(j);
  }
  return hits;
}

function candidateDirs() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pfx = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = path.join(os.homedir(), 'AppData', 'Local', 'Programs');
  const roaming = path.join(os.homedir(), 'AppData', 'Roaming');
  return [
    path.join(pf, 'Java'), path.join(pf, 'Eclipse Adoptium'), path.join(pf, 'Microsoft'),
    path.join(pf, 'Zulu'), path.join(pf, 'Amazon Corretto'), path.join(pf, 'BellSoft'),
    path.join(pf, 'Eclipse Foundation'), path.join(pf, 'Semeru'), path.join(pf, 'AdoptOpenJDK'),
    path.join(pfx, 'Java'), path.join(local, 'Java'),
    path.join(roaming, '.minecraft', 'runtime'),
    path.join(process.env.LOCALAPPDATA || '', '.minecraft', 'runtime'),
  ];
}

async function discover(runtimeDir) {
  const found = [];
  const seen = new Set();
  const assetsRoot = path.resolve(runtimeDir || '');

  const push = async (rawExe, source) => {
    const exe = rawExe ? path.resolve(rawExe) : null;
    if (!exe || seen.has(exe.toLowerCase())) return;
    seen.add(exe.toLowerCase());
    if (!cache.has(exe.toLowerCase())) {
      const info = await runJavaVersion(exe);
      cache.set(exe.toLowerCase(), info);
    }
    const info = cache.get(exe.toLowerCase());
    if (info) found.push({ path: exe, major: info.major, raw: info.raw, source });
  };

  // 1. 程序自带的运行时目录（%APPDATA%\RCL\runtime\jre-N）
  try {
    for (const d of fs.readdirSync(assetsRoot)) {
      const m = d.match(/^jre-(\d+)$/);
      if (m) await push(exeIn(path.join(assetsRoot, d)), `内置 Java ${m[1]}`);
    }
  } catch { /* 还没下载运行时 */ }

  // 2. 环境变量
  for (const e of [process.env.JAVA_HOME, process.env.JDK_HOME]) {
    if (e) await push(exeIn(e) || (/[\\/]bin$/.test(e) ? path.join(e, 'java.exe') : null), '环境变量 JAVA_HOME');
  }

  // 3. PATH
  await new Promise((resolve) => {
    execFile('where', ['java'], { windowsHide: true, timeout: 8000, env: { ...process.env, PATH: process.env.PATH } }, (err, out) => {
      if (!err && out) for (const line of out.split('\n')) {
        const p = line.trim();
        if (p.toLowerCase().endsWith('java.exe') || p.toLowerCase().endsWith('java')) void push(p, '系统 PATH');
      }
      resolve();
    });
  });

  // 4. 常见安装目录
  for (const d of candidateDirs()) for (const exe of scanDir(d)) await push(exe, '系统安装');

  found.sort((a, b) => b.major - a.major);
  return found;
}

// 选择规则：优先内置且大版本精确匹配 -> 内置里刚好够用的最小版本 -> 系统里够用的最小版本
function pick(all, requiredMajor, overridePath) {
  if (overridePath) {
    const hit = all.find((j) => j.path.toLowerCase() === String(overridePath).toLowerCase());
    if (hit) return { java: hit, note: '手动指定' };
    if (fs.existsSync(overridePath)) {
      const info = cache.get(overridePath.toLowerCase());
      return { java: { path: overridePath, major: info ? info.major : null, raw: info ? info.raw : '未知', source: '手动指定' }, note: '手动指定' };
    }
  }
  const need = requiredMajor || 17;
  const enough = all.filter((j) => j.major >= need);
  const bundled = enough.filter((j) => j.source.startsWith('内置'));
  const exactBundled = bundled.filter((j) => j.major === need);
  const chosen = (exactBundled.length && exactBundled[0])
    || (bundled.length && bundled.sort((a, b) => a.major - b.major)[0])
    || (enough.length && enough.sort((a, b) => a.major - b.major)[0])
    || null;
  if (!chosen) return { java: null, note: `没找到 Java ${need}+，请先安装或指定 Java 路径` };
  const tooNew = chosen.major > need + 4;
  return { java: chosen, note: chosen.major === need ? `内置/系统 Java ${chosen.major}（精确匹配）` : `用 Java ${chosen.major} 跑需要 ${need} 的版本${tooNew ? '（跨度过大，若报错请改选对应版本 Java）' : ''}` };
}

module.exports = { discover, pick, runJavaVersion, cache };
