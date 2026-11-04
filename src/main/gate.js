'use strict';
// 入口级闸门：同一件事同一时刻只跑一份。
// 为什么不能只靠界面禁用按钮：下载列表会被筛选、切类型、别的任务完成后 refreshLocal 等动作重绘，
// 重绘后那颗按钮又变回可点；而"下载管理"里的任务行也一样会重复长出来。
// 更要命的是安装器类操作（Forge 会起一个 java 子进程往同一个目录写），并发跑等于互相踩。

class Gate {
  constructor() {
    this.running = new Map();
  }

  // key 相同的并发调用只执行一次 fn，后来者拿到同一份结果（成功或失败都一样）
  run(key, fn) {
    const hit = this.running.get(key);
    if (hit) return hit;
    const done = Promise.resolve().then(fn);
    const wrapped = done.finally(() => this.running.delete(key));
    this.running.set(key, wrapped);
    // 后来者可能没人接住 rejection，这里先挂一个空的 catch 防止进程级 unhandledRejection
    wrapped.catch(() => { /* 调用方自己处理 */ });
    return wrapped;
  }

  has(key) { return this.running.has(key); }
  keys() { return [...this.running.keys()]; }
}

module.exports = { Gate };
