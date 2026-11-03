'use strict';
// 检查更新：两条线
// 1) RCL 自身 —— 读设置里配置的更新源（一个 JSON），比对版本号
// 2) MC 内容 —— 比对 Mojang 清单的最新版本、已装版本的 Paper 新构建（这条开箱即用）

const { getJson } = require('./downloader');

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

class Updater {
  constructor({ store, catalog, remote }) {
    this.store = store;
    this.catalog = catalog;
    this.remote = remote;
    this.lastMcCheck = null;
  }

  // RCL 自身更新：feed 形如 { version: "1.0.3", url: "https://.../RCL-Setup-1.0.3.exe", notes: "...", date: "..." }
  async checkSelf({ refresh = false } = {}) {
    const feed = (this.store.settings.updateFeed || '').trim();
    if (!feed) {
      return { configured: false, current: this.store.settings.appVersion, hint: '还没配置更新源。在「设置 → RCL 更新源」填一个返回 JSON 的地址（自己的网盘/服务器/GitHub Raw 都行）。' };
    }
    try {
      const j = await getJson(feed, 'official');
      const latest = j.version || j.tag_name || '';
      return {
        configured: true,
        feed,
        current: this.store.settings.appVersion,
        latest,
        hasUpdate: !!latest && cmpVersion(latest, this.store.settings.appVersion) < 0,
        url: j.url || j.downloadUrl || (j.assets && j.assets[0] && j.assets[0].browser_download_url) || '',
        notes: j.notes || j.body || '',
        date: j.date || j.published_at || '',
      };
    } catch (e) {
      return { configured: true, feed, error: `更新源读取失败：${e.message}`, current: this.store.settings.appVersion, hasUpdate: false };
    }
  }

  // MC 内容更新：最新正式版/快照 + 已装版本有没有新 Paper 构建
  async checkMc({ refresh = false } = {}) {
    const out = { mcLatest: null, installed: [], paperUpdates: [], fabricNote: '', errors: [] };
    let m;
    try {
      m = await this.remote.versionList({ refresh });
      const rel = m.versions.filter((v) => v.type === 'release');
      const snap = m.versions.filter((v) => v.type === 'snapshot');
      out.mcLatest = { release: rel[0] ? rel[0].id : null, snapshot: snap[0] ? snap[0].id : null };
    } catch (e) {
      out.errors.push('版本清单：' + e.message);
    }
    const local = this.catalog.localInfo();
    out.installed = local.versions.map((v) => ({ mc: v.mc, bytes: v.bytes, server: !!v.server, client: !!v.client }));
    const newestRelease = out.mcLatest && out.mcLatest.release;
    out.canUpdateMc = newestRelease && !local.versions.some((v) => v.mc === newestRelease) ? newestRelease : null;

    for (const p of local.paper || []) {
      if (!p.ready) continue;
      try {
        const meta = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(p.mc)}`, this.store.settings.mirror);
        const newest = (meta.builds || [])[0];
        if (newest && String(newest) !== String(p.build)) out.paperUpdates.push({ mc: p.mc, from: p.build, to: newest });
      } catch (e) { out.errors.push(`Paper ${p.mc}：${e.message}`); }
    }
    return out;
  }
}

module.exports = { Updater, cmpVersion };
