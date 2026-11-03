'use strict';
// 下载引擎：并发队列 + 断点续传 + sha1 校验 + 镜像回退 + 进度事件 + 取消。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { mirrorUrls } = require('./minecraft');

const REDIRECT = [301, 302, 303, 307, 308];

function openLike(url, opts, cb) {
  const mod = url.startsWith('http:') ? http : https;
  const req = mod.get(url, { headers: { 'user-agent': 'MCLauncher/1.0', ...opts.headers }, timeout: opts.timeout || 45000 }, cb);
  req.on('error', cb);
  req.on('timeout', () => req.destroy(new Error('timeout')));
  return req;
}

// 跟随重定向地拿到响应流（offset 用于续传）
function openStream(url, { offset = 0, signal, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    let settled = false;
    const run = (u, depth) => {
      if (settled) return;
      const req = openLike(u, { headers: offset ? { Range: `bytes=${offset}-` } : {}, timeout }, (res) => {
        if (REDIRECT.includes(res.statusCode) && res.headers.location && depth < 6) {
          res.resume();
          return run(new URL(res.headers.location, u).toString(), depth + 1);
        }
        if (res.statusCode >= 400) {
          res.resume();
          return finish(new Error(`HTTP ${res.statusCode} ${u}`));
        }
        finish(null, res, u);
      });
      const finish = (err, res, finalUrl) => {
        if (settled) return;
        settled = true;
        if (signal) signal.addEventListener('abort', () => { req.destroy(); res && res.destroy(); }, { once: true });
        err ? reject(err) : resolve({ res, finalUrl });
      };
      req.on('error', (e) => finish(e));
    };
    run(url, 0);
  });
}

async function readBody(url, opts = {}) {
  const { res } = await openStream(url, opts);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

async function getJson(url, mirrorId) {
  for (const u of mirrorUrls(url, mirrorId)) {
    try {
      const buf = await readBody(u);
      return JSON.parse(buf.toString('utf8'));
    } catch (e) { /* 换下一个候选源 */ }
  }
  throw new Error(`无法获取元数据: ${url}`);
}

function hashFile(file, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

// 单个文件下载：candidates 已经排好优先级（镜像在前，官方兜底）
async function downloadFile(target, opts) {
  const { candidates, sha1, sha256, size = 0, signal, onProgress, chunkTimeout } = opts;
  const algo = sha256 ? 'sha256' : 'sha1';
  const expect = sha256 || sha1 || null;
  await fsp.mkdir(path.dirname(target), { recursive: true });

  if (fs.existsSync(target)) {
    if (!expect) { return { skipped: true, file: target }; }
    if ((await hashFile(target, algo)) === expect) return { skipped: true, file: target, verified: true };
    await fsp.rm(target, { force: true });
  }

  const part = target + '.part';
  let lastErr;
  for (const url of candidates) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (signal && signal.aborted) throw new Error('aborted');
      let offset = fs.existsSync(part) ? fs.statSync(part).size : 0;
      // 上次中断留下的 .part 可能已经完整：越界续传会被服务端 416 拒绝，先直接校验
      if (offset && expect) {
        try {
          if ((await hashFile(part, algo)) === expect) {
            await fsp.rename(part, target);
            return { file: target, bytes: offset, from: url, recovered: true };
          }
        } catch { /* 下面正常下载 */ }
      }
      if (size && offset > size) { await fsp.rm(part, { force: true }); offset = 0; }
      try {
        const { res } = await openStream(url, { offset, signal, timeout: chunkTimeout || 60000 });
        const acceptRange = res.statusCode === 206;
        if (offset && !acceptRange) { await fsp.rm(part, { force: true }); offset = 0; }
        const total = (acceptRange ? offset : 0) + parseInt(res.headers['content-length'] || '0', 10) || size;
        const stream = fs.createWriteStream(part, { flags: 'a' });
        let done = offset;
        // 取消要立刻断流：只在每轮 attempt 开头查 signal 的话，正在传的那个文件会偷偷下完
        const failErr = () => (signal && signal.aborted ? new Error('aborted') : new Error('传输中断'));
        const onAbort = () => { try { stream.destroy(); } catch { /* 已经关了 */ } try { res.destroy(); } catch { /* 已经关了 */ } };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        // 停顿看门狗：连上了但不传数据时不能永远等下去（镜像常见）
        let stall = null;
        const armStall = () => {
          clearTimeout(stall);
          stall = setTimeout(() => {
            res.destroy(new Error('stalled'));
          }, 25000);
        };
        armStall();
        res.on('data', (c) => {
          done += c.length;
          armStall();
          if (onProgress) onProgress(done, total);
        });
        res.pipe(stream);
        try {
          await new Promise((resolve, reject) => {
            stream.on('finish', () => { clearTimeout(stall); resolve(); });
            // 没写完就被关掉（取消、断流、看门狗）一律算失败，绝不能当成下好了
            stream.on('close', () => { if (!stream.writableFinished) { clearTimeout(stall); reject(failErr()); } });
            stream.on('error', (e) => { clearTimeout(stall); reject(e); });
            res.on('aborted', () => { clearTimeout(stall); reject(failErr()); });
            res.on('error', (e) => { clearTimeout(stall); reject(e); });
          });
        } finally {
          clearTimeout(stall);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
        if (signal && signal.aborted) throw new Error('aborted');
        const expected = total || size;
        if (expected && done < expected) throw new Error(`传输中断 ${done}/${expected}`);
        if (expect) {
          const got = await hashFile(part, algo);
          if (got !== expect) { await fsp.rm(part, { force: true }); throw new Error(`校验失败 ${path.basename(target)} ${algo}=${got.slice(0, 8)}`); }
        }
        await fsp.rename(part, target);
        return { file: target, bytes: done, from: url };
      } catch (e) {
        lastErr = e;
        if (e && e.message === 'aborted') throw e;
        if (/416/.test(String(e && e.message))) await fsp.rm(part, { force: true }); // Range 越界：清掉重来
        if (fs.existsSync(part) && fs.statSync(part).size === 0 && attempt > 1) await fsp.rm(part, { force: true });
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  throw new Error(`下载失败 ${path.basename(target)}: ${lastErr && lastErr.message}`);
}

class DownloadQueue {
  // label/meta 会让任务自动登记到 jobs，界面就能看到进度、速度、剩余时间并可取消
  constructor({ concurrency = 8, mirrorId = 'official', onEvent, label = '', meta = {} } = {}) {
    this.concurrency = concurrency;
    this.mirrorId = mirrorId;
    this.onEvent = onEvent || (() => {});
    this.tasks = [];
    this.active = 0;
    this.controller = new AbortController();
    this.totalBytes = 0;
    this.doneBytes = 0;
    this.bytesMoved = 0;
    this.finished = 0;
    this.label = label;
  }

  register(meta = {}) {
    if (!this.job) this.job = require('./jobs').track(this, this.label, meta);
    return this.job;
  }

  add(task) {
    // task: { name, target, url | candidates, sha1, size, lib }
    this.tasks.push({ ...task, state: 'pending', done: 0 });
    this.totalBytes += task.size || 0;
    return task;
  }

  async run() {
    const jobs = require('./jobs');
    const job = this.register();
    jobs.begin(job);
    const errors = [];
    try {
      const next = async () => {
        const t = this.tasks.find((x) => x.state === 'pending');
        if (!t) return;
        t.state = 'running';
        this.active++;
        this.onEvent({ type: 'start', name: t.name });
        try {
          const candidates = t.candidates || mirrorUrls(t.url, this.mirrorId);
          const r = await downloadFile(t.target, {
            candidates, sha1: t.sha1, sha256: t.sha256, size: t.size, signal: this.controller.signal,
            onProgress: (done, total) => {
              const delta = done - (t.done || 0);
              t.done = done;
              if (delta > 0) this.bytesMoved += delta;
              this.onEvent({ type: 'file', name: t.name, done, total: total || t.size || 0 });
            },
          });
          t.state = r.skipped ? 'cached' : 'done';
          this.doneBytes += t.size || t.done || 0;
          this.finished++;
          this.onEvent({ type: t.state, name: t.name });
        } catch (e) {
          if (e.message === 'aborted') { t.state = 'cancelled'; }
          else { t.state = 'error'; t.error = e.message; errors.push(`${t.name}: ${e.message}`); }
          this.finished++;
          this.onEvent({ type: 'error', name: t.name, message: e.message });
        } finally {
          this.active--;
        }
        return next();
      };
      await Promise.all(Array.from({ length: this.concurrency }, next));
    } finally {
      job.files = this.tasks.filter((t) => ['done', 'cached', 'error'].includes(t.state)).length;
      job.bytes = this.doneBytes;
      job.errors = errors.slice();
      jobs.finish(job, { cancelled: this.controller.signal.aborted, errors });
    }
    return { errors, cancelled: this.controller.signal.aborted };
  }

  cancel() { this.controller.abort(); }
}

module.exports = { openStream, readBody, getJson, hashFile, downloadFile, DownloadQueue };
