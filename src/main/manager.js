'use strict';
// 服务器进程管理：启动、控制台流、stdin 命令、优雅/强制停止、崩溃自动重启、在线玩家统计

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { buildPlan, toCommand, writeArgfile } = require('./profiles');
const { sanitizeName } = require('./paths');

const DONE_RE = /Done\s*\([\d.]+s\)\s*!/;
const JOIN_RE = /([A-Za-z0-9_]{1,16}) joined the game/;
const LEAVE_RE = /([A-Za-z0-9_]{1,16}) left the game/;

class ServerManager extends EventEmitter {
  // repo 让同一套进程管理既能管服务器也能管游戏客户端：
  // { get(id), dirOf(e), patch(id,patch), all(), prepare(e), buildPlan(e), label }
  constructor({ store, catalog, pickJava, repo }) {
    super();
    this.store = store;
    this.catalog = catalog;
    this.pickJava = pickJava;
    this.repo = repo || {
      get: (id) => store.get(id),
      dirOf: (e) => store.instanceDir(e),
      patch: (id, p) => store.patch(id, p),
      all: () => store.instances,
      prepare: (e) => this.prepareFiles(e),
      buildPlan: (e) => buildPlan({ instance: e, settings: store.settings, catalog }),
      label: '服务器',
    };
    this.runtimes = new Map(); // id -> runtime
  }

  state(id) {
    const r = this.runtimes.get(id);
    if (!r) return { id, state: 'stopped', players: [], startedAt: null, exit: null, tail: [] };
    return { id, state: r.state, players: [...r.players], startedAt: r.startedAt, exit: r.exit, note: r.note, uptime: r.startedAt ? Date.now() - r.startedAt : 0 };
  }

  runningCount() { return [...this.runtimes.values()].filter((r) => r.state === 'running' || r.state === 'starting').length; }

  async start(id) {
    const inst = this.repo.get(id);
    if (!inst) throw new Error('找不到这个实例');
    if (this.runtimes.has(id) && ['starting', 'running'].includes(this.runtimes.get(id).state)) throw new Error(`${this.repo.label}已经在运行了`);

    inst.dir = this.repo.dirOf(inst);
    fs.mkdirSync(inst.dir, { recursive: true });
    if (this.repo.prepare) this.repo.prepare(inst);

    const settings = this.store.settings;
    // 首次启动要解包内置 bundler jar（几十 MB 写盘，会卡几秒），先给个提示
    this.emit('console', { id, chunk: `[启动器] 正在准备${this.repo.label}依赖（首次会解包/解压，稍等几秒）…\n` });
    const plan = this.repo.buildPlan(inst);
    if (plan.missing && plan.missing.length) {
      throw new Error(`缺少 ${plan.missing.length} 个依赖库，请到"版本库"点「校验/解包」补齐`);
    }
    const picked = this.pickJava(inst, plan.javaMajorWanted);
    const java = picked && picked.java;
    if (!java || !java.path) throw new Error(`找不到可用的 Java（需要 ${plan.javaMajorWanted || 17}+），去设置里指定 Java 路径`);

    const cmd = toCommand(plan, java.path);
    let args;
    let argsNote = '';
    if (cmd.argfile) {
      const f = writeArgfile(inst.dir, cmd.argfile);
      args = [`@${path.relative(inst.dir, f).replace(/\\/g, '/')}`];
      argsNote = `参数过长，已改用 argfile：${f}`;
    } else {
      args = cmd.argv;
    }

    const consoleLog = path.join(inst.dir, 'mcl-console.log');
    const logStream = fs.createWriteStream(consoleLog, { flags: 'a' });
    logStream.on('error', () => { /* 磁盘/占用问题不该拖垮启动器 */ });
    logStream.write(`\n===== ${new Date().toLocaleString()} 启动 ${inst.name} (${plan.core} ${inst.mcVersion}) =====\n`);

    const child = spawn(java.path, args, { cwd: plan.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rt = {
      id, child, state: 'starting', startedAt: Date.now(), exit: null, note: picked.note,
      players: new Set(), restarts: 0, logStream, plan, java, userStop: false, tail: [],
    };
    this.runtimes.set(id, rt);
    // 客户端没有 "Done" 这类就绪日志，进程起来就算运行中
    if (this.repo.readyOnSpawn) rt.state = 'running';
    this.emit('state', this.state(id));
    this.pushLine(rt, `[启动器] Java: ${java.path} (${java.raw || java.major})`);
    this.pushLine(rt, `[启动器] 主类: ${plan.mainClass || (plan.jar ? '-jar ' + plan.jar : 'Forge 参数文件')}`);
    this.pushLine(rt, `[启动器] 目录: ${plan.cwd}`);
    if (argsNote) this.pushLine(rt, `[启动器] ${argsNote}`);

    const out = new StringDecoder('utf8');
    const err = new StringDecoder('utf8');
    child.stdout.on('data', (b) => this.onOutput(rt, out.write(b)));
    child.stderr.on('data', (b) => this.onOutput(rt, err.write(b)));
    child.stdin.on('error', () => { /* 进程已退出时写 stdin 会报错，忽略 */ });
    child.on('error', (e) => this.pushLine(rt, `[启动器] 进程错误: ${e.message}`));
    child.on('close', (code, signal) => this.onClose(rt, code, signal));
    return { ok: true, note: picked.note, state: this.state(id) };
  }

  onOutput(rt, text) {
    if (!text) return;
    try { if (rt.logStream && rt.logStream.writableEnded !== true) rt.logStream.write(text); } catch { /* closed */ }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      rt.tail.push(line);
      if (rt.tail.length > 400) rt.tail.shift();
      const j = line.match(JOIN_RE); if (j) { rt.players.add(j[1]); this.emit('state', this.state(rt.id)); }
      const l = line.match(LEAVE_RE); if (l) { rt.players.delete(l[1]); this.emit('state', this.state(rt.id)); }
      if (rt.state === 'starting' && DONE_RE.test(line)) {
        rt.state = 'running';
        this.emit('state', this.state(rt.id));
      }
    }
    this.emit('console', { id: rt.id, chunk: text });
  }

  pushLine(rt, line) {
    rt.tail.push(line);
    if (rt.tail.length > 400) rt.tail.shift();
    try { if (rt.logStream && rt.logStream.writableEnded !== true) rt.logStream.write(line + '\n'); } catch { /* closed */ }
    this.emit('console', { id: rt.id, chunk: line + '\n' });
  }

  onClose(rt, code, signal) {
    const userStop = rt.userStop;
    rt.exit = { code, signal };
    rt.state = 'stopped';
    rt.players.clear();
    this.repo.patch(rt.id, { lastExit: code, lastExitAt: Date.now() });
    this.emit('state', this.state(rt.id));
    const inst = this.repo.get(rt.id);
    if (!inst) { closeStream(rt); return; }
    const settings = this.store.settings;
    const autoRestart = inst.autoRestart === null ? settings.autoRestart : inst.autoRestart;
    const max = settings.maxRestarts || 3;
    if (!userStop && code !== 0 && autoRestart && rt.restarts < max) {
      rt.restarts++;
      rt.state = 'restarting';
      closeStream(rt);
      rt.logStream = fs.createWriteStream(path.join(inst.dir, 'mcl-console.log'), { flags: 'a' });
      this.pushLine(rt, `[启动器] 异常退出（code=${code}），5 秒后自动重启（第 ${rt.restarts}/${max} 次）`);
      this.emit('state', this.state(rt.id));
      rt.restartTimer = setTimeout(() => {
        this.start(rt.id).catch((e) => this.pushLine(rt, `[启动器] 自动重启失败: ${e.message}`));
      }, 5000);
    } else {
      if (!userStop && code !== 0) this.pushLine(rt, `[启动器] 进程退出，code=${code}${signal ? ` signal=${signal}` : ''}（未触发自动重启）`);
      closeStream(rt);
    }
  }

  // 启动前把实例目录准备成"能直接开服"的样子
  prepareFiles(inst) {
    const s = this.store.settings;
    const eula = path.join(inst.dir, 'eula.txt');
    if (!fs.existsSync(eula)) {
      if (s.autoEula) fs.writeFileSync(eula, '# 由启动器写入：创建服务器即视为同意 Mojang EULA\neula=true\n', 'utf8');
    } else if (s.autoEula && !/eula=true/.test(fs.readFileSync(eula, 'utf8'))) {
      fs.writeFileSync(eula, fs.readFileSync(eula, 'utf8').replace(/eula\s*=\s*false/, 'eula=true'), 'utf8');
    }
    writeServerProperties(inst);
    for (const sub of ['mods', 'logs', 'config']) { try { fs.mkdirSync(path.join(inst.dir, sub), { recursive: true }); } catch { /* ignore */ } }
  }

  send(id, line) {
    const rt = this.runtimes.get(id);
    if (!rt || !rt.child || rt.child.exitCode !== null || !['starting', 'running', 'restarting'].includes(rt.state)) {
      throw new Error('服务器没在运行，命令没法发送');
    }
    return new Promise((resolve) => {
      rt.child.stdin.write(line.endsWith('\n') ? line : line + '\n', (e) => resolve(!e));
    });
  }

  async stop(id, { force = false } = {}) {
    const rt = this.runtimes.get(id);
    if (!rt) return { ok: true, note: '没有正在运行的进程' };
    rt.userStop = true;
    const graceful = this.repo.graceful !== false;
    if (force || !graceful) {
      if (!force) this.pushLine(rt, `[启动器] ${this.repo.label}没有 stop 指令接口，直接结束进程`);
      try {
        await new Promise((resolve) => {
          const a = spawn('taskkill', ['/pid', String(rt.child.pid), '/T', '/F'], { windowsHide: true });
          a.on('close', resolve);
          a.on('error', resolve);
        });
      } catch { /* ignore */ }
      return { ok: true, note: '已强制结束进程树' };
    }
    this.pushLine(rt, '[启动器] 发送 stop 指令，等待世界保存…');
    try { rt.child.stdin.write('stop\n'); } catch { /* ignore */ }
    const died = await waitClose(rt, 60000);
    if (!died) {
      this.pushLine(rt, '[启动器] 60 秒没退干净，强制结束');
      return this.stop(id, { force: true });
    }
    return { ok: true, note: '已正常关闭' };
  }

  tailOf(id, n = 400) {
    const rt = this.runtimes.get(id);
    return rt ? rt.tail.slice(-n) : [];
  }

  // 立即强杀所有子进程树（退出时用户选"直接退出"）
  killAll() {
    for (const rt of this.runtimes.values()) {
      if (!rt.child || rt.child.exitCode !== null) continue;
      rt.userStop = true;
      if (rt.restartTimer) clearTimeout(rt.restartTimer);
      try { spawn('taskkill', ['/pid', String(rt.child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ }
    }
    return this.runningCount();
  }

  // 逐个发 stop 并等待，最长 graceMs；超时的强制结束
  async stopAll(graceMs = 20000) {
    const ids = [...this.runtimes.keys()];
    await Promise.all(ids.map(async (id) => {
      const rt = this.runtimes.get(id);
      if (!rt || !rt.child || rt.child.exitCode !== null) return;
      rt.userStop = true;
      if (rt.restartTimer) clearTimeout(rt.restartTimer);
      try { rt.child.stdin.write('stop\n'); } catch { /* ignore */ }
      const died = await waitClose(rt, graceMs);
      if (!died) { try { spawn('taskkill', ['/pid', String(rt.child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* ignore */ } }
    }));
    return { stopped: ids.length };
  }
}

function closeStream(rt) {
  try { if (rt.logStream && !rt.logStream.writableEnded) rt.logStream.end(); } catch { /* noop */ }
  rt.logStream = null;
}

function waitClose(rt, ms) {
  return new Promise((resolve) => {
    if (rt.child.exitCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    rt.child.once('close', () => { clearTimeout(t); resolve(true); });
  });
}

// server.properties：读原文 -> 覆盖已知键 -> 写回（保留用户手加的未知键）
const PROP_KEYS = {
  port: (i) => i.port,
  'online-mode': (i) => (i.onlineMode ? 'true' : 'false'),
  'max-players': (i) => i.maxPlayers,
  motd: (i) => i.motd,
  'level-name': (i) => i.levelName,
  difficulty: (i) => i.difficulty,
  'view-distance': (i) => i.viewDistance,
  gamemode: (i) => i.gamemode,
};

const PROP_HEADER = '# 以下项目由启动器界面维护（改这些请用界面，手改会被覆盖）';

function writeServerProperties(inst) {
  const file = path.join(inst.dir, 'server.properties');
  const exist = fs.existsSync(file);
  const text = exist ? fs.readFileSync(file, 'utf8') : '';
  const nl = /\r\n/.test(text) ? '\r\n' : '\n';
  const set = new Map();
  for (const [k, fn] of Object.entries(PROP_KEYS)) set.set(k, String(fn(inst) ?? ''));
  const outLines = [];
  const used = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === PROP_HEADER) continue;
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && set.has(m[1].trim())) {
      outLines.push(`${m[1].trim()}=${set.get(m[1].trim())}`);
      used.add(m[1].trim());
      continue;
    }
    outLines.push(line);
  }
  while (outLines.length && outLines[outLines.length - 1] === '') outLines.pop();
  const extra = [...set].filter(([k]) => !used.has(k));
  const body = extra.length ? [...outLines, '', PROP_HEADER, ...extra.map(([k, v]) => `${k}=${v}`)] : outLines;
  fs.writeFileSync(file, body.join(nl), 'utf8');
}

function readServerProperties(dir) {
  const file = path.join(dir, 'server.properties');
  if (!fs.existsSync(file)) return null;
  const map = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) map[m[1].trim()] = m[2];
  }
  return map;
}

module.exports = { ServerManager, readServerProperties, writeServerProperties, sanitizeName };
