'use strict';
// Electron 主进程：装配 store / catalog / remote / auth / manager / installer / client，并把能力暴露给界面。

const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const { dataRoot, ensureDirs, sanitizeName, dirSizeSync } = require('./paths');
const { Store, probeGameDir } = require('./store');
const { Catalog, buildPlan, JVM_PRESETS, ensureVanillaLayout } = require('./profiles');
const { ServerManager, readServerProperties } = require('./manager');
const { Installer } = require('./installer');
const { Remote, TYPES } = require('./remote');
const { ClientStore } = require('./client');
const { Auth, AAI_PRESETS } = require('./auth');
const { Updater } = require('./updater');
const modpack = require('./modpack');
const jobs = require('./jobs');
const jre = require('./jre');

let win = null;
let store, catalog, remote, auth, manager, gameManager, installer, client, updater;
let javaList = [];
let tray = null;
let hiddenToTray = false;

const isDev = !app.isPackaged;

function iconPath() {
  const p = path.join(__dirname, '..', '..', 'build', 'icon.ico');
  return fs.existsSync(p) ? p : null;
}

// 单实例锁在 app.setName / setPath 之后再申请，否则锁按默认目录判定，MCL_DATA 隔离的实例会互相挡住

function showWindow() {
  hiddenToTray = false;
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp() {
  app.forceQuit = true;
  try { manager && manager.killAll(); gameManager && gameManager.killAll(); } catch { /* noop */ }
  app.quit();
}

function createTray() {
  const ico = iconPath();
  let img = ico ? nativeImage.createFromPath(ico) : nativeImage.createEmpty();
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  tray = new Tray(img);
  const refresh = () => {
    if (!tray || tray.isDestroyed()) return;
    const running = (manager ? manager.runningCount() : 0) + (gameManager ? gameManager.runningCount() : 0);
    const j = jobs.snapshot();
    const dl = j.active ? ` · 下载 ${j.active} 项 ${(j.speed / 1048576).toFixed(1)}MB/s` : '';
    tray.setToolTip(`RCL 启动器${running ? ` · ${running} 个在运行` : ''}${dl}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: running ? `正在运行 ${running} 个` : '没有运行中的程序', enabled: false },
      ...(j.active ? [{ label: `下载中 ${j.active} 项 · ${(j.speed / 1048576).toFixed(1)} MB/s`, enabled: false }] : []),
      { type: 'separator' },
      { label: '显示主界面', click: () => showWindow() },
      { label: '停止全部服务器与游戏', enabled: running > 0, click: async () => { await manager.stopAll(25000); await gameManager.stopAll(25000); } },
      { label: '取消全部下载', enabled: j.active > 0, click: () => jobs.cancelAll() },
      { type: 'separator' },
      { label: '退出 RCL', click: () => quitApp() },
    ]));
  };
  tray.on('click', () => (win && win.isVisible() ? hideToTray() : showWindow()));
  tray.on('double-click', () => showWindow());
  app.trayRefresh = refresh;
  refresh();
  return refresh;
}

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  hiddenToTray = true;
  if (tray && !store.settings.trayTipShown) {
    try { tray.displayBalloon({ title: 'RCL 已在后台运行', content: '双击托盘图标可再次打开；也可以在「设置」里改成直接退出。', iconType: 'info' }); } catch { /* 部分系统不支持气泡 */ }
    store.patchSettings({ trayTipShown: true });
  }
  if (app.trayRefresh) app.trayRefresh();
}

// 控制台输出批量转发，避免 IPC 刷屏拖垮界面
const consoleBuf = new Map();
setInterval(() => {
  if (!win || win.isDestroyed()) { consoleBuf.clear(); return; }
  for (const [id, chunks] of consoleBuf) {
    if (!chunks.length) continue;
    win.webContents.send('console', { id, chunk: chunks.join('') });
    consoleBuf.delete(id);
  }
}, 60);

function forwardConsole(payload) {
  const arr = consoleBuf.get(payload.id) || [];
  arr.push(payload.chunk);
  if (arr.join('').length > 400000) arr.splice(0, arr.length - 1); // 极端刷屏时丢最老的
  consoleBuf.set(payload.id, arr);
}

function pickJava(inst, requiredMajor) {
  const settings = store.settings;
  const override = (inst && inst.javaPath) || (requiredMajor && settings.javaByMajor[String(requiredMajor)]);
  return jre.pick(javaList, requiredMajor || (inst && inst.javaMajor) || null, override);
}

app.setName('RCL');
app.setPath('userData', dataRoot());

// 只允许一个实例：从托盘再次启动时把已有窗口叫出来
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

async function boot() {
  store = new Store(dataRoot());
  store.settings.appVersion = app.getVersion();
  store.dirs = ensureDirs(store.root);
  catalog = new Catalog(store.dirs);
  remote = new Remote({ store, dirs: store.dirs });
  auth = new Auth({ dirs: store.dirs });
  manager = new ServerManager({ store, catalog, pickJava });
  installer = new Installer({ store, catalog, remote });
  installer.pickJava = pickJava;
  client = new ClientStore({ store, catalog, remote, auth });
  installer.client = client;   // 整合包要先补齐原版客户端才能叠东西，安装器反过来用它
  updater = new Updater({ store, catalog, remote });

  gameManager = new ServerManager({
    store, catalog, pickJava,
    repo: {
      get: (id) => store.getGame(id),
      dirOf: (g) => store.gameDir(g),
      patch: (id, p) => store.patchGame(id, p),
      all: () => store.games,
      label: '客户端',
      readyOnSpawn: true,   // 游戏没有 "Done" 日志，进程起来就算运行
      graceful: false,      // 游戏不读 stdin，停止即结束进程
      prepare: (g) => fs.mkdirSync(store.gameDir(g), { recursive: true }),
      buildPlan: (g) => client.buildPlan({ game: { ...g, dir: store.gameDir(g) }, settings: store.settings }),
    },
  });

  manager.on('console', forwardConsole);
  manager.on('state', (s) => { win && win.webContents.send('server-state', s); if (app.trayRefresh) app.trayRefresh(); });
  gameManager.on('console', forwardConsole);
  gameManager.on('state', (s) => { win && win.webContents.send('game-state', s); if (app.trayRefresh) app.trayRefresh(); });
  installer.on('progress', (p) => win && win.webContents.send('install-progress', p));
  installer.on('log', (l) => win && win.webContents.send('install-log', l));
  remote.onProgress = (p) => win && win.webContents.send('install-progress', p);
  jobs.on('update', (snap) => {
    if (win && !win.isDestroyed()) win.webContents.send('jobs-update', snap);
    if (app.trayRefresh) app.trayRefresh();
  });

  javaList = await jre.discover(store.dirs.runtime);
  try { await remote.versionList(); } catch (e) { console.log('版本清单拉取失败（离线时用缓存）:', e.message); }

  createWindow();
  createTray();
  if (process.env.MCL_SELFTEST) runSelfTest();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#101418',
    title: 'RCL',
    autoHideMenuBar: true,
    icon: iconPath() || undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!process.env.MCL_SILENT) win.show(); });
  if (isDev) {
    if (process.env.MCL_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer ${level}] ${message} @ ${String(sourceId).split('/').pop()}:${line}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc) => console.log(`[renderer] 页面加载失败 ${code} ${desc}`));
    win.webContents.once('did-finish-load', () => console.log('[renderer] 页面加载完成'));
  }
  win.on('close', (e) => {
    if (app.forceQuit) return;
    e.preventDefault();
    const running = (manager ? manager.runningCount() : 0) + (gameManager ? gameManager.runningCount() : 0);
    if (running > 0) { win.webContents.send('app-ask-quit', running); return; }
    const act = store.settings.closeAction || 'ask';
    if (act === 'tray') hideToTray();
    else if (act === 'quit') { app.forceQuit = true; if (tray && !tray.isDestroyed()) tray.destroy(); win.destroy(); app.quit(); }
    else win.webContents.send('app-ask-close');
  });
  win.on('show', () => { hiddenToTray = false; if (app.trayRefresh) app.trayRefresh(); });
}

// 开发态自检：不弹窗口地跑一遍 IPC + 渲染 + 建/删，结果打到 stdout
async function runSelfTest() {
  const full = process.env.MCL_SELFTEST === 'full';
  // 导入功能需要一个"磁盘上本来就有的游戏目录"，就地造一个最小的，跑完随数据目录一起删
  const fixture = path.join(store.dirs.root, 'selftest-import-src');
  fs.mkdirSync(path.join(fixture, 'versions', '1.20.1'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'versions', '1.20.1', '1.20.1.json'), JSON.stringify({ id: '1.20.1', mainClass: 'net.minecraft.client.main.Main', libraries: [] }));
  fs.mkdirSync(path.join(fixture, 'saves', '老存档'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'saves', '老存档', 'level.dat'), 'x');
  fs.mkdirSync(path.join(fixture, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'mods', '某个模组.jar'), 'jar');
  const script = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const DO_FULL = ${full};
    const out = { steps: [], errors: [] };
    const step = (k, v) => out.steps.push(k + '=' + v);
    const click = (sel) => { const el = document.querySelector(sel); if (!el) throw new Error('找不到元素 ' + sel); el.click(); };
    const val = (sel, v) => { const el = document.querySelector(sel); if (!el) throw new Error('找不到输入 ' + sel); el.value = v; };
    const pick = (sel, v) => { const el = document.querySelector(sel); if (!el) throw new Error('找不到下拉 ' + sel); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    // 网络请求快慢差好几倍，用固定 sleep 会假报警 —— 等到条件成立或超时
    const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { let v = false; try { v = !!fn(); } catch { /* 还没渲染 */ } if (v || Date.now() - t0 > ms) return v; await sleep(300); } };
    try {
      await sleep(1200);
      out.hasBridge = !!window.mcl;
      const info = await window.mcl.info();
      out.name = info.name + '/' + info.version;
      out.mirror = info.settings.mirror;
      out.jres = (info.local.jres || []).join(',');
      out.javas = info.javaList.map(j => j.major + '(' + j.source + ')').join(' ');
      out.accounts = (info.accounts || []).map(a => a.type + ':' + a.name).join(',');

      click('#nav button[data-view=game]');
      await sleep(500);
      step('游戏页标题', document.querySelector('#view-title').textContent);
      click('#btn-new-game');
      await sleep(400);
      step('档案弹窗字段数', document.querySelectorAll('#modal-body [data-key]').length);
      step('弹窗不再含内存项', !document.querySelector('#modal-body [data-key=memoryMB]'));
      const shown = (k) => { const el = document.querySelector('#modal-body [data-fkey=' + k + ']'); return !!el && !el.hidden; };
      step('离线时隐藏账号项', !shown('authName'));
      step('离线时隐藏第三方项', !shown('aaiRoot'));
      val('#modal-body [data-key=name]', '自检玩家');
      val('#modal-body [data-key=username]', 'RCLTester');
      pick('#modal-body [data-key=authType]', 'aai');
      await sleep(150);
      step('选第三方后出现地址项', shown('aaiRoot'));
      step('选第三方后仍隐藏账号项', !shown('authName'));
      pick('#modal-body [data-key=authType]', 'microsoft');
      await sleep(150);
      step('选正版后换回账号项', shown('authName') && !shown('aaiRoot'));
      pick('#modal-body [data-key=authType]', 'aai');
      await sleep(150);
      click('#modal-ok');
      await sleep(1800);
      step('档案卡片数', document.querySelectorAll('#game-list .pcard:not(.add)').length);
      step('游戏主区名称', document.querySelector('#g-name').textContent);
      step('登录方式已保存', (document.querySelector('#g-badges').textContent || '').includes('第三方') ? 'aai' : '丢失:' + document.querySelector('#g-badges').textContent);
      step('资源卡片数', document.querySelectorAll('#g-res .res-item').length);
      step('资源提示', (document.querySelector('#g-res-hint').textContent || '').slice(0, 60));
      for (const t of ['form', 'saves', 'plan', 'log']) {
        click('#gtabs button[data-gtab=' + t + ']');
        await sleep(500);
        step('游戏页 ' + t + ' 有内容', (document.querySelector('#gtab-' + t).textContent || '').trim().length > 6);
      }
      // 档案设置页同样要跟着登录方式收字段
      const gshown = (k) => { const el = document.querySelector('#gform [data-fkey=' + k + ']'); return !!el && !el.hidden; };
      step('档案页第三方项可见', gshown('aaiRoot'));
      step('档案页账号项隐藏', !gshown('authName'));
      pick('#gform [data-key=authType]', 'offline');
      await sleep(200);
      step('档案页改离线后两项都收起', !gshown('aaiRoot') && !gshown('authName'));
      pick('#gform [data-key=authType]', 'aai');
      await sleep(200);

      step('有导入按钮', !!document.querySelector('#btn-game-import'));
      step('有装整合包按钮', !!document.querySelector('#btn-game-modpack'));

      // 内容页：进页面应自动出结果，不需要点搜索
      const items = () => document.querySelectorAll('#c-list .item').length;
      const settled = () => !/搜索中/.test(document.querySelector('#c-status').textContent || '') && items() > 0;
      click('#nav button[data-view=content]');
      await until(settled);
      step('自动搜索结果条数', items());
      step('首条结果', (document.querySelector('#c-list .item b') || {}).textContent || '-');
      step('内容状态', (document.querySelector('#c-status').textContent || '').slice(0, 40));
      step('有加载更多', !!document.querySelector('#c-more'));
      const more = document.querySelector('#c-more');
      if (more) {
        const n0 = items();
        more.click();
        await until(() => items() > n0);
        step('加载更多后条数', items());
      }
      step('内容页有整合包类型', [...document.querySelectorAll('#c-type option')].some((o) => o.value === 'modpack'));
      pick('#c-type', 'modpack');
      await sleep(600);
      await until(() => settled() && (document.querySelector('#c-list .item b') || {}).textContent !== 'Fabric API');
      step('整合包搜索结果条数', items());
      step('整合包首条', (document.querySelector('#c-list .item b') || {}).textContent || '-');
      pick('#c-type', 'mod');

      click('#nav button[data-view=game]');
      await sleep(400);
      click('#btn-game-remove');
      await sleep(500);
      const gcb = document.querySelector('#modal-body [data-key=deleteFiles]');
      if (gcb) gcb.checked = true;
      click('#modal-ok');
      await sleep(1300);
      step('删除档案后卡片数', document.querySelectorAll('#game-list .pcard:not(.add)').length);

      // 导入已有目录：走真实 IPC，最后确认没碰用户文件
      const fx = ${JSON.stringify(fixture)};
      const probe = await window.mcl.gamesProbe(fx);
      step('探到导入目录版本', probe.versions.map((v) => v.id + '/' + v.mc).join(','));
      step('探到存档与模组', probe.saves + ' 存档 / ' + probe.mods + ' 模组');
      const imp = await window.mcl.gamesImport({ dir: fx, versionId: '1.20.1', name: '导入自检', username: 'Importer' });
      step('导入档案指向原目录', imp.game.dir === fx);
      step('导入档案进列表', (await window.mcl.gamesList()).some((g) => g.name === '导入自检'));
      await window.mcl.gamesRemove({ id: imp.game.id, deleteFiles: true });
      const re = await window.mcl.gamesProbe(fx);
      step('删档案没动用户文件', re.saves === 1 && re.mods === 1);

      click('#nav button[data-view=server]');
      await sleep(400);
      step('服务器页标题', document.querySelector('#view-title').textContent);
      click('#btn-new-server');
      await sleep(400);
      step('服务器弹窗字段数', document.querySelectorAll('#modal-body [data-key]').length);
      val('#modal-body [data-key=name]', '界面自检服');
      click('#modal-ok');
      await sleep(1500);
      step('服务器卡片数', document.querySelectorAll('#server-list .pcard:not(.add)').length);
      step('主区名称', document.querySelector('#hero-name').textContent);
      click('#tabs button[data-tab=props]');
      await sleep(700);
      step('属性表单字段数', document.querySelectorAll('#props-form [data-key]').length);
      click('#tabs button[data-tab=mods]');
      await sleep(500);
      step('模组页有内容', (document.querySelector('#tab-mods').textContent || '').trim().length > 6);

      click('#nav button[data-view=jobs]');
      await sleep(700);
      step('下载管理页标题', document.querySelector('#view-title').textContent);
      step('有任务列表容器', !!document.querySelector('#j-list'));
      step('有全部取消按钮', !!document.querySelector('#j-cancel-all'));

      click('#nav button[data-view=dl]');
      await sleep(3000);
      step('下载页版本行数', document.querySelectorAll('#dl-list .vrow').length);
      step('本地已有区', (document.querySelector('#dl-hint').textContent || '').slice(0, 40));
      step('Java 行数', document.querySelectorAll('#dl-java .core').length);
      step('有回收按钮', !!document.querySelector('#dl-clean'));
      step('下载页有整合包搜索框', !!document.querySelector('#mp-q'));
      await until(() => document.querySelectorAll('#mp-list .item').length > 0);
      step('整合包进页自动出结果', document.querySelectorAll('#mp-list .item').length);
      step('整合包首条', (document.querySelector('#mp-list .item b') || {}).textContent || '-');
      const mpOpen = document.querySelector('#mp-list [data-mp-open]');
      if (mpOpen) {
        mpOpen.click();
        await until(() => document.querySelectorAll('#mp-list [data-mp-install]').length > 0);
        step('点一条列出版本数', document.querySelectorAll('#mp-list .mp-ver .core').length);
        step('版本行有装这个按钮', !!document.querySelector('#mp-list [data-mp-install]'));
        step('版本行显示体积', /MB|KB/.test((document.querySelector('#mp-list .mp-ver em') || {}).textContent || ''));
        step('版本多了能继续加载', !!document.querySelector('#mp-list #mp-vmore'));
      }

      click('#btn-update');
      await sleep(9000);
      step('更新弹窗已开', document.querySelector('#modal').hidden === false);
      step('更新检查结果', (document.querySelector('#modal-body').textContent || '').replace(/\\s+/g, ' ').slice(0, 90));
      click('#modal-ok');
      await sleep(400);

      click('#nav button[data-view=server]');
      await sleep(400);
      click('#btn-remove');
      await sleep(500);
      const cb = document.querySelector('#modal-body [data-key=deleteFiles]');
      if (cb) cb.checked = true;
      click('#modal-ok');
      await sleep(1200);
      step('删除服务器后卡片数', document.querySelectorAll('#server-list .pcard:not(.add)').length);

      click('#nav button[data-view=settings]');
      await sleep(600);
      step('设置页字段数', document.querySelectorAll('#settings-form [data-key]').length);
      step('有托盘选项', !!document.querySelector('#settings-form [data-key=closeAction]'));
      step('有 Curse Key 选项', !!document.querySelector('#settings-form [data-key=curseApiKey]'));
    } catch (e) { out.errors.push(String((e && e.message) || e)); }
    return out;
  })()`;
  try {
    const r = await win.webContents.executeJavaScript(script, true);
    console.log('SELFTEST_RESULT ' + JSON.stringify(r));
  } catch (e) {
    console.log('SELFTEST_THROW ' + (e && e.message));
  }
  app.exit(0);
}

/* ---------------- 基础信息 ---------------- */
ipcMain.handle('app:info', async () => {
  let local;
  try { local = catalog.localInfo(); } catch (e) { local = { versions: [], paper: [], fabric: [], forge: [], jres: [], bytes: {}, error: e.message }; }
  return {
    name: 'RCL',
    version: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron,
    node: process.versions.node,
    dataRoot: store.root,
    serversRoot: store.serversRoot(),
    settings: store.settings,
    local,
    javaList,
    accounts: auth.list(),
    aaiPresets: AAI_PRESETS,
    contentTypes: Object.entries(TYPES).map(([id, t]) => ({ id, label: t.label })),
    mirrors: Object.values(require('./minecraft').MIRRORS).map((m) => ({ id: m.id, name: m.name })),
    jvmPresets: Object.entries(JVM_PRESETS).map(([id, p]) => ({ id, name: p.name })),
  };
});

ipcMain.handle('settings:get', () => store.settings);
ipcMain.handle('settings:set', (_e, patch) => store.patchSettings(patch));
ipcMain.handle('java:list', async () => { javaList = await jre.discover(store.dirs.runtime); return javaList; });
ipcMain.handle('java:browse', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择 java.exe', properties: ['openFile'], filters: [{ name: 'java', extensions: ['exe'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('java:download', async (_e, major) => {
  const r = await remote.downloadJre(Number(major));
  javaList = await jre.discover(store.dirs.runtime);
  return r;
});

/* ---------------- 下载页：版本 / 核心 / 卸载 ---------------- */
ipcMain.handle('dl:versions', async (_e, { refresh } = {}) => {
  const m = await remote.versionList({ refresh: !!refresh });
  const installed = new Map(catalog.listInstalledVersions().map((v) => [v.mc, v]));
  return {
    cached: !!m.cached,
    note: m.note || '',
    latest: { release: (m.versions.find((v) => v.type === 'release') || {}).id, snapshot: (m.versions.find((v) => v.type === 'snapshot') || {}).id },
    versions: m.versions.map((v) => {
      const has = installed.get(v.id);
      return { id: v.id, type: v.type, releaseTime: v.releaseTime, javaMajor: has ? has.javaMajor : null, server: has ? has.server : 0, client: has ? has.client : 0, bytes: has ? has.bytes : 0 };
    }),
  };
});
ipcMain.handle('dl:versionJson', (_e, mc) => remote.versionJson(mc));
ipcMain.handle('dl:installServer', (_e, mc) => remote.downloadServer(mc).then(() => remote.downloadLibraries(mc, { client: false })));
ipcMain.handle('dl:installClient', (_e, mc) => client.install(mc, { withAssets: true }));
ipcMain.handle('dl:clientStatus', (_e, mc) => client.status(mc, { fresh: true }));
ipcMain.handle('dl:installPaper', (_e, { mc, build }) => installer.installPaper(mc, build));
ipcMain.handle('dl:installFabric', (_e, { mc, loader }) => installer.installFabric(mc, loader));
ipcMain.handle('dl:listPaper', (_e, mc) => installer.listPaper(mc));
ipcMain.handle('dl:listFabric', (_e, mc) => installer.listFabric(mc));
ipcMain.handle('dl:listForge', (_e, mc) => installer.listForge(mc));
ipcMain.handle('dl:installForge', async (_e, { id, forgeVersion, localInstaller }) => {
  const inst = store.get(id) || store.getGame(id);
  const r = await installer.installForge(inst, forgeVersion, { localInstaller });
  if (store.get(id)) store.patch(id, { core: 'forge', coreVersion: forgeVersion, installed: true });
  return r;
});
ipcMain.handle('dl:uninstall', (_e, mc) => catalog.uninstallVersion(mc));
ipcMain.handle('dl:cleanOrphans', (_e, { dryRun = true } = {}) => catalog.cleanOrphanLibs({ dryRun }));
ipcMain.handle('dl:local', () => catalog.localInfo());

/* ---------------- 检查更新 ---------------- */
ipcMain.handle('update:self', (_e, opts) => updater.checkSelf(opts || {}));
ipcMain.handle('update:mc', (_e, opts) => updater.checkMc(opts || {}));

/* ---------------- 内容搜索：Modrinth / CurseForge ---------------- */
ipcMain.handle('content:search', (_e, q) => remote.search(q));
ipcMain.handle('content:files', (_e, { source, project, fileId, mcVersion, loader, limit, offset }) => (source === 'curse' ? remote.curseFiles(project, fileId) : remote.modrinthFiles(project, mcVersion, loader, limit || 24, offset || 0)));
ipcMain.handle('content:download', (_e, { url, fileName, into, folder }) => {
  const dir = path.join(into, folder);
  return remote.downloadFileTo(url, dir, fileName);
});
ipcMain.handle('content:toInstance', async (_e, { id, kind, url, fileName }) => {
  const inst = store.get(id) || store.getGame(id);
  const base = store.get(id) ? store.instanceDir(inst) : store.gameDir(inst);
  const sub = kind === 'shader' ? 'shaderpacks' : kind === 'resourcepack' ? 'resourcepacks' : 'mods';
  const r = await remote.downloadFileTo(url, path.join(base, sub), fileName);
  return { ...r, dir: path.join(base, sub) };
});

/* ---------------- 登录 ---------------- */
ipcMain.handle('auth:list', () => auth.list());
ipcMain.handle('auth:remove', (_e, key) => auth.remove(key));
ipcMain.handle('auth:msLogin', async (_e, { clientId }) => {
  const id = (clientId || store.settings.msClientId || '').trim();
  let code = null;
  const p = auth.msDeviceLogin(id, { onCode: (c) => { code = c; if (win) win.webContents.send('auth-device-code', c); } });
  return p;
});
ipcMain.handle('auth:msRefresh', (_e, key) => auth.msRefresh(key));
ipcMain.handle('auth:ensureInjector', async () => {
  const jar = await auth.ensureInjector();
  return { jar, bytes: fs.statSync(jar).size };
});

/* ---------------- 服务器实例 ---------------- */
ipcMain.handle('instances:list', () => store.instances.map((i) => decorate(i)));
ipcMain.handle('instances:create', (_e, input) => decorate(store.createInstance(input)));
ipcMain.handle('instances:patch', (_e, { id, patch }) => decorate(store.patch(id, patch)));
ipcMain.handle('instances:remove', (_e, { id, deleteFiles }) => {
  const rt = manager.state(id);
  if (['starting', 'running', 'restarting'].includes(rt.state)) throw new Error('服务器还在运行，请先停止');
  return store.remove(id, { deleteFiles });
});
ipcMain.handle('instances:open', (_e, id) => shell.openPath(store.instanceDir(store.get(id))));
ipcMain.handle('instances:plan', (_e, id) => {
  const inst = store.get(id);
  inst.dir = store.instanceDir(inst);
  const plan = buildPlan({ instance: inst, settings: store.settings, catalog });
  const picked = pickJava(inst, plan.javaMajorWanted);
  return { core: plan.core, mainClass: plan.mainClass || `-jar ${plan.jar || ''}`, cwd: plan.cwd, cpCount: plan.cp.length, missing: plan.missing ? plan.missing.length : 0, note: plan.note, java: picked.java, javaNote: picked.note, jvm: plan.jvm };
});

// 体积遍历很慢：运行中的按 2 分钟缓存，静止的按 30 秒
const sizeCache = new Map();
function instanceSizes(inst, dir, running) {
  const hit = sizeCache.get(inst.id);
  if (hit && Date.now() - hit.at < (running ? 120000 : 30000)) return hit;
  const e = {
    at: Date.now(),
    size: fs.existsSync(dir) ? dirSizeSync(dir) : 0,
    worldSize: fs.existsSync(path.join(dir, 'world')) ? dirSizeSync(path.join(dir, 'world')) : 0,
  };
  sizeCache.set(inst.id, e);
  return e;
}

function decorate(inst) {
  const dir = store.instanceDir(inst);
  const st = manager.state(inst.id);
  const running = ['starting', 'running', 'restarting'].includes(st.state);
  const sizes = instanceSizes(inst, dir, running);
  return {
    ...inst, dir,
    exists: fs.existsSync(dir),
    size: sizes.size,
    worldSize: sizes.worldSize,
    hasEula: fs.existsSync(path.join(dir, 'eula.txt')),
    hasProperties: fs.existsSync(path.join(dir, 'server.properties')),
    state: st.state, players: st.players, uptime: st.uptime, running,
  };
}

ipcMain.handle('server:start', (_e, id) => manager.start(id));
ipcMain.handle('server:stop', (_e, { id, force }) => manager.stop(id, { force }));
ipcMain.handle('server:send', (_e, { id, line }) => manager.send(id, line));
ipcMain.handle('server:state', (_e, id) => manager.state(id));
ipcMain.handle('server:states', () => store.instances.map((i) => manager.state(i.id)));
ipcMain.handle('server:tail', (_e, { id, n = 400 }) => {
  const mem = manager.tailOf(id, n);
  if (mem.length) return mem;
  const inst = store.get(id);
  if (!inst) return [];
  const file = path.join(store.instanceDir(inst), 'mcl-console.log');
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 262144);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (size > len) lines.shift();
    return lines.slice(-n);
  } catch { return []; }
});

/* ---------------- 游戏档案 ---------------- */
function decorateGame(g) {
  const dir = store.gameDir(g);
  const st = gameManager.state(g.id);
  let saves = [];
  try {
    saves = fs.readdirSync(path.join(dir, 'saves'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => {
        const p = path.join(dir, 'saves', d.name);
        return { folder: d.name, name: d.name, at: fs.statSync(p).mtimeMs, bytes: dirSizeSync(p) };
      })
      .sort((a, b) => b.at - a.at);
  } catch { /* 还没存档 */ }
  return { ...g, imported: !!g.dir, dir, state: st.state, running: ['starting', 'running', 'restarting'].includes(st.state), uptime: st.uptime, saves, size: fs.existsSync(dir) ? dirSizeSync(dir) : 0 };
}

ipcMain.handle('games:list', () => store.games.map(decorateGame));
ipcMain.handle('games:create', (_e, input) => decorateGame(store.createGame(input)));
ipcMain.handle('games:patch', (_e, { id, patch }) => decorateGame(store.patchGame(id, patch)));
ipcMain.handle('games:remove', (_e, { id, deleteFiles }) => {
  const st = gameManager.state(id);
  if (['starting', 'running', 'restarting'].includes(st.state)) throw new Error('游戏还在运行，请先关闭');
  return store.removeGame(id, { deleteFiles });
});
ipcMain.handle('games:open', (_e, id) => shell.openPath(store.gameDir(store.getGame(id))));
ipcMain.handle('game:start', (_e, id) => gameManager.start(id));
ipcMain.handle('game:stop', (_e, id) => gameManager.stop(id, { force: true }));
ipcMain.handle('game:state', (_e, id) => gameManager.state(id));
ipcMain.handle('game:states', () => store.games.map((g) => gameManager.state(g.id)));
ipcMain.handle('game:plan', (_e, id) => {
  const g = store.getGame(id);
  const plan = client.buildPlan({ game: { ...g, dir: store.gameDir(g) }, settings: store.settings });
  const picked = pickJava(g, plan.javaMajorWanted);
  return { mainClass: plan.mainClass, cwd: plan.cwd, cpCount: plan.cp.length, java: picked.java, javaNote: picked.note, note: plan.note, identity: plan.identity, args: plan.gameArgs, jvm: plan.jvm };
});

/* ---------------- 导入已有游戏目录 ---------------- */
ipcMain.handle('games:probe', (_e, dir) => probeGameDir(dir));
ipcMain.handle('games:import', (_e, input) => {
  const p = probeGameDir(input.dir);
  const v = p.versions.find((x) => x.id === input.versionId) || p.versions[0];
  if (!v) throw new Error('这个目录里没找到任何版本（要有 versions/<版本>/<版本>.json）');
  if (!v.mc) throw new Error(`${v.id} 认不出对应的 Minecraft 版本`);
  let loader = null;
  if (v.loader && (v.loader.type === 'fabric' || v.loader.type === 'forge')) {
    loader = { type: v.loader.type, version: v.loader.version, json: v.json };
  } else if (v.loader) {
    throw new Error(`${v.loader.type} 的目录还不能直接导入启动，目前支持原版 / Fabric / Forge`);
  }
  const g = store.createGame({
    name: input.name || p.name.replace(/^\.+/, '') || '导入的游戏',
    mcVersion: v.mc,
    username: input.username,
    dir: p.dir,
    loader,
  });
  client.invalidate();
  return { game: decorateGame(g), found: p, version: v };
});

/* ---------------- 整合包（Modrinth .mrpack）---------------- */
ipcMain.handle('modpack:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择整合包文件', properties: ['openFile'],
    filters: [{ name: 'Modrinth 整合包 (.mrpack)', extensions: ['mrpack', 'zip'] }],
  });
  if (r.canceled) return null;
  return { file: r.filePaths[0], info: modpack.summarize(r.filePaths[0]) };
});
ipcMain.handle('modpack:summarize', (_e, file) => modpack.summarize(file));

async function installModpackFrom({ file, gameId, name, withAssets = true }) {
  const info = modpack.summarize(file);
  if (!info.mc) throw new Error('整合包没写明要哪个 Minecraft 版本（dependencies.minecraft）');
  if (info.loader.type === 'neoforge' || info.loader.type === 'quilt') throw new Error(`${info.loader.type} 整合包还不能自动装，目前支持原版 / Fabric / Forge`);
  let g = gameId ? store.getGame(gameId) : null;
  if (g && g.mcVersion !== info.mc) throw new Error(`「${g.name}」是 ${g.mcVersion} 的档案，这个整合包要 ${info.mc} —— 换成新建档案来装`);
  if (!g) {
    const base = (name || info.name || '整合包').trim();
    let n = base;
    for (let i = 2; store.games.some((x) => x.name === n); i++) n = `${base} ${i}`;
    g = store.createGame({ name: n, mcVersion: info.mc });
  }
  const r = await installer.installModpack({ file, game: g, withAssets });
  return { ...r, game: decorateGame(r.game) };
}

ipcMain.handle('modpack:install', (_e, opts) => installModpackFrom(opts));
// 从内容页直接装：先把 .mrpack 取到数据目录，再走同一套装包流程
ipcMain.handle('modpack:installUrl', async (_e, { url, fileName, gameId, name }) => {
  const dir = path.join(store.dirs.store, 'modpacks');
  const { file } = await remote.downloadFileTo(url, dir, fileName);
  return installModpackFrom({ file, gameId, name });
});

/* ---------------- 杂项 ---------------- */
ipcMain.handle('props:read', (_e, id) => {
  const inst = store.get(id);
  return { map: readServerProperties(store.instanceDir(inst)), raw: safeRead(path.join(store.instanceDir(inst), 'server.properties')) };
});
ipcMain.handle('props:writeRaw', (_e, { id, text }) => {
  fs.writeFileSync(path.join(store.instanceDir(store.get(id)), 'server.properties'), text, 'utf8');
  return true;
});
ipcMain.handle('ops:list', (_e, id) => readJsonSafe(path.join(store.instanceDir(id), 'ops.json'), { version: 1, users: [] }));
ipcMain.handle('ops:set', (_e, { id, users }) => {
  const file = path.join(store.instanceDir(id), 'ops.json');
  const doc = { version: 1, users: users.map((u) => ({ uuid: u.uuid || offlineUuid(u.name), name: u.name, level: u.level || 4, bypassesPlayerLimit: !!u.bypass })) };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), 'utf8');
  return doc;
});
ipcMain.handle('players:seen', (_e, id) => {
  const log = path.join(store.instanceDir(id), 'mcl-console.log');
  if (!fs.existsSync(log)) return [];
  const text = safeRead(log) || '';
  const names = new Set();
  for (const m of text.matchAll(/([A-Za-z0-9_]{1,16}) (?:joined the game|left the game)/g)) names.add(m[1]);
  return [...names];
});

ipcMain.handle('backup:create', async (_e, id) => {
  const inst = store.get(id);
  const dir = store.instanceDir(inst);
  const world = path.join(dir, 'world');
  if (!fs.existsSync(world)) throw new Error('还没有 world 目录，先启动一次服务器');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(dir, 'backups', `${sanitizeName(inst.name)}-${stamp}.zip`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const { execFile } = require('node:child_process');
  await new Promise((resolve, reject) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -LiteralPath '${world}' -DestinationPath '${out}' -Force`], (e) => (e ? reject(e) : resolve()));
  });
  return { file: out, bytes: fs.statSync(out).size };
});
ipcMain.handle('backup:list', (_e, id) => {
  const dir = path.join(store.instanceDir(id), 'backups');
  try { return fs.readdirSync(dir).map((f) => ({ file: f, bytes: fs.statSync(path.join(dir, f)).size, at: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.at - a.at); } catch { return []; }
});
ipcMain.handle('backup:openFolder', (_e, id) => shell.openPath(path.join(store.instanceDir(id), 'backups')));

ipcMain.handle('net:checkPort', (_e, port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', (e) => resolve({ free: false, reason: e.code }));
  srv.once('listening', () => { srv.close(() => resolve({ free: true })); });
  srv.listen(port, '0.0.0.0');
}));

ipcMain.handle('fs:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择目录', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('fs:pickJar', async () => {
  const r = await dialog.showOpenDialog(win, { title: '选择 jar 文件', properties: ['openFile'], filters: [{ name: 'jar', extensions: ['jar'] }] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('mods:list', (_e, { id, folder = 'mods' }) => {
  const inst = store.get(id) || store.getGame(id);
  const base = store.get(id) ? store.instanceDir(inst) : store.gameDir(inst);
  const dir = path.join(base, folder);
  try { return fs.readdirSync(dir).filter((f) => /\.(jar|zip)$/i.test(f)).map((f) => ({ file: f, bytes: fs.statSync(path.join(dir, f)).size })); } catch { return []; }
});
ipcMain.handle('mods:openFolder', (_e, { id, folder = 'mods' }) => {
  const inst = store.get(id) || store.getGame(id);
  const base = store.get(id) ? store.instanceDir(inst) : store.gameDir(inst);
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
ipcMain.handle('mods:import', async (_e, { id, folder = 'mods' }) => {
  const r = await dialog.showOpenDialog(win, { title: '选择 jar 文件（可多选）', properties: ['openFile', 'multiSelections'], filters: [{ name: 'jar', extensions: ['jar', 'zip'] }] });
  if (r.canceled) return { added: 0 };
  const inst = store.get(id) || store.getGame(id);
  const base = store.get(id) ? store.instanceDir(inst) : store.gameDir(inst);
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  let added = 0;
  for (const src of r.filePaths) {
    try { fs.copyFileSync(src, path.join(dir, path.basename(src))); added++; } catch { /* 跳过 */ }
  }
  return { added, dir };
});

ipcMain.handle('app:confirmQuit', async (_e, mode) => {
  app.forceQuit = true;
  if (mode === 'stop') { await manager.stopAll(25000); await gameManager.stopAll(25000); }
  else { manager.killAll(); gameManager.killAll(); }
  if (tray && !tray.isDestroyed()) tray.destroy();
  app.quit();
  return true;
});
ipcMain.handle('app:cancelQuit', () => true);
ipcMain.handle('app:closeChoice', (_e, { mode, remember } = {}) => {
  if (remember) store.patchSettings({ closeAction: mode === 'quit' ? 'quit' : 'tray' });
  if (mode === 'quit') {
    app.forceQuit = true;
    if (tray && !tray.isDestroyed()) tray.destroy();
    win.destroy();
    app.quit();
  } else hideToTray();
  return true;
});
ipcMain.handle('app:hideToTray', () => { hideToTray(); return true; });
ipcMain.handle('app:stopAllNow', async () => ({ servers: (await manager.stopAll(25000)).stopped, games: (await gameManager.stopAll(25000)).stopped }));
ipcMain.handle('app:killAllNow', () => manager.killAll() + gameManager.killAll());
ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));

/* ---------------- 下载管理 ---------------- */
ipcMain.handle('jobs:list', () => jobs.snapshot());
ipcMain.handle('jobs:cancel', (_e, id) => jobs.cancel(id));
ipcMain.handle('jobs:cancelAll', () => jobs.cancelAll());
ipcMain.handle('jobs:clearDone', () => jobs.clearDone());

process.on('exit', () => { try { manager && manager.killAll(); gameManager && gameManager.killAll(); } catch { /* noop */ } });

app.whenReady().then(boot).catch((e) => {
  console.error('启动器初始化失败:', e);
  dialog.showErrorBox('RCL 出错', String((e && e.stack) || e));
  app.quit();
});
app.on('window-all-closed', () => { app.quit(); });

function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJsonSafe(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function offlineUuid(name) {
  const crypto = require('node:crypto');
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
