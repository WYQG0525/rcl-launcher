'use strict';
// 统一端到端验证：空/复用数据目录 → 按需下载 → 生成启动计划 → 真实启动 → 发指令 → 停止
// 用法：node scripts/e2e.cjs <mc版本> [vanilla|paper|fabric|forge|client] [--fresh] [--java=17]

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const mc = process.argv[2] || '1.21.1';
const core = (process.argv[3] || 'vanilla').toLowerCase();
const fresh = process.argv.includes('--fresh');
const javaArg = (process.argv.find((a) => a.startsWith('--java=')) || '').slice(7);
const dataDir = path.join(ROOT, 'tmp', `e2e-${core}`);
process.env.MCL_DATA = dataDir;
if (fresh) fs.rmSync(dataDir, { recursive: true, force: true });

const { Store } = require(path.join(ROOT, 'src/main/store'));
const { Catalog, buildPlan } = require(path.join(ROOT, 'src/main/profiles'));
const { ServerManager } = require(path.join(ROOT, 'src/main/manager'));
const { Installer } = require(path.join(ROOT, 'src/main/installer'));
const { Remote } = require(path.join(ROOT, 'src/main/remote'));
const { ClientStore } = require(path.join(ROOT, 'src/main/client'));
const { Auth } = require(path.join(ROOT, 'src/main/auth'));
const jre = require(path.join(ROOT, 'src/main/jre'));

const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
let raw = '';

(async () => {
  const store = new Store(dataDir);
  store.patchSettings({ autoEula: true, memoryMB: 2048, mirror: process.env.MIRROR || 'official', jvmPreset: 'aikar' });
  store.settings.appVersion = '1.0.1';
  const catalog = new Catalog(store.dirs);
  catalog.isolationMode = () => store.settings.isolation;
  const remote = new Remote({ store, dirs: store.dirs, catalog });
  const auth = new Auth({ dirs: store.dirs });
  const client = new ClientStore({ store, catalog, remote, auth });
  const installer = new Installer({ store, catalog, remote });
  let lastPct = -20;
  remote.onProgress = (p) => {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
    if (pct - lastPct >= 20 || p.done === p.total) { lastPct = pct; say(`  ${p.label} ${p.done}/${p.total}`); }
  };
  installer.on('log', (l) => say(l));

  let javaList = await jre.discover(store.dirs.runtime);
  if (javaArg) javaList = javaList.filter((j) => String(j.major) === javaArg);
  if (!javaList.length) {
    say('没有可用 Java，先按需下载 21');
    await remote.downloadJre(21);
    javaList = await jre.discover(store.dirs.runtime);
  }
  say('Java:', javaList.map((j) => `${j.major}(${j.source})`).join(', ') || '无');
  const pickJava = (inst, major) => jre.pick(javaList, major, inst && inst.javaPath);

  // 1. 保证版本文件在本地
  await remote.versionJson(mc);
  if (core === 'client') {
    const r = await client.install(mc, { withAssets: true });
    say('客户端:', r.assets.note, '| 完整:', r.ready);
    if (!r.ready) throw new Error('客户端资源不完整');
  } else {
    await remote.downloadServer(mc);
    await remote.downloadLibraries(mc, { client: false });
  }

  // 2. 保证核心在本地
  if (core === 'paper') { const r = await installer.installPaper(mc); say('Paper:', `build ${r.build}`, `${(r.size / 1048576).toFixed(0)}MB`); }
  if (core === 'fabric') { const r = await installer.installFabric(mc); say('Fabric:', `loader ${r.loader}`, `库 ${r.got}/${r.libs}`); }

  // 3. 建实例并启动
  const manager = new ServerManager({
    store, catalog, pickJava,
    repo: core === 'client' ? {
      get: (id) => store.getGame(id),
      dirOf: (g) => store.gameDir(g),
      patch: (id, p) => store.patchGame(id, p),
      all: () => store.games,
      label: '客户端',
      readyOnSpawn: true,
      graceful: false,
      prepare: (g) => fs.mkdirSync(store.gameDir(g), { recursive: true }),
      buildPlan: (g) => client.buildPlan({ game: { ...g, dir: store.gameDir(g) }, settings: store.settings }),
    } : undefined,
  });
  manager.on('console', (p) => { raw += p.chunk; });

  let id;
  if (core === 'client') {
    const g = store.games.find((x) => x.name === 'e2e-client') || store.createGame({ name: 'e2e-client', mcVersion: mc, username: 'E2ETester', width: 640, height: 360, memoryMB: 2048 });
    id = g.id;
  } else {
    const name = `e2e-${mc}-${core}`;
    const inst = store.instances.find((i) => i.name === name) || store.createInstance({ name, mcVersion: mc, core });
    id = inst.id;
    if (core === 'forge') {
      const list = await installer.listForge(mc);
      const fv = list.recommended;
      if (!fv) throw new Error(`${mc} 没有 Forge 版本`);
      installer.pickJava = pickJava;
      const r = await installer.installForge(store.get(id), fv);
      say('Forge:', r.note);
      store.patch(id, { core: 'forge', coreVersion: fv, installed: true });
    }
    if (core === 'neoforge') {
      const list = await installer.listNeoForge(mc);
      const nv = list.recommended;
      if (!nv) throw new Error(`${mc} 没有 NeoForge 版本${list.error ? '（' + list.error + '）' : ''}`);
      say(`NeoForge 候选 ${list.total || 0} 个，确认对得上的 ${list.versions.length} 个，取 ${nv}`);
      installer.pickJava = pickJava;
      const r = await installer.installNeoForge(store.get(id), nv);
      say('NeoForge:', r.note);
      store.patch(id, { core: 'neoforge', coreVersion: nv, installed: true });
    }
  }

  say(`启动 ${core} ${mc} …`);
  await manager.start(id);
  const isClient = core === 'client';
  const deadline = Date.now() + (isClient ? 240000 : 260000);
  let ready = false;
  while (Date.now() < deadline) {
    if (isClient ? /Backend library: LWJGL|OpenAL initialized/.test(raw) : /Done\s*\([\d.]+s\)/.test(raw)) { ready = true; break; }
    const st = manager.state(id);
    if (st.state === 'stopped' && st.exit) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (ready && !isClient) {
    await manager.send(id, 'list');
    await new Promise((r) => setTimeout(r, 3000));
  }
  const st = manager.state(id);
  if (!ready) console.log('末尾日志:\n' + raw.split(/\r?\n/).slice(-24).join('\n'));
  await manager.stop(id, {});
  const ok = isClient ? (ready && st.exit !== undefined) : (ready && /There are/.test(raw));
  const local = catalog.localInfo();
  say('本地占用:', Object.entries(local.bytes).filter(([, n]) => n).map(([k, n]) => `${k} ${(n / 1048576).toFixed(0)}MB`).join(' ') || '无');
  console.log(`\n结果: ${ok ? 'PASS' : 'FAIL'}  ${core} ${mc}  用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('E2E 崩了:', e); process.exit(1); });
