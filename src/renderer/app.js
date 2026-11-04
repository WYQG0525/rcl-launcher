'use strict';
/* RCL 渲染进程：五个页面各自独立（启动游戏 / 开服务器 / 下载 / 模组光影 / 设置）。
   侧栏只做导航，列表归各自页面。所有后端能力走 window.mcl（见 preload）。 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const api = window.mcl;

const CORE_NAME = { vanilla: '原版', paper: 'Paper', fabric: 'Fabric', forge: 'Forge' };
const AUTH_NAME = { offline: '离线登录', microsoft: '微软正版', aai: '第三方（LittleSkin 等）' };
const LOADER_NAME = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };
const loaderTag = (g) => (g.loader && g.loader.type && g.loader.type !== 'vanilla' ? ` · ${LOADER_NAME[g.loader.type] || g.loader.type}` : '') + (g.dir && g.imported ? ' · 导入' : '');
const QUICK = ['list', 'stop', 'save-all', 'save-on', 'say ', 'whitelist add ', 'whitelist on', 'op ', 'deop ', 'gamemode survival @a', 'weather clear', 'time set day', 'kick '];
const VIEWS = ['game', 'server', 'dl', 'jobs', 'content', 'settings'];
const PAGE = 40;   // 内容搜索每页条数

const S = {
  info: null,
  settings: null,
  instances: [],
  games: [],
  sel: null,        // 选中的服务器
  selGame: null,    // 选中的游戏档案
  view: 'game',
  tab: 'console',
  gtab: 'log',
  lines: new Map(), // id -> 行缓存（服务器与档案共用一张表，id 不冲突）
  states: new Map(),
  gameStates: new Map(),
  clientStatus: {},
  versions: null,
  jobs: { label: '空闲', done: 0, total: 0, speed: 0 },
  content: { items: [], source: 'modrinth', type: 'mod', query: '', total: 0, status: '', loading: false, sig: '', needsKey: false },
  jobs: { jobs: [], active: 0, done: 0, failed: 0, speed: 0, bytes: 0, totalBytes: 0 },
  update: null,
};

/* ---------------- 小工具 ---------------- */
const MB = (n) => (n ? (n / 1048576).toFixed(n > 104857600 ? 0 : 1) + ' MB' : '0 MB');
const GB = (n) => (n ? (n / 1073741824).toFixed(2) + ' GB' : '0 GB');
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dur = (ms) => {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return (h ? h + ' 小时 ' : '') + (h || m ? m + ' 分 ' : '') + (s % 60) + ' 秒';
};

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast on ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), kind === 'bad' ? 6000 : 2800);
}
function err(e) { toast(String((e && e.message) || e), 'bad'); }

function readForm(root) {
  const out = {};
  for (const el of (root || document).querySelectorAll('[data-key]')) {
    out[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return out;
}

function modal(title, bodyHtml, okText = '确定', onMount) {
  return new Promise((resolve) => {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-ok').textContent = okText;
    $('#modal').hidden = false;
    if (onMount) onMount($('#modal-body'));
    const close = (v) => { $('#modal').hidden = true; $('#modal-ok').onclick = null; $('#modal-cancel').onclick = null; resolve(v); };
    $('#modal-ok').onclick = () => close(readForm($('#modal-body')));
    $('#modal-cancel').onclick = () => close(null);
  });
}

function formHtml(rows) {
  const init = formDefaults(rows);
  return rows.map((r) => `<div class="f${r.full ? ' full' : ''}" data-fkey="${r.key}"${r.show && !r.show(init) ? ' hidden' : ''}>${inner(r)}</div>`).join('');
}
// 只跟其它字段联动的字段（登录方式决定还要不要显示账号 / 第三方地址）：show(当前值)
const formDefaults = (rows) => { const o = {}; for (const r of rows) o[r.key] = r.value; return o; };
function bindFormShow(root, rows) {
  const tied = rows.filter((r) => r.show);
  if (!tied.length) return;
  const apply = () => {
    const cur = readForm(root);
    for (const r of tied) {
      const el = root.querySelector(`[data-fkey="${r.key}"]`);
      if (el) el.hidden = !r.show(cur);
    }
  };
  root.addEventListener('change', apply);
  apply();
}
function inner(r) {
  let ctl;
  if (r.type === 'select') ctl = `<select data-key="${r.key}">${r.options.map((o) => `<option value="${esc(o[0])}" ${String(o[0]) === String(r.value) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
  else if (r.type === 'checkbox') ctl = `<label class="chk"><input type="checkbox" data-key="${r.key}" ${r.value ? 'checked' : ''}/> ${r.checkText || '开启'}</label>`;
  else if (r.type === 'textarea') ctl = `<textarea data-key="${r.key}" rows="${r.rows || 6}" spellcheck="false" placeholder="${esc(r.ph || '')}">${esc(r.value || '')}</textarea>`;
  else ctl = `<input type="${r.type || 'text'}" data-key="${r.key}" value="${esc(r.value === null || r.value === undefined ? '' : r.value)}" placeholder="${esc(r.ph || '')}"${r.step ? ` step="${r.step}"` : ''}/>`;
  const extra = r.row ? `<div class="row">${ctl}${r.row}</div>` : ctl;
  return `<label>${esc(r.label)}</label>${extra}${r.hint ? `<small style="color:var(--fg3);font-size:11px">${esc(r.hint)}</small>` : ''}`;
}

/* ---------------- 控制台着色 ---------------- */
const ANSI = { 0: 'c0', 1: 'cf', 4: 'c4', 31: 'c4', 32: 'c2', 33: 'c6', 34: 'c1', 35: 'c5', 36: 'c3', 37: 'c7', 90: 'c8', 91: 'cc', 92: 'ca', 93: 'ce', 94: 'c9', 95: 'cd', 96: 'cb', 97: 'cf' };
function paint(raw) {
  let cls = '';
  const text = String(raw)
    .replace(/\x1b\[([0-9;]*)m/g, (_m, codes) => { const f = parseInt(codes.split(';')[0], 10); cls = ANSI[f] !== undefined ? ANSI[f] : ''; return ''; })
    .replace(/§([0-9a-fk-or])/gi, (_m, c) => { const i = parseInt(c.toLowerCase(), 16); cls = isNaN(i) ? '' : 'c' + i; return ''; });
  let html = esc(text).replace(/^(\[[^\]]+\] )(\[[^\]]*(INFO|WARN|ERROR)[^\]]*\]: )?/, (m, a, b) => `<span class="t">${a}</span>` + (b ? `<span class="${/ERROR/.test(b) ? 'err' : /WARN/.test(b) ? 'warn' : ''}">${b}</span>` : ''));
  return cls ? `<span class="${cls}">${html}</span>` : html;
}

const partial = new Map();
let consoleTimer = null;
function appendLines(id, text) {
  const arr = S.lines.get(id) || [];
  const buf = (partial.get(id) || '') + text;
  const parts = buf.split(/\r?\n/);
  partial.set(id, parts.pop());
  for (const p of parts) arr.push(p);
  if (arr.length > 2600) arr.splice(0, arr.length - 2600);
  S.lines.set(id, arr);
  if (!consoleTimer) consoleTimer = setTimeout(() => { consoleTimer = null; renderConsoles(); }, 140);
}

function renderConsoles() {
  if (S.view === 'game') renderGConsole();
  if (S.view === 'server') renderConsole();
}

function consoleHtml(id, box, colorOn, filter) {
  flushPartial(id);
  const lines = S.lines.get(id) || [];
  const view = filter ? lines.filter((l) => l.includes(filter)) : lines;
  box.innerHTML = view.length
    ? view.map((l) => `<span class="ln">${colorOn ? paint(l) : esc(l)}</span>`).join('')
    : '<span class="ln t">（还没有输出。）</span>';
  box.scrollTop = box.scrollHeight;
  return view.length;
}
function flushPartial(id) {
  const p = partial.get(id);
  if (p) { const arr = S.lines.get(id) || []; arr.push(p); partial.set(id, ''); }
}

function renderConsole() {
  const i = S.sel;
  if (!i) { $('#console').innerHTML = '<span class="ln t">（先选一个服务器。）</span>'; return; }
  const n = consoleHtml(i, $('#console'), $('#opt-color-s').checked, $('#opt-filter').value.trim());
  const st = S.states.get(i);
  $('#console-hint').textContent = (st && st.state !== 'stopped' ? `${{ starting: '启动中…', running: '运行中', restarting: '重启中' }[st.state] || st.state} · ` : '') + `${n} 行`;
}
function renderGConsole() {
  const g = S.selGame;
  if (!g) { $('#gconsole').innerHTML = '<span class="ln t">（先选一个游戏档案。）</span>'; return; }
  const n = consoleHtml(g, $('#gconsole'), $('#opt-color').checked, '');
  const st = S.gameStates.get(g);
  $('#gconsole-hint').textContent = (st && st.state === 'running' ? `运行中 · ${dur(st.uptime)} · ` : '') + `${n} 行`;
}

async function ensureTail(id) {
  if (!id || S.lines.has(id)) return;
  S.lines.set(id, []);
  try {
    const t = await api.serverTail({ id, n: 400 });
    if (t && t.length) S.lines.set(id, t);
  } catch { /* 没有日志 */ }
  renderConsoles();
}

/* ---------------- 页面切换 ---------------- */
const TITLES = {
  game: ['启动游戏', '选档案、准备客户端、进游戏。'],
  server: ['开服务器', '选服务器、点启动、看日志。'],
  dl: ['下载', '版本、核心与 Java，下什么才有什么。'],
  jobs: ['下载管理', '每个任务的进度、速度、剩余时间，可以单独取消。'],
  content: ['模组 / 光影 / 材质', '从 Modrinth 或 CurseForge 搜索并装到当前目标。'],
  settings: ['设置', '镜像源、登录凭据、Java、关闭行为。'],
};

function switchView(v) {
  S.view = v;
  for (const b of $$('#nav button')) b.classList.toggle('on', b.dataset.view === v);
  for (const s of $$('.view')) s.classList.toggle('on', s.id === 'view-' + v);
  $('#view-title').textContent = TITLES[v][0];
  $('#view-desc').textContent = TITLES[v][1];
  if (v === 'game') { renderGameList(); renderGameHero(); renderGameRes(); renderGConsole(); }
  if (v === 'server') { renderServerList(); renderHero(); renderStats(); renderConsole(); }
  if (v === 'dl') renderDl();
  if (v === 'jobs') refreshJobs();
  if (v === 'content') renderContent();
  if (v === 'settings') renderSettings();
}

/* ---------------- 游戏档案页 ---------------- */
const game = () => S.games.find((g) => g.id === S.selGame) || null;

function renderGameList() {
  const box = $('#game-list');
  box.innerHTML = S.games.map((g) => {
    const st = S.gameStates.get(g.id) || { state: 'stopped' };
    return `<div class="pcard ${g.id === S.selGame ? 'on' : ''}" data-id="${g.id}">
      <b>${esc(g.name)}</b><span><i class="dot ${st.state}"></i>${esc(g.mcVersion)} · ${esc(g.username)} · ${AUTH_NAME[g.authType || 'offline'].split('（')[0]}${loaderTag(g)}</span>
    </div>`;
  }).join('') + '<div class="pcard add" id="btn-new-game">＋ 新建游戏档案</div>';
  for (const el of box.querySelectorAll('.pcard[data-id]')) el.onclick = () => { S.selGame = el.dataset.id; renderGameList(); renderGameHero(); renderGameRes(); switchGTab(S.gtab); refreshClientStatus(game().mcVersion); };
  $('#btn-new-game').onclick = newGame;
}

function renderGameHero() {
  const g = game();
  const st = g ? (S.gameStates.get(g.id) || { state: 'stopped' }) : { state: 'stopped' };
  $('#g-name').textContent = g ? g.name : '还没有游戏档案';
  $('#g-badges').innerHTML = g ? [
    `<span class="badge acc">${esc(g.mcVersion)}</span>`,
    `<span class="badge">${esc(g.username)}</span>`,
    `<span class="badge">${AUTH_NAME[g.authType || 'offline']}</span>`,
    g.loader && g.loader.type !== 'vanilla' ? `<span class="badge acc">${LOADER_NAME[g.loader.type] || g.loader.type} ${esc(g.loader.version || '')}</span>` : '',
    g.imported ? '<span class="badge">导入的目录</span>' : '',
    `<span class="badge">${g.memoryMB || S.settings.memoryMB} MB</span>`,
    g.fullscreen ? '<span class="badge">全屏</span>' : `<span class="badge">${g.width}×${g.height}</span>`,
    `<span class="badge ${st.state === 'running' ? 'ok' : ''}">${{ starting: '启动中', running: '运行中', stopped: '未运行' }[st.state]}</span>`,
  ].join('') : '<span class="badge">点上面「＋ 新建游戏档案」</span>';
  $('#g-note').textContent = g
    ? `目录：${g.dir} · 上次退出码 ${g.lastExit === null || g.lastExit === undefined ? '—' : g.lastExit}${st.state === 'running' ? ' · 已运行 ' + dur(st.uptime) : ''}`
    : '一个档案 = 一套独立的游戏目录（存档、mods、选项互不干扰）。';
  const running = ['starting', 'running'].includes(st.state);
  const cs = S.clientStatus[g ? g.mcVersion : ''] || null;
  $('#btn-play').disabled = !g || running || !cs || !cs.complete;
  $('#btn-play').textContent = running ? '游戏运行中' : '启动游戏';
  $('#btn-play').title = g && cs && !cs.complete ? '客户端资源还没下齐' : '';
  $('#btn-prepare').disabled = !g || !!preparing;
  $('#btn-close-game').disabled = !running;
  $('#btn-game-dir').disabled = !g;
  $('#btn-game-remove').disabled = !g;
}

function renderGameRes() {
  const g = game();
  const box = $('#g-res');
  if (!g) { box.innerHTML = '<div class="empty">先建一个游戏档案</div>'; $('#g-res-hint').textContent = ''; return; }
  const cs = S.clientStatus[g.mcVersion];
  if (!cs) { box.innerHTML = '<div class="empty">选个版本后这里会显示资源情况</div>'; return; }
  if (cs.unknown) {
    box.innerHTML = `<div class="res-item todo"><i>版本信息</i><b>未下载</b><i>点「准备客户端」会自动先拉版本清单</i></div>`;
    $('#g-res-hint').textContent = `${g.mcVersion} 还没下载过，第一次要拉版本信息 + 客户端 + 库 + 资源`;
    $('#g-res-bar').style.width = '0';
    return;
  }
  const pct = cs.assets.total ? Math.round((cs.assets.have / cs.assets.total) * 100) : 0;
  const item = (label, ok, value, sub) => `<div class="res-item ${ok ? 'ok' : 'todo'}"><i>${label}</i><b>${value}</b><i>${esc(sub || '')}</i></div>`;
  box.innerHTML = [
    item('客户端 jar', cs.jarReady, cs.jarReady ? '已就绪' : '未下载', MB(cs.jarSize)),
    item('运行库', cs.libs.missing === 0, `${cs.libs.have}/${cs.libs.total}`, cs.libs.missing ? `还差 ${cs.libs.missing} 个` : '含 LWJGL 原生库'),
    item('游戏资源', cs.assets.ready, cs.assets.files ? `${pct}%` : '未下载', cs.assets.files ? `${MB(cs.assets.have)} / ${MB(cs.assets.total)} · ${cs.assets.files} 个文件` : '还没取过索引'),
    item('状态', cs.complete, cs.complete ? '可离线启动' : '需下载', cs.complete ? '之后再启动不占流量' : ''),
  ].join('');
  const todo = cs.missingBytes + Math.max(0, cs.assets.total - cs.assets.have);
  $('#g-res-hint').textContent = cs.complete
    ? `${g.mcVersion} 客户端已完整，进游戏不再需要联网`
    : `${g.mcVersion} 客户端还要下载约 ${MB(todo)}（一次性，走设置里选的镜像源）`;
  $('#g-res-bar').style.width = (cs.complete ? 100 : cs.assets.total ? Math.min(95, pct) : 0) + '%';
}

async function refreshClientStatus(mc) {
  if (!mc) return;
  try { S.clientStatus[mc] = await api.clientStatus(mc); } catch { S.clientStatus[mc] = null; }
  renderGameHero();
  renderGameRes();
}

function switchGTab(t) {
  S.gtab = t;
  for (const b of $$('#gtabs button')) b.classList.toggle('on', b.dataset.gtab === t);
  for (const p of $$('#view-game .panel')) p.classList.toggle('on', p.id === 'gtab-' + t);
  if (t === 'form') renderGameForm();
  if (t === 'saves') renderSaves();
  if (t === 'plan') renderGamePlan();
  if (t === 'log') renderGConsole();
}

function renderGameForm() {
  const g = game();
  const box = $('#gform');
  if (!g) { box.innerHTML = '<div class="empty">先建一个游戏档案</div>'; return; }
  const accounts = (S.info.accounts || []).map((a) => [`${a.type}:${a.name}`, `${AUTH_NAME[a.type] || a.type} · ${a.name}`]);
  const rows = [
    { label: '档案名（也是目录名）', key: 'name', value: g.name },
    { label: 'MC 版本', key: 'mcVersion', type: 'select', value: g.mcVersion, options: versionOptions() },
    { label: '游戏 ID', key: 'username', value: g.username, hint: '离线模式随便填；正版模式以账号名为准' },
    { label: '登录方式', key: 'authType', type: 'select', value: g.authType || 'offline', options: Object.entries(AUTH_NAME).map(([k, v]) => [k, v]) },
    { label: '已登录账号', key: 'authName', type: 'select', value: g.authName || '', options: [['', '— 不用已存账号 —'], ...accounts], hint: '在设置页「登录」里添加', show: (c) => c.authType === 'microsoft' },
    { label: '第三方服务器地址', key: 'aaiRoot', value: g.aaiRoot || '', ph: 'https://littleskin.cn/authlib', hint: 'authlib-injector 地址，登录框在游戏里弹', show: (c) => c.authType === 'aai' },
    { label: '窗口宽', key: 'width', type: 'number', value: g.width },
    { label: '窗口高', key: 'height', type: 'number', value: g.height },
    { label: '全屏', key: 'fullscreen', type: 'checkbox', value: g.fullscreen, checkText: '忽略宽高' },
    { label: '直连服务器（可选）', key: 'server', value: g.server || '', ph: 'ip:端口，进服自动连' },
    { label: '指定 Java（留空自动）', key: 'javaPath', value: g.javaPath || '', ph: (S.info.javaList[0] || {}).path || '', full: true },
    { label: '额外 JVM 参数', key: 'jvmArgs', value: g.jvmArgs || '', full: true },
    { label: '额外游戏参数', key: 'gameArgs', value: g.gameArgs || '', full: true },
  ];
  box.innerHTML = formHtml(rows) + `<div class="hint" style="padding:0 2px">内存不在这里设 —— 游戏与服务器统一用「设置」里的 <b>${S.settings.memoryMB} MB</b>。</div>
    <div class="form-actions"><button class="ghost" id="g-open">打开游戏目录</button><button class="cta" id="g-save">保存档案</button></div>`;
  bindFormShow(box, rows);
  $('#g-save').onclick = async () => {
    const v = readForm(box);
    if (!v.username) return toast('游戏 ID 不能为空', 'bad');
    const patch = { ...v, width: Number(v.width), height: Number(v.height), fullscreen: !!v.fullscreen, javaPath: v.javaPath || null };
    try {
      await api.gamesPatch({ id: g.id, patch });
      await refreshGames();
      await refreshClientStatus(patch.mcVersion);
      toast('已保存', 'ok');
    } catch (e) { err(e); }
  };
  $('#g-open').onclick = () => api.gamesOpen(g.id);
}

function renderSaves() {
  const g = game();
  const box = $('#gsaves');
  if (!g) { box.innerHTML = '<div class="empty">先建一个游戏档案</div>'; return; }
  const saves = g.saves || [];
  box.innerHTML = `<div class="card">
    <div class="res-head"><div><b>存档</b><div class="hint" style="margin-top:4px">${esc(g.dir)}\\saves · ${saves.length} 个 · 档案总体积 ${MB(g.size)}</div></div>
      <button class="ghost" id="sv-open">打开游戏目录</button></div>
    ${saves.length ? saves.map((s) => `<div class="core"><div>${esc(s.name)}<em>${esc(s.folder)} · ${MB(s.bytes)} · ${new Date(s.at).toLocaleString()}</em></div></div>`).join('') : '<div class="empty">还没有存档。进游戏创建一个世界，回来就能看到。</div>'}
  </div>`;
  $('#sv-open').onclick = () => api.gamesOpen(g.id);
}

async function renderGamePlan() {
  const g = game();
  if (!g) { $('#gplan').textContent = '先建一个游戏档案。'; return; }
  try {
    const p = await api.gamePlan(g.id);
    $('#gplan').textContent = `登录        ${p.identity.type === 'offline' ? '离线（' + p.identity.name + '）' : p.identity.type === 'microsoft' ? '微软正版（' + p.identity.name + '）' : '第三方（' + p.identity.name + '）'}\n主类        ${p.mainClass}\n工作目录    ${p.cwd}\nclasspath   ${p.cpCount} 个条目\nJava        ${p.java ? p.java.path + '（' + (p.java.raw || p.java.major) + '）' : '未找到'}\n选择依据    ${p.javaNote}\n说明        ${p.note}\n\n游戏参数：\n${p.args.join(' ')}\n\nJVM 参数：\n${p.jvm.join('\n')}`;
  } catch (e) { $('#gplan').textContent = '还不能生成启动计划：' + e.message; }
}

function versionOptions() {
  const local = (S.info.local && S.info.local.versions) || [];
  const ids = [...new Set([...local.map((v) => v.mc), '1.19.2', '1.20.1', '1.21.1', '26.3', ...((S.versions && S.versions.versions) || []).slice(0, 20).map((v) => v.id)])];
  return ids.map((id) => [id, id + (local.find((l) => l.mc === id) ? '（已下载）' : '')]);
}

async function newGame() {
  const accounts = (S.info.accounts || []).map((a) => [`${a.type}:${a.name}`, `${AUTH_NAME[a.type] || a.type} · ${a.name}`]);
  const presets = (S.info.aaiPresets || []).map((p) => [p.root, p.name]);
  const rows = [
    { label: '档案名', key: 'name', value: `玩家 ${S.games.length + 1}` },
    { label: 'MC 版本', key: 'mcVersion', type: 'select', value: '1.21.1', options: versionOptions() },
    { label: '登录方式', key: 'authType', type: 'select', value: 'offline', options: Object.entries(AUTH_NAME).map(([k, x]) => [k, x]) },
    { label: '游戏 ID', key: 'username', value: 'Player' + (S.games.length + 1), hint: '离线模式随便填；正版/第三方以选中账号为准' },
    { label: '用哪个已登录账号', key: 'authName', type: 'select', value: '', options: [['', accounts.length ? '— 先不用，稍后在档案设置里选 —' : '— 还没有登录过账号 —'], ...accounts], hint: '在设置页「登录账号」里登录微软', show: (c) => c.authType === 'microsoft' },
    { label: '第三方服务器地址', key: 'aaiRoot', type: 'select', value: 'https://littleskin.cn/authlib', options: [['', '— 不用第三方 —'], ...presets, ['custom', '自定义（在档案设置里填）']], show: (c) => c.authType === 'aai' },
  ];
  const v = await modal('新建游戏档案', formHtml(rows), '创建', (box) => bindFormShow(box, rows));
  if (!v || !v.name) return;
  try {
    const g = await api.gamesCreate({
      name: v.name, mcVersion: v.mcVersion, username: v.username,
      authType: v.authType,
      authName: v.authType === 'microsoft' ? (v.authName || '').split(':')[1] || '' : '',
      aaiRoot: v.authType === 'aai' && v.aaiRoot !== 'custom' ? v.aaiRoot : '',
    });
    S.selGame = g.id;
    await refreshGames();
    await refreshClientStatus(g.mcVersion);
    switchGTab('form');
    const st = S.clientStatus[g.mcVersion];
    const who = { offline: '离线登录', microsoft: '微软正版', aai: '第三方登录' }[g.authType] || g.authType;
    if (g.authType === 'microsoft' && !g.authName) toast(`档案已建好（登录方式：${who}）—— 还没选微软账号，进游戏会失败，去「档案设置」里选`, 'bad');
    else toast(`${st && st.complete ? `「${g.name}」已就绪（${who}），可以直接进游戏` : `「${g.name}」已建好（${who}）；${g.mcVersion} 客户端还要下载，点「准备客户端」`}`, 'ok');
  } catch (e) { err(e); }
}

/* ---------------- 导入已有游戏目录 ---------------- */
async function importGame() {
  const dir = await api.pickFolder();
  if (!dir) return;
  let p;
  try { p = await api.gamesProbe(dir); } catch (e) { return err(e); }
  if (!p.versions.length) return toast('这个目录里没找到任何 Minecraft 版本（要有 versions/<版本>/<版本>.json）', 'bad');
  const opts = p.versions.map((v) => [v.id, `${v.id}　→ ${v.mc || '?'} · ${v.loader ? (LOADER_NAME[v.loader.type] || v.loader.type) + ' ' + (v.loader.version || '') : '原版'}`]);
  const v = await modal('导入已有游戏', formHtml([
    { label: '游戏目录', key: 'dir', value: p.dir, full: true, hint: `存档 ${p.saves} 个 · 模组 ${p.mods} 个 · 材质包 ${p.resourcepacks} 个 · 光影 ${p.shaderpacks} 个 —— 只在原地使用，不复制也不移动任何文件` },
    { label: '导入哪个版本', key: 'versionId', type: 'select', value: opts[0][0], options: opts },
    { label: '档案名', key: 'name', value: p.name.replace(/^\.+/, '') || '导入的游戏' },
    { label: '游戏 ID', key: 'username', value: (S.games[0] && S.games[0].username) || 'Player', hint: '离线模式随便填，登录方式之后在档案设置里改' },
  ]), '导入');
  if (!v) return;
  try {
    const r = await api.gamesImport(v);
    S.selGame = r.game.id;
    await refreshGames();
    await refreshClientStatus(r.game.mcVersion);
    renderGameList();
    renderGameHero();
    renderGameRes();
    switchGTab('form');
    toast(`已导入「${r.game.name}」（${r.version.id}）—— 用的是原来那个目录，没复制文件`, 'ok');
  } catch (e) { err(e); }
}

/* ---------------- 装整合包（.mrpack）---------------- */
async function pickModpackFile(item, btn) {
  btn.textContent = '取列表中…';
  let files = [];
  try {
    const vs = await api.contentFiles({ source: item.source, project: item.id });
    files = vs.flatMap((v) => (v.files || []).filter((f) => /\.(mrpack|zip)$/i.test(f.name || '')).map((f) => ({
      label: `${v.mc || v.version} · ${v.loader || ''} · ${f.name} · ${MB(f.size || 0)}`, url: f.url, name: f.name,
    })));
  } catch (e) { btn.textContent = '安装'; return err(e); }
  btn.textContent = '安装';
  if (!files.length) return toast('这个项目里没有 .mrpack 文件（可能只发了 CurseForge 版）', 'bad');
  const v = await modal(`安装整合包：${item.name}`, formHtml([
    { label: '选文件', key: 'file', type: 'select', value: '', options: files.map((f, i) => [String(i), f.label]), full: true },
    { label: '装到', key: 'target', type: 'select', value: '', options: [['', '— 新建一个档案（名字和版本跟着包走）—'], ...S.games.map((g) => [g.id, `${g.name}（${g.mcVersion}）`])], full: true, hint: '选已有档案时，档案版本必须和整合包一致，否则会报错' },
    { label: '原版客户端', key: 'withAssets', type: 'checkbox', value: true, checkText: '顺带把该版本的原版文件与资源下齐（首次约 500MB+）', full: true },
  ]), '开始安装');
  if (!v) return;
  const f = files[Number(v.file)];
  if (!f) return toast('没选文件', 'bad');
  btn.disabled = true;
  btn.textContent = '安装中…';
  try {
    const r = await api.modpackInstallUrl({ url: f.url, fileName: f.name, gameId: v.target || null, withAssets: !!v.withAssets });
    S.selGame = r.game.id;
    await refreshGames();
    await refreshClientStatus(r.mc);
    toast(r.note, 'ok');
  } catch (e) { err(e); } finally { btn.disabled = false; btn.textContent = '安装'; }
}

let preparing = false;

async function doPrepare() {
  const g = game();
  if (!g || preparing) return;
  preparing = true;
  $('#btn-prepare').textContent = '准备中…';
  $('#btn-prepare').disabled = true;
  switchView('dl');
  try {
    const r = await api.dlInstallClient(g.mcVersion);
    S.clientStatus = {};
    await refreshLocal();
    switchView('game');
    await refreshClientStatus(g.mcVersion);
    toast(r.ready ? `${g.mcVersion} 客户端已就绪` : `下载完成但还差文件：${r.assets.note}`, r.ready ? 'ok' : 'bad');
  } catch (e) {
    err(e);
    switchView('game');
  } finally {
    preparing = false;
    const b = $('#btn-prepare');
    if (b) { b.textContent = '准备客户端'; b.disabled = !game(); }
  }
}

async function doPlay() {
  const g = game();
  if (!g) return;
  const cs = S.clientStatus[g.mcVersion];
  if (!cs || !cs.complete) { toast('客户端还没准备齐，先点「准备客户端」', 'bad'); return; }
  $('#btn-play').disabled = true;
  S.lines.set(g.id, []);
  switchGTab('log');
  try {
    const r = await api.gameStart(g.id);
    toast(`「${g.name}」启动中${r.note ? ' · ' + r.note : ''}`, 'ok');
  } catch (e) {
    err(e);
    appendLines(g.id, `[启动器] 启动失败：${e.message}\n`);
    renderGConsole();
  }
  renderGameHero();
}

async function doCloseGame() {
  const g = game();
  if (!g) return;
  try { const r = await api.gameStop(g.id); toast(r.note || '已关闭', 'ok'); } catch (e) { err(e); }
  refreshGames();
}

async function removeGame() {
  const g = game();
  if (!g) return;
  const st = S.gameStates.get(g.id) || { state: 'stopped' };
  if (['starting', 'running'].includes(st.state)) return toast('游戏还在运行，先关闭', 'bad');
  const v = await modal(`删除档案「${g.name}」`, formHtml([
    { label: '连同游戏目录（存档 / mods / 截图）一起删除？', key: 'deleteFiles', type: 'checkbox', value: false, checkText: '勾选后不可恢复' },
  ]), '删除');
  if (!v) return;
  try {
    await api.gamesRemove({ id: g.id, deleteFiles: !!v.deleteFiles });
    S.selGame = null;
    S.lines.delete(g.id);
    S.gameStates.delete(g.id);
    await refreshGames();
    toast('已删除', 'ok');
  } catch (e) { err(e); }
}

async function refreshGames() {
  S.games = await api.gamesList();
  if (!S.selGame && S.games.length) S.selGame = S.games[0].id;
  renderGameList();
  renderGameHero();
  if (S.gtab === 'saves') renderSaves();
}

/* ---------------- 服务器页 ---------------- */
const inst = () => S.instances.find((i) => i.id === S.sel) || null;

function renderServerList() {
  const box = $('#server-list');
  box.innerHTML = S.instances.map((i) => {
    const st = S.states.get(i.id) || { state: 'stopped', players: [] };
    return `<div class="pcard ${i.id === S.sel ? 'on' : ''}" data-id="${i.id}">
      <b>${esc(i.name)}</b>
      <span><i class="dot ${st.state}"></i>${esc(i.mcVersion)} · ${CORE_NAME[i.core] || i.core}${st.players && st.players.length ? ` · ${st.players.length} 人` : ''}</span>
    </div>`;
  }).join('') + '<div class="pcard add" id="btn-new-server">＋ 新建服务器</div>';
  for (const el of box.querySelectorAll('.pcard[data-id]')) el.onclick = () => { S.sel = el.dataset.id; ensureTail(S.sel); renderServerList(); renderHero(); renderStats(); switchTab(S.tab); };
  $('#btn-new-server').onclick = newServer;
}

function renderHero() {
  const i = inst();
  const st = i ? (S.states.get(i.id) || { state: 'stopped' }) : { state: 'stopped' };
  $('#hero-name').textContent = i ? i.name : '还没有服务器';
  $('#hero-badges').innerHTML = i ? [
    `<span class="badge acc">${esc(i.mcVersion)}</span>`,
    `<span class="badge">${CORE_NAME[i.core] || i.core}${i.coreVersion ? ' ' + esc(i.coreVersion) : ''}</span>`,
    `<span class="badge">端口 ${i.port}</span>`,
    `<span class="badge">${i.memoryMB || S.settings.memoryMB} MB</span>`,
    i.onlineMode ? '<span class="badge">正版验证</span>' : '<span class="badge">离线模式</span>',
    `<span class="badge ${st.state === 'running' ? 'ok' : ''}">${{ starting: '启动中', running: '运行中', restarting: '自动重启', stopped: '已停止' }[st.state]}</span>`,
  ].join('') : '<span class="badge">点上面「＋ 新建服务器」</span>';
  $('#hero-note').textContent = i
    ? `目录：${i.dir} · 上次退出码 ${i.lastExit === null || i.lastExit === undefined ? '—' : i.lastExit}`
    : '一个实例 = 一个独立服务端目录（世界、配置、mods 互不干扰，可同时开多个）。';
  const running = ['starting', 'running', 'restarting'].includes(st.state);
  $('#btn-start').disabled = !i || running;
  $('#btn-start').textContent = running ? '服务器运行中' : '启动服务器';
  $('#btn-stop').disabled = !i || !running;
  $('#btn-kill').disabled = !i || !running;
  $('#btn-dir').disabled = !i;
  $('#btn-remove').disabled = !i;
  $('#cmd').disabled = !running;
  $('#btn-send').disabled = !running;
  $('#tabs').style.display = i ? '' : 'none';
}

function renderStats() {
  const i = inst();
  const st = i ? (S.states.get(i.id) || { state: 'stopped', players: [], uptime: 0 }) : { state: 'stopped', players: [], uptime: 0 };
  const cards = [
    ['状态', { starting: '启动中', running: '运行中', restarting: '自动重启', stopped: '已停止' }[st.state]],
    ['运行时长', dur(st.uptime)],
    ['实例体积', i ? MB(i.size) : '—'],
    ['世界体积', i ? MB(i.worldSize) : '—'],
    ['在线玩家', String(st.players ? st.players.length : 0)],
  ];
  $('#stats').innerHTML = cards.map(([k, v]) => `<div class="stat"><i>${k}</i><b>${esc(v)}</b></div>`).join('')
    + (st.players && st.players.length ? `<div class="stat"><i>玩家列表</i><div class="chips">${st.players.map((p) => `<span class="chip">${esc(p)}</span>`).join('')}</div></div>` : '');
}

function switchTab(t) {
  S.tab = t;
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === t);
  for (const p of $$('#view-server .panel')) p.classList.toggle('on', p.id === 'tab-' + t);
  if (t === 'props') renderPropsForm();
  if (t === 'mods') renderMods();
  if (t === 'ops') renderOps();
  if (t === 'backup') renderBackup();
  if (t === 'plan') renderPlan();
  if (t === 'console') renderConsole();
}

function updateRunningPill() {
  const n = [...S.states.values()].filter((s) => ['starting', 'running', 'restarting'].includes(s.state)).length
    + [...S.gameStates.values()].filter((s) => ['starting', 'running'].includes(s.state)).length;
  const pill = $('#pill-running');
  pill.textContent = n ? `${n} 个程序运行中` : '空闲';
  pill.className = 'pill' + (n ? ' ok' : '');
}

async function refreshInstances() {
  S.instances = await api.instancesList();
  if (!S.sel && S.instances.length) S.sel = S.instances[0].id;
  if (S.sel) ensureTail(S.sel);
  renderServerList();
  renderHero();
  renderStats();
  if (S.tab === 'props') renderPropsForm();
  if (S.tab === 'mods') renderMods();
  if (S.tab === 'ops') renderOps();
  if (S.tab === 'backup') renderBackup();
  if (S.tab === 'plan') renderPlan();
}

async function newServer() {
  const used = S.instances.map((i) => i.port);
  let port = 25565;
  while (used.includes(port)) port++;
  const v = await modal('新建服务器', formHtml([
    { label: '服务器名字', key: 'name', value: `我的服务器 ${S.instances.length + 1}`, hint: '会变成目录名' },
    { label: 'MC 版本', key: 'mcVersion', type: 'select', value: '1.21.1', options: versionOptions() },
    { label: '核心', key: 'core', type: 'select', value: 'vanilla', options: Object.entries(CORE_NAME).map(([k, n]) => [k, n]) },
    { label: '端口', key: 'port', type: 'number', value: port },
    { label: '内存 MB', key: 'memoryMB', type: 'number', value: S.settings.memoryMB },
    { label: '在线验证', key: 'onlineMode', type: 'checkbox', value: true, checkText: '正版验证（局域网朋友联机可关掉）' },
  ]), '创建');
  if (!v || !v.name) return;
  try {
    const i = await api.instancesCreate({ name: v.name, mcVersion: v.mcVersion, core: v.core, port: Number(v.port) });
    await api.instancesPatch({ id: i.id, patch: { memoryMB: Number(v.memoryMB), onlineMode: !!v.onlineMode } });
    S.sel = i.id;
    await refreshInstances();
    switchView('server');
    switchTab('props');
    const local = ((S.info.local || {}).versions || []).find((l) => l.mc === v.mcVersion);
    toast(local && local.server ? `已创建「${i.name}」，${v.mcVersion} 服务端本地已有，可直接启动` : `已创建「${i.name}」；${v.mcVersion} 服务端还没下载，去「下载」页取`, 'ok');
    const free = await api.checkPort(Number(v.port));
    if (!free.free) toast(`端口 ${v.port} 已被占用（${free.reason}），记得改`, 'bad');
  } catch (e) { err(e); }
}

async function doStart() {
  const i = inst();
  if (!i) return;
  $('#btn-start').disabled = true;
  try {
    const r = await api.serverStart(i.id);
    toast(`「${i.name}」开始启动${r.note ? ' · ' + r.note : ''}`, 'ok');
    S.lines.set(i.id, []);
    switchTab('console');
  } catch (e) {
    err(e);
    appendLines(i.id, `[启动器] 启动失败：${e.message}\n`);
    renderConsole();
    if (/还没下载/.test(e.message)) switchView('dl');
  }
  renderHero();
}

async function doStop(force) {
  const i = inst();
  if (!i) return;
  $('#btn-stop').disabled = true;
  try { const r = await api.serverStop({ id: i.id, force: !!force }); toast(r.note || '已停止', 'ok'); } catch (e) { err(e); }
  refreshInstances();
}

async function doSend() {
  const i = inst();
  const text = $('#cmd').value.trim();
  if (!i || !text) return;
  try { await api.serverSend({ id: i.id, line: text }); appendLines(i.id, `> ${text}\n`); $('#cmd').value = ''; } catch (e) { err(e); }
}

async function removeInstance() {
  const i = inst();
  if (!i) return;
  const st = S.states.get(i.id) || { state: 'stopped' };
  if (['starting', 'running', 'restarting'].includes(st.state)) return toast('服务器还在运行，先停止', 'bad');
  const v = await modal(`删除「${i.name}」`, formHtml([
    { label: '连同实例目录一起删除？', key: 'deleteFiles', type: 'checkbox', value: false, checkText: '勾选会删掉世界、日志与配置（不可恢复）' },
  ]), '删除');
  if (!v) return;
  try {
    await api.instancesRemove({ id: i.id, deleteFiles: !!v.deleteFiles });
    S.sel = null;
    S.lines.delete(i.id);
    S.states.delete(i.id);
    await refreshInstances();
    toast(v.deleteFiles ? '已删除实例与文件' : '已从列表移除（文件保留）', 'ok');
  } catch (e) { err(e); }
}

/* ---------------- 服务器各标签 ---------------- */
async function renderPropsForm() {
  const i = inst();
  const box = $('#props-form');
  if (!i) { box.innerHTML = '<div class="empty">先创建一个服务器</div>'; return; }
  const props = await api.propsRead(i.id);
  box.innerHTML = formHtml([
    { label: '服务器名字', key: 'name', value: i.name },
    { label: 'MC 版本', key: 'mcVersion', type: 'select', value: i.mcVersion, options: versionOptions() },
    { label: '核心', key: 'core', type: 'select', value: i.core, options: Object.entries(CORE_NAME).map(([k, v]) => [k, v]) },
    { label: '核心版本', key: 'coreVersion', value: i.coreVersion || '', ph: '留空用已下载的最新构建' },
    { label: '端口', key: 'port', type: 'number', value: i.port },
    { label: '最大玩家数', key: 'maxPlayers', type: 'number', value: i.maxPlayers },
    { label: 'MOTD（服务器介绍）', key: 'motd', value: i.motd },
    { label: '世界名', key: 'levelName', value: i.levelName },
    { label: '难度', key: 'difficulty', type: 'select', value: i.difficulty, options: [['peaceful', 'peaceful'], ['easy', 'easy'], ['normal', 'normal'], ['hard', 'hard']] },
    { label: '默认游戏模式', key: 'gamemode', type: 'select', value: i.gamemode, options: [['survival', 'survival'], ['creative', 'creative'], ['adventure', 'adventure'], ['spectator', 'spectator']] },
    { label: '视距（区块）', key: 'viewDistance', type: 'number', value: i.viewDistance },
    { label: '在线验证', key: 'onlineMode', type: 'checkbox', value: i.onlineMode, checkText: '需要正版账号才能进服' },
    { label: '内存 MB', key: 'memoryMB', type: 'number', value: i.memoryMB || S.settings.memoryMB },
    { label: 'JVM 参数预设', key: 'jvmPreset', type: 'select', value: i.jvmPreset || S.settings.jvmPreset, options: [['aikar', 'Aikar 流式 GC（推荐）'], ['paper', 'Paper 官方推荐参数'], ['vanilla', '官方默认 G1'], ['none', '不加额外参数']] },
    { label: 'Java 大版本（留空自动）', key: 'javaMajor', type: 'number', value: i.javaMajor || '', ph: '17 / 21 / 25' },
    { label: '崩溃自动重启', key: 'autoRestart', type: 'select', value: i.autoRestart === null ? '' : String(i.autoRestart), options: [['', '跟随全局设置'], ['true', '开启'], ['false', '关闭']] },
    { label: '额外 JVM 参数', key: 'jvmArgs', value: i.jvmArgs, full: true },
    { label: '游戏启动参数', key: 'gameArgs', value: i.gameArgs || '', full: true },
  ]) + `<div class="f full"><label>server.properties 原文（高级用法；界面里那几项仍会被覆盖，其余键保留）</label>
      <textarea id="props-raw" rows="8" spellcheck="false">${esc(props.raw || '（还没有 server.properties，启动后自动生成）')}</textarea>
      <div class="row" style="display:flex;gap:8px;margin-top:6px"><button class="ghost sm" id="props-raw-reload">重新读取</button><button class="ghost sm" id="props-raw-save">只保存原文</button></div></div>
    <div class="form-actions"><button class="ghost" id="props-open">打开实例目录</button><button class="cta" id="props-save">保存设置</button></div>`;
  $('#props-save').onclick = async () => {
    const v = readForm(box);
    const patch = { ...v, autoRestart: v.autoRestart === '' ? null : v.autoRestart === 'true', onlineMode: !!v.onlineMode };
    ['memoryMB', 'port', 'maxPlayers', 'viewDistance', 'javaMajor'].forEach((k) => { if (patch[k] === '' || patch[k] === null) delete patch[k]; else patch[k] = Number(patch[k]); });
    try { await api.instancesPatch({ id: i.id, patch }); await refreshInstances(); toast('已保存', 'ok'); } catch (e) { err(e); }
  };
  $('#props-open').onclick = () => api.instancesOpen(i.id);
  $('#props-raw-save').onclick = async () => {
    try { await api.propsWriteRaw({ id: i.id, text: $('#props-raw').value }); toast('server.properties 已写入', 'ok'); } catch (e) { err(e); }
  };
  $('#props-raw-reload').onclick = async () => { const p = await api.propsRead(i.id); $('#props-raw').value = p.raw || ''; toast('已重新读取'); };
}

async function renderMods() {
  const i = inst();
  const box = $('#mods-box');
  if (!i) { box.innerHTML = '<div class="empty">先创建一个服务器</div>'; return; }
  const mods = await api.modsList({ id: i.id, folder: 'mods' });
  box.innerHTML = `<div class="card">
    <div class="res-head"><div><b>mods 目录</b><div class="hint" style="margin-top:4px">${CORE_NAME[i.core] || i.core} 核心 · ${mods.length} 个 jar${i.core === 'vanilla' ? ' · 原版核心不加载模组，请改用 Fabric/Forge/Paper+插件' : ''}</div></div>
      <div style="display:flex;gap:8px"><button class="ghost" id="mods-open">打开目录</button><button class="cta sm" id="mods-import">导入 jar</button><button class="ghost sm" id="mods-browse">去「模组光影」找</button></div></div>
    ${mods.length ? mods.map((m) => `<div class="core"><div>${esc(m.file)}<em>${MB(m.bytes)}</em></div></div>`).join('') : '<div class="empty">还没有模组</div>'}
  </div>`;
  $('#mods-open').onclick = () => api.modsOpen({ id: i.id, folder: 'mods' });
  $('#mods-import').onclick = async () => { const r = await api.modsImport({ id: i.id, folder: 'mods' }); if (r && r.added) { toast(`已导入 ${r.added} 个`, 'ok'); renderMods(); } };
  $('#mods-browse').onclick = () => switchView('content');
}

async function renderOps() {
  const i = inst();
  const box = $('#ops-box');
  if (!i) { box.innerHTML = '<div class="empty">先创建一个服务器</div>'; return; }
  const ops = await api.opsList(i.id);
  const seen = await api.playersSeen(i.id);
  box.innerHTML = `<div class="card">
    <b>OP 列表</b>
    <div class="hint" style="margin:4px 0 10px">离线模式下 UUID 由玩家名推导（OfflinePlayer）；正版服建议直接游戏内 /op。</div>
    ${(ops.users || []).length ? ops.users.map((u) => `<div class="core"><div>${esc(u.name)}<em>${esc(u.uuid)}</em></div><button class="ghost sm" data-rm="${esc(u.name)}">移除</button></div>`).join('') : '<div class="empty">还没有 OP</div>'}
    <div class="c-bar" style="margin-top:12px">
      <input class="mini" id="op-name" placeholder="玩家名" list="seen-list" />
      <datalist id="seen-list">${seen.map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>
      <button class="cta sm" id="op-add">加为 OP</button>
      <span class="spacer"></span>
      <span class="hint">日志里出现过的玩家：${seen.length ? seen.map((n) => `<span class="chip">${esc(n)}</span>`).join(' ') : '无'}</span>
    </div>
  </div>`;
  const users = (ops.users || []).slice();
  const save = async () => { await api.opsSet({ id: i.id, users }); renderOps(); };
  $('#op-add').onclick = () => {
    const n = $('#op-name').value.trim();
    if (!n) return toast('先填玩家名', 'bad');
    if (users.some((u) => u.name === n)) return toast('已经是 OP 了');
    users.push({ name: n, level: 4 });
    save();
  };
  for (const b of box.querySelectorAll('[data-rm]')) b.onclick = () => { const idx = users.findIndex((u) => u.name === b.dataset.rm); if (idx >= 0) users.splice(idx, 1); save(); };
}

async function renderBackup() {
  const i = inst();
  const box = $('#backup-box');
  if (!i) { box.innerHTML = '<div class="empty">先创建一个服务器</div>'; return; }
  const list = await api.backupList(i.id);
  box.innerHTML = `<div class="card">
    <div class="res-head"><div><b>世界备份</b><div class="hint" style="margin-top:4px">把 world 目录压成 zip 存进实例的 backups</div></div>
      <div style="display:flex;gap:8px"><button class="ghost" id="bk-open">打开备份目录</button><button class="cta sm" id="bk-run">立即备份</button></div></div>
    ${list.length ? list.map((b) => `<div class="core"><div>${esc(b.file)}<em>${MB(b.bytes)} · ${new Date(b.at).toLocaleString()}</em></div></div>`).join('') : '<div class="empty">还没有备份</div>'}
  </div>`;
  $('#bk-open').onclick = () => api.backupOpenFolder(i.id);
  $('#bk-run').onclick = async () => {
    const st = S.states.get(i.id);
    if (st && st.state === 'running') toast('服务器在跑，建议先 stop 再备份（区块可能还在内存里）');
    toast('压缩中…');
    try { const r = await api.backupCreate(i.id); toast('备份完成 ' + MB(r.bytes), 'ok'); renderBackup(); } catch (e) { err(e); }
  };
}

async function renderPlan() {
  const i = inst();
  if (!i) { $('#plan-box').textContent = '先创建一个服务器。'; return; }
  try {
    const p = await api.instancesPlan(i.id);
    $('#plan-box').textContent = `核心        ${p.core}\n主类/入口   ${p.mainClass}\n工作目录    ${p.cwd}\nclasspath   ${p.cpCount} 个条目\n缺失依赖    ${p.missing}\nJava        ${p.java ? p.java.path + '（' + (p.java.raw || p.java.major) + '）' : '未找到'}\n选择依据    ${p.javaNote}\n说明        ${p.note}\n\nJVM 参数：\n${p.jvm.join('\n')}`;
  } catch (e) { $('#plan-box').textContent = '生成失败：' + e.message; }
}

/* ---------------- 下载页 ---------------- */
async function refreshLocal() {
  try { S.info.local = await api.dlLocal(); } catch { /* 忽略 */ }
  const b = (S.info.local && S.info.local.bytes) || {};
  const total = Object.values(b).reduce((x, y) => x + y, 0);
  $('#foot-space').textContent = `已下载: ${GB(total)}`;
  $('#pill-offline').textContent = `${((S.info.local || {}).versions || []).length} 个版本 · Java ${(S.info.local || {}).jres || []}`;
  $('#pill-offline').className = 'pill' + (((S.info.local || {}).versions || []).length ? ' ok' : '');
}

/* ---------------- 下载页：整合包（不用填版本，点一条看它全部版本）---------------- */
const MP = { q: '', items: [], total: 0, loading: false, open: '', versions: [], vloading: false, status: '', asked: false };
const VPAGE = 25;
const MP_HINT = '搜 Modrinth 的整合包，不用填版本 —— 点一条就列出它的全部版本，选一个直接装成新档案';

async function mpSearch(append = false) {
  if (MP.loading) return;
  MP.loading = true;
  MP.status = '';
  if (!append) { MP.items = []; MP.open = ''; MP.versions = []; }
  paintMp();
  try {
    const r = await api.contentSearch({ source: 'modrinth', type: 'modpack', query: MP.q, limit: PAGE, offset: append ? MP.items.length : 0 });
    MP.items = append ? [...MP.items, ...(r.items || [])] : (r.items || []);
    MP.total = r.total || MP.items.length;
    MP.status = r.error || '';
  } catch (e) {
    MP.status = e.message;
  } finally {
    MP.loading = false;
    MP.asked = true;
    paintMp();
  }
}

function shortMc(s) {
  const a = String(s || '').split(',').filter(Boolean);
  return a.length > 3 ? a.slice(0, 3).join(',') + ` +${a.length - 3}` : a.join(',');
}

async function mpToggle(item) {
  if (MP.open === item.id) { MP.open = ''; MP.versions = []; return paintMp(); }
  MP.open = item.id;
  MP.versions = [];
  MP.vEnd = false;
  MP.vloading = true;
  paintMp();
  try {
    MP.versions = await api.contentFiles({ source: 'modrinth', project: item.id, limit: VPAGE, offset: 0 });
  } catch (e) {
    MP.status = e.message;
  }
  MP.vloading = false;
  paintMp();
}

async function mpMoreVersions() {
  if (MP.vloading) return;
  MP.vloading = true;
  paintMp();
  try {
    const more = await api.contentFiles({ source: 'modrinth', project: MP.open, limit: VPAGE, offset: MP.versions.length });
    MP.versions = [...MP.versions, ...more];
    MP.vEnd = more.length < VPAGE;
  } catch (e) {
    MP.status = e.message;
  } finally {
    MP.vloading = false;
    paintMp();
  }
}

async function mpInstall(idx, btn) {
  const v = MP.versions[idx];
  const f = v && (v.files || []).find((x) => /\.(mrpack|zip)$/i.test(x.name || ''));
  if (!f) return toast('这个版本没有 .mrpack 文件', 'bad');
  btn.disabled = true;
  btn.textContent = '安装中…';
  try {
    const r = await api.modpackInstallUrl({ url: f.url, fileName: f.name });
    S.selGame = r.game.id;
    await refreshGames();
    await refreshLocal();
    await refreshClientStatus(r.mc);
    switchView('game');
    toast(`${r.note} —— 已建好档案「${r.game.name}」`, 'ok');
  } catch (e) {
    err(e);
  } finally {
    btn.disabled = false;
    btn.textContent = '装这个';
  }
}

function paintMp() {
  const box = $('#mp-list');
  if (!box) return;
  $('#mp-count').textContent = MP.loading ? '搜索中…' : (MP.items.length ? `${MP.items.length} / ${MP.total} 个整合包` : (MP.asked ? '没搜到' : '还没搜'));
  $('#mp-hint').textContent = MP.status || MP_HINT;
  if (!MP.items.length) {
    box.innerHTML = MP.loading ? '<div class="card note">搜索中…</div>' : (MP.asked ? '<div class="empty">换个关键字试试。</div>' : '<div class="empty">点「搜索」先看热门的，或输入关键字。</div>');
    return;
  }
  box.innerHTML = MP.items.map((p, i) => {
    const open = p.id === MP.open;
    const rows = MP.versions.map((v, vi) => `<div class="core">
          <div>${esc(v.name)}<em>${esc(shortMc(v.mc))} · ${esc(v.loader)} · ${MB(((v.files || [])[0] || {}).size || 0)} · ${String(v.date || '').slice(0, 10)}</em></div>
          <div><button class="cta sm" data-mp-install="${vi}">装这个</button></div>
        </div>`).join('');
    const inner = !MP.versions.length
      ? (MP.vloading ? '<div class="core"><div>取版本列表中…<em>正在问 Modrinth</em></div></div>' : '<div class="core"><div>这个包没有可安装的文件<em>可能只发了 CurseForge 版</em></div></div>')
      : rows + (MP.vloading ? '<div class="core"><div>加载中…<em>更多版本</em></div></div>' : (MP.vEnd ? '<div class="core"><div>到底了<em>共 ' + MP.versions.length + ' 个版本</em></div></div>' : '<div class="card"><button class="ghost" id="mp-vmore">加载更多版本（已列 ' + MP.versions.length + ' 个）</button></div>'));
    return `<div class="item">
      <img src="${esc(p.icon || '')}" alt="" />
      <div class="im-b">
        <b>${esc(p.name)}</b> <em>整合包</em>
        <p>${esc(p.desc || '')}</p>
        <em>${esc(p.author || '')} · 下载 ${p.downloads ? Number(p.downloads).toLocaleString() : '?'}</em>
      </div>
      <div class="ia"><button class="ghost sm" data-mp-open="${i}">${open ? '收起' : '看版本'}</button></div>
    </div>${open ? `<div class="mp-ver">${inner}</div>` : ''}`;
  }).join('') + (MP.items.length < MP.total ? '<div class="card"><button class="ghost" id="mp-more">加载更多</button></div>' : '');
  for (const b of box.querySelectorAll('[data-mp-open]')) b.onclick = () => mpToggle(MP.items[Number(b.dataset.mpOpen)]);
  for (const b of box.querySelectorAll('[data-mp-install]')) b.onclick = () => mpInstall(Number(b.dataset.mpInstall), b);
  const more = box.querySelector('#mp-more');
  if (more) more.onclick = () => mpSearch(true);
  const vmore = box.querySelector('#mp-vmore');
  if (vmore) vmore.onclick = () => mpMoreVersions();
  for (const img of box.querySelectorAll('.item img')) guardImg(img);
}

async function renderDl() {
  await refreshLocal();
  renderDlLocal();
  renderDlJava();
  renderDlList();
  if (!S.versions) {
    $('#dl-pick-hint').textContent = '正在拉版本清单…';
    renderDlList();
    try {
      S.versions = await api.dlVersions({});
      $('#dl-pick-hint').textContent = S.versions.cached ? '用的是本地缓存清单（联网后可刷新）' : `清单已更新，共 ${S.versions.versions.length} 个条目`;
    } catch (e) {
      S.versionsError = e.message;
      $('#dl-pick-hint').textContent = '拉版本清单失败：' + e.message;
    }
  }
  renderDlList();
  paintMp();
  if (!MP.asked && !MP.loading) mpSearch();
}

function renderDlLocal() {
  const local = (S.info.local || {});
  const rows = local.versions || [];
  $('#dl-hint').textContent = rows.length ? `${rows.length} 个版本，共 ${GB(rows.reduce((s, v) => s + v.bytes, 0))}` : '还没有下载任何版本';
  $('#dl-rows').innerHTML = rows.length ? rows.map((v) => `<div class="core">
      <div>${esc(v.mc)}<em>服务端 ${v.server ? MB(v.server) : '无'} · 客户端 ${v.client ? MB(v.client) : '无'} · Java ${v.javaMajor || '?'} · 合计 ${MB(v.bytes)}</em></div>
      <div style="display:flex;gap:6px;align-items:center">
        ${v.server ? '<span class="badge-mini">服务端</span>' : '<span class="badge-mini warn">缺服务端</span>'}
        ${v.client ? '<span class="badge-mini">客户端</span>' : '<span class="badge-mini warn">缺客户端</span>'}
        <button class="ghost sm" data-del="${esc(v.mc)}">删除</button>
      </div>
    </div>`).join('') : '<div class="empty">下面「取一个版本」里挑一个下载即可。</div>';
  for (const b of $$('#dl-rows [data-del]')) b.onclick = async () => {
    const mcName = b.dataset.del;
    const v = await modal(`删除 ${mcName} 的下载文件`, formHtml([
      { label: '同时回收不再被任何版本使用的共享库', key: 'clean', type: 'checkbox', value: true, checkText: '推荐：只删这个版本的话，几百 MB 依赖库会一直留在磁盘上' },
    ]), '删除');
    if (!v) return;
    try {
      await api.dlUninstall(mcName);
      let extra = '';
      if (v.clean) {
        const c = await api.dlCleanOrphans({ dryRun: false });
        extra = c.count ? `，并回收 ${c.count} 个库（${MB(c.bytes)}）` : '';
      }
      await refreshLocal();
      renderDlLocal();
      toast(`${mcName} 已删除${extra}`, 'ok');
    } catch (e) { err(e); }
  };
  const cleanBtn = $('#dl-clean');
  if (cleanBtn) cleanBtn.onclick = cleanOrphans;
}

function renderDlJava() {
  const have = (S.info.local || {}).jres || [];
  const sys = (S.info.javaList || []).map((j) => j.major);
  $('#dl-java-hint').textContent = have.length ? `已下载 ${have.join('/')}；系统另有 ${[...new Set(sys)].join('/') || '无'}` : '还没有下载 Java（用系统 Java 也可以，但版本要对得上）';
  $('#dl-java').innerHTML = [17, 21, 25].map((m) => `<div class="core">
      <div>Java ${m}<em>${have.includes(m) ? '已内置在数据目录' : (sys.includes(m) ? '系统里有，可直接用' : '未下载（约 45MB）')}</em></div>
      <div style="display:flex;gap:6px">${have.includes(m) ? '<span class="badge-mini">就绪</span>' : `<button class="cta sm" data-jre="${m}">下载 Java ${m}</button>`}</div>
    </div>`).join('');
  for (const b of $$('#dl-java [data-jre]')) b.onclick = async () => {
    b.disabled = true;
    b.textContent = '下载中…';
    try {
      const r = await api.javaDownload(b.dataset.jre);
      S.info.javaList = await api.javaList();
      await refreshLocal();
      renderDlJava();
      toast(r.note || `Java ${b.dataset.jre} 已就绪`, 'ok');
    } catch (e) { err(e); b.disabled = false; b.textContent = `下载 Java ${b.dataset.jre}`; }
  };
}

function renderDlList() {
  const box = $('#dl-list');
  if (!S.versions) { box.innerHTML = S.versionsError ? `<div class="empty">版本清单加载失败：${esc(S.versionsError)}<br>点上面「重新拉清单」重试（离线时也能用，只要之前联网拉过一次）</div>` : '<div class="empty">加载版本清单中…</div>'; return; }
  const q = ($('#dl-filter').value || '').trim();
  const type = $('#dl-type').value;
  const local = new Map(((S.info.local || {}).versions || []).map((v) => [v.mc, v]));
  const list = S.versions.versions.filter((v) => (type === 'all' || v.type === type) && (!q || v.id.includes(q)));
  $('#dl-count').textContent = `列出 ${list.length} 个`;
  box.innerHTML = list.slice(0, 300).map((v) => {
    const has = local.get(v.id);
    return `<div class="vrow">
      <div class="vn">${esc(v.id)}</div>
      <div class="vt">${v.type === 'release' ? '正式版' : v.type === 'snapshot' ? '快照' : v.type}</div>
      <div class="vs">${has ? `已下 ${MB(has.bytes)}（服务端 ${has.server ? '有' : '无'} / 客户端 ${has.client ? '有' : '无'}）` : new Date(v.releaseTime).toLocaleDateString()}</div>
      <div class="va">
        <button class="ghost sm" data-srv="${esc(v.id)}">服务端</button>
        <button class="ghost sm" data-cli="${esc(v.id)}">客户端</button>
        <button class="ghost sm" data-pap="${esc(v.id)}">Paper</button>
        <button class="ghost sm" data-fab="${esc(v.id)}">Fabric</button>
        <button class="ghost sm" data-fge="${esc(v.id)}">Forge</button>
      </div>
    </div>`;
  }).join('');
  const busy = (b, txt) => { b.disabled = true; b.dataset.old = b.textContent; b.textContent = txt; };
  const done = (b, ok, msg) => { b.disabled = false; b.textContent = b.dataset.old; ok ? toast(msg, 'ok') : err(new Error(msg)); };
  const bind = (sel, fn) => { for (const b of box.querySelectorAll(sel)) b.onclick = async () => { busy(b, '下载中…'); try { const m = await fn(b.dataset.srv || b.dataset.cli || b.dataset.pap || b.dataset.fab || b.dataset.fge); done(b, true, m); await refreshLocal(); renderDlLocal(); renderDlList(); } catch (e) { done(b, false, e.message); } }; };
  bind('[data-srv]', async (mc) => { const r = await api.dlInstallServer(mc); return `${mc} 服务端已就位`; });
  bind('[data-cli]', async (mc) => { const r = await api.dlInstallClient(mc); return r.ready ? `${mc} 客户端完整` : `${mc} 客户端下载完，但还差文件`; });
  bind('[data-pap]', async (mc) => { const r = await api.dlInstallPaper({ mc }); return `Paper ${mc} build ${r.build} 已就位（${MB(r.size)}）`; });
  bind('[data-fab]', async (mc) => { const r = await api.dlInstallFabric({ mc }); return `Fabric ${mc} loader ${r.loader} 已就位`; });
  bind('[data-fge]', async (mc) => {
    const tgt = $('#c-target') && $('#c-target').value;
    const list = await api.dlListForge(mc);
    if (!list.versions || !list.versions.length) throw new Error(`${mc} 没有 Forge 版本`);
    const v = await modal(`下载 Forge ${mc}`, formHtml([
      { label: '装到哪个服务器实例', key: 'id', type: 'select', value: S.sel || '', options: S.instances.length ? S.instances.map((i) => [i.id, `${i.name}（${i.mcVersion}）`]) : [['', '— 还没有实例，先去「开服务器」建一个 —']] },
      { label: 'Forge 版本', key: 'forgeVersion', type: 'select', value: list.recommended, options: list.versions.slice(0, 20).map((x) => [x, x + (x === list.recommended ? '（推荐）' : '')]) },
      { label: '说明', key: '_n', value: 'Forge 依赖要从 Maven 仓库拉，安装过程必须联网（约 150-250MB）。', type: 'text' },
    ]), '开始安装');
    if (!v) return '已取消';
    if (!v.id) throw new Error('没有可选的服务器实例');
    const r = await api.dlInstallForge({ id: v.id, forgeVersion: v.forgeVersion });
    await refreshInstances();
    return r.note;
  });
}

/* ---------------- 检查更新 ---------------- */
async function doUpdateCheck({ silent = false } = {}) {
  const btn = $('#btn-update');
  if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
  let self = null, mc = null;
  try {
    [self, mc] = await Promise.all([api.updateSelf({}), api.updateMc({})]);
  } catch (e) {
    if (!silent) err(e);
    if (btn) { btn.disabled = false; btn.textContent = '检查更新'; }
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = '检查更新'; }

  const lines = [];
  if (!self.configured) {
    lines.push(`<div class="card note"><b>RCL 自身</b><br>未配置更新源。<div class="hint" style="margin-top:6px">${esc(self.hint || '')}</div></div>`);
  } else if (self.error) {
    lines.push(`<div class="card note"><b>RCL 自身</b><br>${esc(self.error)}</div>`);
  } else if (self.hasUpdate) {
    lines.push(`<div class="card note"><b style="color:var(--warn)">发现新版本 RCL ${esc(self.latest)}</b>（当前 ${esc(self.current)}）<br>${esc(self.notes || '')}${self.url ? `<br><a href="#" data-open="${esc(self.url)}">${esc(self.url)}</a>` : ''}</div>`);
  } else {
    lines.push(`<div class="card note"><b style="color:var(--ok)">RCL 已是最新</b> 当前 v${esc(self.current)}</div>`);
  }
  if (mc.errors && mc.errors.length) lines.push(`<div class="card note"><b>部分检查失败</b><br>${mc.errors.slice(0, 4).map(esc).join('<br>')}</div>`);
  const newest = mc.mcLatest && mc.mcLatest.release;
  lines.push(`<div class="card note"><b>Minecraft 内容</b><br>最新正式版 <b>${esc(newest || '?')}</b> · 最新快照 ${esc((mc.mcLatest || {}).snapshot || '?')}<br>
    本地已装 ${mc.installed.length} 个版本${mc.installed.length ? `：${mc.installed.map((i) => esc(i.mc)).join('、')}` : ''}
    ${mc.canUpdateMc ? `<br><span style="color:var(--warn)">你还没下过 ${esc(mc.canUpdateMc)}</span>` : ''}</div>`);
  if (mc.paperUpdates.length) {
    lines.push(`<div class="card note"><b style="color:var(--warn)">Paper 有新构建</b><br>${mc.paperUpdates.map((p) => `${esc(p.mc)}：build ${p.from} → <b>${p.to}</b>`).join('<br>')}<br><div class="hint" style="margin-top:6px">去「下载」页对应版本点 Paper 即可更新。</div></div>`);
  } else if (!mc.errors.length) {
    lines.push('<div class="card note"><b style="color:var(--ok)">Paper 都是最新构建</b></div>');
  }
  $('#modal-body').innerHTML = lines.join('');
  $('#modal-title').textContent = '检查结果';
  openInfoModal('关闭');
  for (const a of $$('#modal-body [data-open]')) a.onclick = (e) => { e.preventDefault(); api.openExternal(a.dataset.open); };
  S.update = { self, mc, at: Date.now() };
  paintUpdatePill();
}

function paintUpdatePill() {
  const btn = $('#btn-update');
  if (!btn || !S.update) return;
  const has = (S.update.self && S.update.self.hasUpdate) || (S.update.mc && (S.update.mc.canUpdateMc || (S.update.mc.paperUpdates || []).length));
  btn.textContent = has ? '有更新可用' : '检查更新';
  btn.style.color = has ? 'var(--warn)' : '';
}

function openInfoModal(okText) {
  return new Promise((resolve) => {
    $('#modal').hidden = false;
    const done = () => { $('#modal').hidden = true; $('#modal-ok').onclick = null; $('#modal-cancel').onclick = null; resolve(true); };
    $('#modal-ok').textContent = okText || '关闭';
    $('#modal-ok').onclick = done;
    $('#modal-cancel').onclick = done;
  });
}

async function cleanOrphans() {
  const dry = await api.dlCleanOrphans({ dryRun: true });
  if (!dry.count) return toast('没有可回收的共享库');
  const v = await modal('回收无用依赖', `<div class="card note">有 <b>${dry.count}</b> 个共享库文件（${MB(dry.bytes)}）已经没有任何已下载的版本在用了。<br>删掉可以回收磁盘空间，之后哪个版本要用会自动重新下载。</div>`, `回收 ${MB(dry.bytes)}`);
  if (!v) return;
  const r = await api.dlCleanOrphans({ dryRun: false });
  toast(`已回收 ${r.count} 个文件（${MB(r.bytes)}）`, 'ok');
  await refreshLocal();
}

/* ---------------- 下载管理 ---------------- */
const JSTATE = { queued: '排队中', running: '下载中', done: '已完成', error: '有失败', cancelled: '已取消' };

function renderJobs() {
  const j = S.jobs;
  const pct = j.totalBytes ? Math.min(100, Math.round((j.bytes / j.totalBytes) * 100)) : (j.active ? 0 : 100);
  $('#j-all').style.width = (j.active ? pct : 0) + '%';
  // 有任务在跑时给进度条叠一道扫光，一眼能看出还活着
  $('#j-all').parentNode.classList.toggle('live', !!j.active);
  $('#j-sum').textContent = j.active ? `${j.active} 个任务进行中 · 完成 ${j.done} · 失败 ${j.failed}` : (j.jobs.length ? `全部完成（${j.done} 个任务）` : '还没有下载任务，去「下载」页取版本或在「模组光影」装模组');
  $('#j-speed').textContent = j.active ? `合计 ${(j.speed / 1048576).toFixed(1)} MB/s · 已传 ${MB(j.bytes)} / ${MB(j.totalBytes)}` : '';
  const box = $('#j-list');
  if (!j.jobs.length) { box.innerHTML = '<div class="empty">列表是空的。</div>'; return; }
  box.innerHTML = j.jobs.slice(0, 80).map((t) => {
    const p = t.totalBytes ? Math.min(100, Math.round((t.bytes / t.totalBytes) * 100)) : (t.state === 'done' ? 100 : 0);
    const live = t.state === 'running' || t.state === 'queued';
    return `<div class="card jobrow ${t.state}">
      <div class="jr-top">
        <b>${esc(t.label)}</b>
        <span class="badge ${t.state === 'done' ? 'ok' : t.state === 'error' ? 'bad' : live ? '' : ''}">${JSTATE[t.state] || t.state}</span>
        <span class="spacer"></span>
        ${live ? `<button class="ghost sm" data-jcancel="${t.id}">取消</button>` : ''}
      </div>
      <div class="bar"><i style="width:${p}%"></i></div>
      <div class="jr-meta">
        <span>${p}%</span>
        <span>${t.files}/${t.totalFiles} 个文件${t.cachedFiles ? `（${t.cachedFiles} 个已存在）` : ''}</span>
        <span>${t.totalBytes ? `${MB(t.bytes)} / ${MB(t.totalBytes)}` : MB(t.bytes)}</span>
        <span>${live && t.speed ? `${(t.speed / 1048576).toFixed(1)} MB/s` : live ? '准备中' : ''}</span>
        <span>${t.eta ? `剩 ${dur(t.eta)}` : ''}</span>
        <span>${t.elapsed ? `用时 ${dur(t.elapsed)}` : ''}</span>
      </div>
      ${t.current && live ? `<div class="jr-cur">正在传：${esc(t.current)}</div>` : ''}
      ${t.errors && t.errors.length ? `<details class="jr-err"><summary>${t.errorCount || t.errors.length} 个文件失败（点开看）</summary><pre>${esc(t.errors.join('\n'))}</pre></details>` : ''}
    </div>`;
  }).join('');
  for (const b of box.querySelectorAll('[data-jcancel]')) b.onclick = async () => { await api.jobsCancel(b.dataset.jcancel); refreshJobs(); };
}

async function refreshJobs() {
  try { S.jobs = await api.jobsList(); renderJobs(); paintDlPill(); } catch { /* 窗口在关闭 */ }
}

function paintDlPill() {
  const pill = $('#pill-dl');
  if (!pill) return;
  const j = S.jobs;
  if (j.active) {
    pill.classList.remove('hidden');
    pill.textContent = `下载 ${j.active} 项 · ${(j.speed / 1048576).toFixed(1)} MB/s`;
    pill.className = 'pill dl ok';
  } else {
    pill.classList.add('hidden');
    pill.className = 'pill dl hidden';
  }
}

/* ---------------- 内容页（模组 / 光影 / 材质） ---------------- */
function contentTargets() {
  return [...S.games.map((g) => [g.id, `游戏档案 · ${g.name}（${g.mcVersion}）`, g.mcVersion, 'game']),
    ...S.instances.map((i) => [i.id, `服务器 · ${i.name}（${i.mcVersion}）`, i.mcVersion, 'server'])];
}

function renderContent() {
  const box = $('#c-target');
  const tg = contentTargets();
  const cur = box.value;
  box.innerHTML = tg.length ? tg.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('') : '<option value="">— 还没有档案或服务器 —</option>';
  if (cur && tg.some((t) => t[0] === cur)) box.value = cur;
  $('#c-source').value = S.content.source;
  $('#c-type').value = S.content.type;
  updateContentHint();
  renderContentList();
  // 进页面就自己搜一次，不用等用户点按钮
  const t = currentTarget();
  if (t && S.content.sig !== contentSig()) doSearch();
}

function contentSig() {
  const t = currentTarget();
  return t ? `${S.content.source}|${S.content.type}|${t.id}|${t.mc}|${$('#c-q').value.trim()}` : '';
}

async function doSearch(append = false) {
  const t = currentTarget();
  if (!t) { S.content.status = '先选一个要装到的游戏档案或服务器'; renderContentList(); updateContentHint(); return; }
  S.content.source = $('#c-source').value;
  S.content.type = $('#c-type').value;
  S.content.sig = contentSig();
  const offset = append ? S.content.items.length : 0;
  if (!append) { S.content.items = []; }
  S.content.loading = true;
  S.content.status = '搜索中…';
  renderContentList();
  updateContentHint();
  try {
    const r = await api.contentSearch({ source: S.content.source, type: S.content.type, query: $('#c-q').value.trim(), mcVersion: t.mc, limit: PAGE, offset });
    S.content.items = append ? [...S.content.items, ...(r.items || [])] : (r.items || []);
    S.content.total = r.total || S.content.items.length;
    S.content.needsKey = !!r.needsKey;
    S.content.status = r.needsKey || r.error ? r.error : `${S.content.items.length} / ${S.content.total} 条${r.via ? ' · ' + r.via : ''}`;
  } catch (e) {
    S.content.status = e.message;
  } finally {
    S.content.loading = false;
    renderContentList();
    updateContentHint();
  }
}

// 图标经常 404，坏了就整块藏掉而不是留个破图框
function guardImg(img) {
  if (!img.getAttribute('src')) img.style.visibility = 'hidden';
  else img.addEventListener('error', () => { img.style.visibility = 'hidden'; }, { once: true });
}

function renderContentList() {
  const box = $('#c-list');
  const c = S.content;
  if (c.loading && !c.items.length) { box.innerHTML = '<div class="card note">搜索中…</div>'; return; }
  if (!c.items.length) { box.innerHTML = `<div class="card note">${esc(c.status || '搜点什么。')}</div>`; return; }
  const more = c.items.length < (c.total || 0);
  box.innerHTML = c.items.map((m, idx) => `<div class="item">
      <img src="${esc(m.icon || '')}" alt="" />
      <div class="im-b">
        <b>${esc(m.name)}</b> <em>${m.source === 'modrinth' ? 'Modrinth' : 'CurseForge'}</em>
        <p>${esc(m.desc || '')}</p>
        <em>${esc(m.author || '')} · 下载 ${m.downloads ? Number(m.downloads).toLocaleString() : '?'} · <a href="#" data-open="${esc(m.url)}">${esc((m.url || '').replace(/^https?:\/\//, ''))}</a></em>
      </div>
      <div class="ia"><button class="cta sm" data-get="${idx}">安装</button></div>
    </div>`).join('')
    + `<div class="card" style="display:flex;align-items:center;gap:10px">
        <span class="hint">${esc(c.status)}</span><span class="spacer"></span>
        ${more ? '<button class="ghost" id="c-more">加载更多</button>' : '<span class="hint">没有更多了</span>'}
      </div>`;
  for (const img of box.querySelectorAll('.item img')) guardImg(img);
  for (const b of box.querySelectorAll('[data-open]')) b.onclick = (e) => { e.preventDefault(); api.openExternal(b.dataset.open); };
  for (const b of box.querySelectorAll('[data-get]')) b.onclick = () => pickAndInstall(c.items[Number(b.dataset.get)], b);
  const m = box.querySelector('#c-more');
  if (m) m.onclick = () => doSearch(true);
}

function currentTarget() {
  const id = $('#c-target').value;
  const g = S.games.find((x) => x.id === id);
  if (g) return { id, mc: g.mcVersion, kind: 'game', name: g.name };
  const i = S.instances.find((x) => x.id === id);
  if (i) return { id, mc: i.mcVersion, kind: 'server', name: i.name };
  return null;
}

function updateContentHint() {
  const t = currentTarget();
  $('#c-ver-hint').textContent = t ? `按 ${t.mc} 过滤` : '未选目标';
  $('#c-status').textContent = S.content.status || (t ? `会装到「${t.name}」的对应目录` : '先选一个游戏档案或服务器');
}

async function pickAndInstall(item, btn) {
  if (S.content.type === 'modpack') return pickModpackFile(item, btn);
  const t = currentTarget();
  if (!t) return toast('先选目标', 'bad');
  btn.textContent = '取列表中…';
  let files = [];
  try {
    if (item.source === 'modrinth') {
      const vs = await api.contentFiles({ source: 'modrinth', project: item.id });
      files = vs.flatMap((v) => v.files.map((f) => ({ label: `${v.version} · ${v.loader} · ${v.mc} · ${MB(f.size || 0)}`, url: f.url, name: f.name })));
    } else {
      const cf = await api.contentFiles({ source: 'curse', project: item.id });
      files = (Array.isArray(cf) ? cf : [cf]).filter((f) => f.url).map((f) => ({ label: `${f.name} · ${MB(f.size || 0)} · ${(f.versions || []).slice(-2).join(',')}`, url: f.url, name: f.name }));
    }
  } catch (e) { btn.textContent = '安装'; return err(e); }
  btn.textContent = '安装';
  if (!files.length) return toast('这个项目没有可下载的文件', 'bad');
  const folder = S.content.type === 'shader' ? 'shaderpacks' : S.content.type === 'resourcepack' ? 'resourcepacks' : 'mods';
  const v = await modal(`${item.name} → ${t.name}/${folder}`, formHtml([
    { label: '选文件', key: 'file', type: 'select', value: '', options: files.map((f, i) => [String(i), f.label]) },
  ]), '下载');
  if (!v) return;
  const f = files[Number(v.file)];
  btn.disabled = true;
  btn.textContent = '下载中…';
  try {
    const r = await api.contentToInstance({ id: t.id, kind: S.content.type, url: f.url, fileName: f.name });
    toast(`已装到 ${r.dir}（${MB(r.bytes)}）`, 'ok');
  } catch (e) { err(e); } finally { btn.disabled = false; btn.textContent = '安装'; }
}

/* ---------------- 设置页 ---------------- */
async function renderSettings() {
  const s = S.settings;
  const javas = S.info.javaList || [];
  const box = $('#settings-form');
  box.innerHTML = formHtml([
    { label: '下载镜像源', key: 'mirror', type: 'select', value: s.mirror, options: S.info.mirrors.map((m) => [m.id, m.name]), hint: '默认 BMCLAPI；失败会自动回落官方源' },
    { label: '界面主题', key: 'theme', type: 'select', value: s.theme, options: [['dark', '深色'], ['light', '浅色']] },
    { label: '关窗时', key: 'closeAction', type: 'select', value: s.closeAction || 'ask', options: [['ask', '每次问我'], ['tray', '收进托盘（后台继续跑）'], ['quit', '直接退出']] },
    { label: '并发下载数', key: 'concurrency', type: 'number', value: s.concurrency },
    { label: '内存 MB（游戏与服务器通用）', key: 'memoryMB', type: 'number', value: s.memoryMB, hint: '游戏档案不再单独设内存，统一用这个' },
    { label: '默认 JVM 预设', key: 'jvmPreset', type: 'select', value: s.jvmPreset, options: S.info.jvmPresets.map((p) => [p.id, p.name]) },
    { label: '自动同意 EULA', key: 'autoEula', type: 'checkbox', value: s.autoEula, checkText: '建服务器时自动写 eula=true' },
    { label: '崩溃自动重启', key: 'autoRestart', type: 'checkbox', value: s.autoRestart, checkText: '异常退出后自动重开' },
    { label: '最多自动重启次数', key: 'maxRestarts', type: 'number', value: s.maxRestarts },
    { label: 'CurseForge API Key', key: 'curseApiKey', value: s.curseApiKey || '', ph: '没有就只用 Modrinth', hint: '免费申请：https://console.curseforge.com/ → REGISTER AN APP', full: true },
    { label: '微软登录 Client ID', key: 'msClientId', value: s.msClientId || '', ph: 'Azure 应用注册页里的「应用程序(客户端) ID」', hint: '正版登录必需：https://portal.azure.com → App registrations', full: true },
    { label: 'RCL 更新源（返回 JSON 的地址）', key: 'updateFeed', value: s.updateFeed || '', ph: 'https://... /rcl-latest.json　形如 {"version":"1.0.3","url":"...","notes":"..."}', hint: '留空则「检查更新」只查 MC 内容，不查 RCL 自身', full: true },
    { label: '额外 JVM 参数（全局）', key: 'jvmArgs', value: s.jvmArgs, full: true },
    { label: '服务器存放目录', key: 'subRoot', value: s.subRoot || '', ph: S.info.serversRoot, row: `<button class="ghost" type="button" id="pick-root">浏览…</button>`, full: true, hint: '默认 ' + S.info.serversRoot },
  ]) + `<div class="form-actions"><button class="ghost" id="java-rescan">重新检测 Java</button><button class="cta" id="set-save">保存设置</button></div>
    <div class="full"><label style="font-size:11.5px;color:var(--fg3)">已检测到的 Java（${javas.length} 个）</label>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">${javas.length ? javas.map((j) => `<div class="core"><div>Java ${j.major}<em>${esc(j.path)}</em></div><span class="badge-mini">${esc(j.source)}</span></div>`).join('') : '<div class="empty">没检测到 Java，去「下载」页取一个</div>'}</div>
      <div class="hint" style="margin-top:8px">按大版本指定用哪个 Java（留空自动挑最贴近的）：</div>
      ${[17, 21, 25].map((m) => `<div class="f" style="margin-top:6px"><label>Java ${m}</label><div class="row"><select data-key="jb${m}"><option value="">自动</option>${javas.filter((j) => j.major >= m).map((j) => `<option value="${esc(j.path)}" ${((s.javaByMajor || {})[m] === j.path) ? 'selected' : ''}>${esc(j.source)} · ${j.major}</option>`).join('')}</select><button class="ghost" type="button" data-browse="${m}">浏览…</button></div></div>`).join('')}
    </div>
    <div class="full"><label style="font-size:11.5px;color:var(--fg3)">登录账号</label>
      <div id="acc-list" style="display:flex;flex-direction:column;gap:6px;margin-top:6px"></div>
      <div class="c-bar" style="margin-top:8px">
        <button class="ghost sm" id="acc-ms">微软正版登录</button>
        <button class="ghost sm" id="acc-aai">下载 authlib-injector</button>
        <span class="hint">离线身份不用登录，档案里填游戏 ID 即可。</span>
      </div>
    </div>`;
  renderAccounts();
  $('#set-save').onclick = async () => {
    const v = {};
    for (const el of box.querySelectorAll('[data-key]')) v[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.value;
    const byMajor = {};
    for (const m of [17, 21, 25]) { if (v['jb' + m]) byMajor[String(m)] = v['jb' + m]; delete v['jb' + m]; }
    const patch = { ...v, memoryMB: Number(v.memoryMB), concurrency: Number(v.concurrency), maxRestarts: Number(v.maxRestarts), javaByMajor: byMajor };
    S.settings = await api.settingsSet(patch);
    applyTheme();
    toast('已保存', 'ok');
  };
  const pickBtn = box.querySelector('#pick-root');
  if (pickBtn) pickBtn.onclick = async () => { const p = await api.pickFolder(); if (p) box.querySelector('[data-key="subRoot"]').value = p; };
  box.querySelector('#java-rescan').onclick = async () => { S.info.javaList = await api.javaList(); renderSettings(); toast('已重新检测 Java', 'ok'); };
  for (const b of box.querySelectorAll('[data-browse]')) b.onclick = async () => {
    const p = await api.javaBrowse();
    if (p) { const sel = box.querySelector(`[data-key="jb${b.dataset.browse}"]`); const o = document.createElement('option'); o.value = p; o.textContent = '手动选择 ' + p; o.selected = true; sel.appendChild(o); }
  };
  box.querySelector('#acc-ms').onclick = msLogin;
  box.querySelector('#acc-aai').onclick = async () => {
    try { const r = await api.authEnsureInjector(); toast(`authlib-injector 已就位（${MB(r.bytes)}）`, 'ok'); } catch (e) { err(e); }
  };
}

function renderAccounts() {
  const box = $('#acc-list');
  if (!box) return;
  const accs = S.info.accounts || [];
  box.innerHTML = accs.length ? accs.map((a) => `<div class="core"><div>${esc(AUTH_NAME[a.type] || a.type)} · ${esc(a.name)}<em>${esc(a.uuid || '')}${a.aaiRoot ? ' · ' + esc(a.aaiRoot) : ''}</em></div><button class="ghost sm" data-acc-rm="${esc(a.key)}">删除</button></div>`).join('') : '<div class="empty">还没有登录账号。离线档案不需要账号。</div>';
  for (const b of box.querySelectorAll('[data-acc-rm]')) b.onclick = async () => { await api.authRemove(b.dataset.accRm); S.info.accounts = await api.authList(); renderAccounts(); toast('已删除账号凭据', 'ok'); };
}

async function msLogin() {
  const clientId = (S.settings.msClientId || '').trim();
  if (!clientId) {
    const v = await modal('需要 Azure 客户端 ID', formHtml([
      { label: '微软登录 Client ID', key: 'msClientId', value: '', ph: 'portal.azure.com → App registrations → 应用程序(客户端) ID' },
    ]), '保存并继续');
    if (!v || !v.msClientId) return;
    S.settings = await api.settingsSet({ msClientId: v.msClientId.trim() });
    return msLogin();
  }
  toast('正在向微软申请设备码…');
  try {
    const p = api.authMsLogin({ clientId });
    const timer = setTimeout(() => toast('等待你在浏览器里确认（10 分钟内有效）'), 3000);
    const r = await p;
    clearTimeout(timer);
    S.info.accounts = await api.authList();
    renderAccounts();
    toast(`已登录 ${r.name}，可以在档案里选这个账号`, 'ok');
  } catch (e) { err(e); }
}

/* ---------------- 关闭 / 托盘 ---------------- */
async function askClose() {
  const v = await modal('关闭 RCL', formHtml([
    { label: '怎么处理？', key: 'mode', type: 'select', value: 'tray', options: [['tray', '收进托盘，程序继续在后台跑'], ['quit', '直接退出 RCL']] },
    { label: '记住我的选择', key: 'remember', type: 'checkbox', value: false, checkText: '下次不再问，直接按上面选的做' },
  ]), '确定');
  if (!v) return api.cancelQuit();
  await api.closeChoice({ mode: v.mode, remember: !!v.remember });
}

/* ---------------- 初始化 ---------------- */
function applyTheme() { document.body.dataset.theme = S.settings.theme || 'dark'; }

async function init() {
  S.info = await api.info();
  S.settings = S.info.settings;
  applyTheme();
  document.title = 'RCL';
  $('#brand-sub').textContent = `${S.info.name} v${S.info.version} · ${S.info.packaged ? '正式版' : '开发版'}`;
  $('#foot-java').textContent = `Java: ${[...new Set((S.info.javaList || []).map((j) => j.major))].sort().join(' / ') || '未检测到'}`;
  $('#foot-store').textContent = `数据目录: ${S.info.dataRoot}`;
  $('#quick').innerHTML = QUICK.map((q) => `<button data-q="${esc(q)}">${esc(q.trim())}</button>`).join('');
  for (const b of $$('#quick button')) b.onclick = () => { $('#cmd').value = b.dataset.q; $('#cmd').focus(); };

  for (const b of $$('#nav button')) b.onclick = () => switchView(b.dataset.view);
  for (const b of $$('#tabs button')) b.onclick = () => switchTab(b.dataset.tab);
  for (const b of $$('#gtabs button')) b.onclick = () => switchGTab(b.dataset.gtab);
  $('#btn-start').onclick = doStart;
  $('#btn-stop').onclick = () => doStop(false);
  $('#btn-kill').onclick = () => doStop(true);
  $('#btn-dir').onclick = () => { const i = inst(); if (i) api.instancesOpen(i.id); };
  $('#btn-remove').onclick = removeInstance;
  $('#btn-send').onclick = doSend;
  $('#btn-clear').onclick = () => { S.lines.set(S.sel, []); renderConsole(); };
  $('#btn-gclear').onclick = () => { S.lines.set(S.selGame, []); renderGConsole(); };
  $('#btn-play').onclick = doPlay;
  $('#btn-close-game').onclick = doCloseGame;
  $('#btn-prepare').onclick = doPrepare;
  $('#btn-game-dir').onclick = () => { const g = game(); if (g) api.gamesOpen(g.id); };
  $('#btn-game-remove').onclick = removeGame;
  $('#btn-game-import').onclick = importGame;
  $('#btn-game-modpack').onclick = async () => {
    const picked = await api.modpackPick();
    if (!picked) return;
    const i = picked.info;
    const ok = await modal('整合包内容', `<div class="card note">
      <b>${esc(i.name)}</b> ${esc(i.version)}<br>
      需要 Minecraft <b>${esc(i.mc || '未知')}</b> · 加载器 <b>${LOADER_NAME[i.loader.type] || i.loader.type}${i.loader.version ? ' ' + esc(i.loader.version) : ''}</b><br>
      ${i.files} 个文件约 ${MB(i.bytes)}，另有 ${i.overrides} 个覆盖配置${i.skipped ? `，${i.skipped} 个服务端专用文件会跳过` : ''}<br>
      目录：${esc(picked.file)}
    </div>`, '开始安装');
    if (!ok) return;
    try {
      const r = await api.modpackInstall({ file: picked.file });
      S.selGame = r.game.id;
      await refreshGames();
      await refreshClientStatus(r.mc);
      toast(r.note, 'ok');
    } catch (e) { err(e); }
  };
  $('#btn-theme').onclick = async () => { S.settings = await api.settingsSet({ theme: S.settings.theme === 'dark' ? 'light' : 'dark' }); applyTheme(); };
  $('#btn-update').onclick = () => doUpdateCheck();
  $('#pill-dl').onclick = () => switchView('jobs');
  $('#btn-tray').onclick = () => api.hideToTray();
  $('#cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
  $('#opt-filter').addEventListener('input', () => renderConsole());
  $('#opt-autoscroll').addEventListener('change', () => renderGConsole());
  $('#opt-color').addEventListener('change', () => renderGConsole());
  $('#opt-autoscroll-s').addEventListener('change', () => renderConsole());
  $('#opt-color-s').addEventListener('change', () => renderConsole());
  $('#c-go').onclick = () => doSearch();
  $('#c-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  // 换目标 / 换源 / 换类型都自动重搜，不用点按钮
  const reSearch = () => { S.content.sig = ''; renderContent(); };
  $('#c-target').onchange = () => { updateContentHint(); reSearch(); };
  $('#c-source').onchange = () => { S.content.source = $('#c-source').value; reSearch(); };
  $('#c-type').onchange = () => { S.content.type = $('#c-type').value; reSearch(); };
  $('#dl-filter').addEventListener('input', () => renderDlList());
  $('#dl-type').onchange = () => renderDlList();
  $('#dl-refresh').onclick = async () => { S.versions = null; $('#dl-pick-hint').textContent = '刷新中…'; await renderDl(); };
  $('#mp-go').onclick = () => { MP.q = $('#mp-q').value.trim(); mpSearch(); };
  $('#mp-q').onkeydown = (e) => { if (e.key === 'Enter') { MP.q = $('#mp-q').value.trim(); mpSearch(); } };
  window.addEventListener('keydown', (e) => {
    if (e.altKey && VIEWS[Number(e.key) - 1]) switchView(VIEWS[Number(e.key) - 1]);
  });

  api.onConsole((p) => appendLines(p.id, p.chunk));
  api.onServerState(async (st) => {
    S.states.set(st.id, st);
    renderServerList();
    renderHero();
    renderStats();
    updateRunningPill();
    if (S.tab === 'plan') renderPlan();
    if (st.state === 'stopped') await refreshInstances();
  });
  api.onGameState(async (st) => {
    S.gameStates.set(st.id, st);
    renderGameList();
    renderGameHero();
    updateRunningPill();
    if (st.state === 'stopped') {
      await refreshGames();
      const g = S.games.find((x) => x.id === st.id);
      if (g && g.lastExit) toast(`「${g.name}」已退出（code=${g.lastExit}）`, g.lastExit === 0 ? 'ok' : '');
    }
  });
  api.onInstallProgress((p) => {
    S.jobs = { ...S.jobs, ...p };
    const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    const txt = `${p.label || '下载中'} ${pct}%（${p.done}/${p.total}）· ${MB(p.speed || 0)}/s`;
    if (S.view === 'game') { $('#g-res-bar').style.width = pct + '%'; $('#g-res-hint').textContent = txt; }
    if (S.view === 'dl') $('#dl-hint').textContent = txt;
    if (p.state === 'error') toast(`${p.name}: ${p.message}`, 'bad');
  });
  api.onInstallLog((l) => {
    if (S.view === 'dl') $('#dl-pick-hint').textContent = l;
  });
  api.onJobs((snap) => { S.jobs = snap; paintDlPill(); if (S.view === 'jobs') renderJobs(); });
  api.onDeviceCode((c) => {
    modal('微软账号登录', `<div class="card note">浏览器打开 <b>${esc(c.verification_uri)}</b><br>输入代码：<b style="font-size:22px;letter-spacing:3px">${esc(c.user_code)}</b><br><div class="hint" style="margin-top:8px">${esc(c.message || '代码 15 分钟内有效。')}</div></div>`, '我已完成');
  });
  api.onAskQuit(async (n) => {
    const v = await modal(`${n} 个程序还在运行`, '<div class="card note">直接退出会强杀进程：服务器可能来不及存盘，游戏存档同理。<br>建议选「停止并退出」。</div>', '停止并退出');
    if (v === null) return api.cancelQuit();
    await api.confirmQuit('stop');
  });
  api.onAskClose(() => askClose());

  await refreshInstances();
  await refreshGames();
  await refreshLocal();
  try { S.jobs = await api.jobsList(); paintDlPill(); } catch { /* 还没有任务 */ }
  const g0 = game();
  if (g0) await refreshClientStatus(g0.mcVersion);
  switchView(S.view);
  setInterval(async () => {
    try {
      for (const st of await api.serverStates()) S.states.set(st.id, st);
      for (const st of await api.gameStates()) S.gameStates.set(st.id, st);
      updateRunningPill();
      if (S.view === 'server') { renderStats(); renderServerList(); }
      if (S.view === 'game') { renderGameHero(); renderGameList(); }
    } catch { /* 窗口正在关闭 */ }
  }, 2000);
}

init().catch((e) => toast('界面初始化失败：' + e.message, 'bad'));
