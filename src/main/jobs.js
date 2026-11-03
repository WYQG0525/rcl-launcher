'use strict';
// 下载任务登记处：每个 DownloadQueue 注册成一个 job，统一给界面提供进度、速度、剩余时间与取消。

const { EventEmitter } = require('node:events');

const KEEP_DONE = 60;   // 已完成任务最多留多少条，太多会拖慢界面

class JobRegistry extends EventEmitter {
  constructor() {
    super();
    this.jobs = [];
    this.queues = new Map();
    this.seq = 0;
    this._timer = null;
    this._dirty = false;
  }

  track(queue, label, meta = {}) {
    this.seq++;
    const job = {
      id: `j${this.seq}`,
      label: label || meta.label || `任务 ${this.seq}`,
      kind: meta.kind || 'download',
      version: meta.version || '',
      state: 'queued',
      files: 0,
      totalFiles: queue.tasks.length,
      bytes: 0,
      totalBytes: queue.totalBytes || 0,
      speed: 0,
      current: '',
      errors: [],
      startedAt: null,
      endedAt: null,
      createdAt: Date.now(),
    };
    this.jobs.push(job);
    if (this.jobs.length > KEEP_DONE * 3) this.gc();

    let lastBytes = 0;
    let lastAt = Date.now();
    const origEvent = queue.onEvent;
    queue.onEvent = (ev) => {
      if (typeof origEvent === 'function') { try { origEvent(ev); } catch { /* 上层回调出错不能拖垮下载 */ } }
      // 任务边跑边追加时，总数跟着走，否则百分比和剩余时间是错的
      if (queue.tasks.length !== job.totalFiles) job.totalFiles = queue.tasks.length;
      if (queue.totalBytes !== job.totalBytes) job.totalBytes = queue.totalBytes;
      if (ev.type === 'file') {
        job.current = ev.name;
        job.bytes = Math.max(job.bytes, queue.doneBytes + (ev.done || 0));
      } else if (ev.type === 'done' || ev.type === 'cached') {
        job.files++;
        job.bytes = queue.doneBytes;
        if (ev.type === 'cached') job.cachedFiles = (job.cachedFiles || 0) + 1;
      } else if (ev.type === 'error') {
        job.files++;
        job.errors.push(`${ev.name}: ${ev.message}`);
      }
      const now = Date.now();
      if (now - lastAt >= 500) {
        job.speed = (job.bytes - lastBytes) / ((now - lastAt) / 1000);
        lastBytes = job.bytes;
        lastAt = now;
      }
      this.touch();
    };

    // 队列自己会在开始/结束时回调 begin/finish，这里只负责登记与转发进度
    queue.job = job;
    this.queues.set(job.id, queue);
    return job;
  }

  begin(job) {
    if (!job) return;
    const q = this.queues.get(job.id);
    if (q) { job.totalFiles = q.tasks.length; job.totalBytes = q.totalBytes || job.totalBytes; }
    job.state = 'running';
    job.startedAt = Date.now();
    this.touch();
  }

  finish(job, { cancelled = false, errors = [] } = {}) {
    if (!job) return;
    job.state = cancelled ? 'cancelled' : (errors.length ? 'error' : 'done');
    job.endedAt = Date.now();
    job.speed = 0;
    this.touch();
  }

  // 合并高频更新，最多每 200ms 推一次给界面
  touch() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this._dirty) return;
      this._dirty = false;
      this.emit('update', this.snapshot());
    }, 200);
    if (this._timer.unref) this._timer.unref();
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;
    if (job.state === 'done' || job.state === 'cancelled') return false;
    const q = this.queues.get(id);
    if (q && typeof q.cancel === 'function') q.cancel();
    job.state = 'cancelled';
    job.endedAt = Date.now();
    this.touch();
    return true;
  }

  cancelAll() {
    return this.jobs.filter((j) => ['queued', 'running'].includes(j.state)).map((j) => this.cancel(j.id)).filter(Boolean).length;
  }

  clearDone() {
    this.jobs = this.jobs.filter((j) => !['done', 'cancelled', 'error'].includes(j.state));
    this.touch();
    return this.jobs.length;
  }

  snapshot() {
    const list = this.jobs.slice().reverse();
    const active = list.filter((j) => j.state === 'running' || j.state === 'queued');
    return {
      jobs: list.map((j) => ({
        ...j,
        eta: j.speed > 0 && j.totalBytes > j.bytes ? Math.round(((j.totalBytes - j.bytes) / j.speed) * 1000) : null,
        elapsed: j.startedAt ? (j.endedAt || Date.now()) - j.startedAt : 0,
        errors: j.errors.slice(0, 6),
        errorCount: j.errors.length,
      })),
      active: active.length,
      done: list.filter((j) => j.state === 'done').length,
      failed: list.filter((j) => j.state === 'error').length,
      speed: active.reduce((s, j) => s + (j.speed || 0), 0),
      bytes: active.reduce((s, j) => s + j.bytes, 0),
      totalBytes: active.reduce((s, j) => s + (j.totalBytes || 0), 0),
    };
  }

  gc() {
    const done = this.jobs.filter((j) => ['done', 'cancelled', 'error'].includes(j.state));
    if (done.length > KEEP_DONE) {
      const cut = done.slice(0, done.length - KEEP_DONE).map((j) => j.id);
      this.jobs = this.jobs.filter((j) => !cut.includes(j.id));
    }
  }
}

// 单例：下载队列在构造时自己登记进来，界面只订阅这一个事件源
module.exports = new JobRegistry();
