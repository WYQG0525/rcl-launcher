'use strict';
// 登录方式：离线 / 微软正版（设备码）/ authlib-injector 第三方（LittleSkin 等）
// 凭据用 Electron safeStorage（Windows 上是 DPAPI）加密后落盘。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safeStorage } = require('electron');
const { getJson, readBody } = require('./downloader');

const MS_AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const XBL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS = 'https://xauth.xboxlive.com/relyingparty-authorize';
const LIVE_TOKEN = 'https://login.live.com/oauth20_token.srf';
const MC_SERVICES = 'https://api.minecraftservices.com';
const AAI_LATEST = 'https://authlib-injector.yushi.moe/artifact/latest.json';

const AAI_PRESETS = [
  { id: 'littleskin', name: 'LittleSkin', root: 'https://littleskin.cn/authlib' },
  { id: 'elyby', name: 'Ely.by', root: 'https://auth.ely.by/api/external/authlib-injector/v1' },
  { id: '4a', name: '4A Skin Server', root: 'https://skin.4a.im/authlib-injector' },
];

function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const mod = require('node:https');
    const req = mod.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': typeof body === 'string' ? 'application/json' : 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data), 'user-agent': 'RCL/1.0', ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${buf.slice(0, 200)}`));
        try { resolve(JSON.parse(buf)); } catch { reject(new Error('返回不是 JSON：' + buf.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('超时')));
    req.write(data);
    req.end();
  });
}

class Auth {
  constructor({ dirs }) {
    this.dirs = dirs;
    this.file = path.join(dirs.root, 'accounts.json');
    this.vault = readJsonSafe(this.file, {});
  }

  _encrypt(text) {
    try {
      if (safeStorage && safeStorage.isEncryptionAvailable()) return { enc: safeStorage.encryptString(text).toString('base64') };
    } catch { /* 退化成明文 */ }
    return { plain: text };
  }

  _decrypt(blob) {
    if (!blob) return null;
    if (blob.plain) return blob.plain;
    try { return safeStorage.decryptString(Buffer.from(blob.enc, 'base64')); } catch { return null; }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.vault, null, 2));
  }

  list() {
    return Object.entries(this.vault).map(([k, v]) => ({
      key: k, type: v.type, name: v.name, uuid: v.uuid,
      hasToken: !!(v.token || (v.tokenBlob && (v.tokenBlob.enc || v.tokenBlob.plain))),
      aaiRoot: v.aaiRoot || null,
      msRefresh: !!(v.refresh && (v.refresh.enc || v.refresh.plain)),
      savedAt: v.savedAt,
    }));
  }

  get(key) {
    const v = this.vault[key];
    if (!v) return null;
    return { ...v, token: v.token || this._decrypt(v.tokenBlob), refresh: this._decrypt(v.refresh) };
  }

  put(key, data) {
    const { token, refresh, ...rest } = data;
    this.vault[key] = {
      ...this.vault[key], ...rest,
      tokenBlob: token ? this._encrypt(token) : this.vault[key] && this.vault[key].tokenBlob,
      refresh: refresh ? this._encrypt(refresh) : this.vault[key] && this.vault[key].refresh,
      savedAt: Date.now(),
    };
    if (!this.vault[key].tokenBlob) delete this.vault[key].token;
    this.save();
    return this.get(key);
  }

  remove(key) { delete this.vault[key]; this.save(); return true; }

  // ---------- 离线 ----------
  offline(name) {
    return { type: 'offline', name, uuid: offlineUuid(name), token: '00000000000000000000000000000000', userType: 'legacy' };
  }

  // ---------- authlib-injector（LittleSkin 等第三方）----------
  async ensureInjector() {
    const dest = path.join(this.dirs.store || path.dirname(this.dirs.libraries), 'authlib-injector.jar');
    if (fs.existsSync(dest)) return dest;
    const latest = await getJson(AAI_LATEST, 'official');
    if (!latest.download_url) throw new Error('authlib-injector 没给下载地址');
    const { downloadFile } = require('./downloader');
    const r = await downloadFile(dest, { candidates: [latest.download_url], sha256: latest.checksums && latest.checksums.sha256, size: 0 });
    if (!r.file) throw new Error('authlib-injector 下载失败');
    return dest;
  }

  // ---------- 微软正版（设备码流程）----------
  async msDeviceLogin(clientId, { onCode } = {}) {
    if (!clientId) throw new Error('需要 Azure 应用的客户端 ID（在设置里填，申请地址 https://portal.azure.com → App registrations）');
    const dc = await postJson(`${MS_AUTHORITY}/devicecode`, { client_id: clientId, scope: 'XboxLive.signin offline_access' });
    if (onCode) onCode(dc);
    const tok = await this._msPollToken(clientId, dc);
    const xbl = await postJson(XBL, JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'userauth', RpsTicket: `d=${tok.access_token}` },
      EndpointType: 'RDA', ElementType: 'RST', Version: '1.3',
    }), { 'content-type': 'application/json' });
    const xsts = await postJson(XSTS, JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token], RpsTicket: 'd=' },
      EndpointType: 'RDA', ElementType: 'RST', Version: '1.0',
    }), { 'content-type': 'application/json' });
    const live = await postJson(LIVE_TOKEN, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: xsts.Token, client_id: clientId, redirect_uri: dc.redirect_uri || 'https://game.xiaomi.com' });
    const mc = await postJson(`${MC_SERVICES}/launcher/login`, JSON.stringify({ xuid: xbl.DisplayClaims.xuid[0], xboxToken: xsts.Token }), { 'content-type': 'application/json', Authorization: `Bearer ${live.access_token}` });
    const ent = await this._msGet(`${MC_SERVICES}/entitlements/mcstore`, mc.access_token);
    const ownsGame = (ent.items || []).some((i) => i.skuType === 'PRODUCT_MINECRAFT' || /minecraft/i.test(i.name || '')) || (ent.products || []).length > 0;
    const prof = await this._msGet(`${MC_SERVICES}/minecraft/profile`, mc.access_token);
    if (!prof.id) throw new Error(ownsGame ? '没取到档案，去启动器里选一下角色' : '这个账号没有 Minecraft 正版，去 https://www.minecraft.net 购买');
    const name = prof.name || prof.selectedProfile?.name;
    const uuid = prof.id || prof.selectedProfile?.id;
    const skin = ((prof.skins || []).find((s) => s.state === 'UPLOADED') || {}).url || null;
    const cape = ((prof.capes || []).find((c) => c.state === 'UPLOADED') || {}).url || null;
    this.put(`ms:${name}`, { type: 'microsoft', name, uuid, token: mc.access_token, refresh: live.refresh_token, clientId, ownsGame, skin, cape });
    return { type: 'microsoft', name, uuid, token: mc.access_token, userType: 'msa', skin, cape, ownsGame };
  }

  async _msPollToken(clientId, dc, timeoutMs = 600000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, (dc.interval || 5) * 1000));
      try {
        return await postJson(`${MS_AUTHORITY}/token`, { client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: dc.device_code });
      } catch (e) {
        const m = String(e.message);
        if (/authorization_pending/i.test(m)) continue;
        if (/slow_down/i.test(m)) continue;
        if (/expired_token/i.test(m)) throw new Error('设备码过期了，重新登录');
        throw e;
      }
    }
    throw new Error('等待登录超时（10 分钟）');
  }

  async _msGet(url, token) {
    const buf = await readBody(url, { headers: { Authorization: `Bearer ${token}`, 'user-agent': 'RCL/1.0' } });
    return JSON.parse(buf.toString('utf8'));
  }

  // 用 refresh_token 续期（下次启动不用再扫码）
  async msRefresh(key) {
    const acct = this.get(key);
    if (!acct || !acct.refresh) throw new Error('没有可续期的微软凭据，重新登录一次');
    const live = await postJson(LIVE_TOKEN, { grant_type: 'refresh_token', scope: 'XboxLive.signin offline_access', client_id: acct.clientId, refresh_token: acct.refresh });
    const xbl = await postJson(XBL, JSON.stringify({ Properties: { AuthMethod: 'RPS', SiteName: 'userauth', RpsTicket: `d=${live.access_token}` }, EndpointType: 'RDA', ElementType: 'RST', Version: '1.3' }), { 'content-type': 'application/json' });
    const xsts = await postJson(XSTS, JSON.stringify({ Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token], RpsTicket: 'd=' }, EndpointType: 'RDA', ElementType: 'RST', Version: '1.0' }), { 'content-type': 'application/json' });
    const mc = await postJson(`${MC_SERVICES}/launcher/login`, JSON.stringify({ xuid: xbl.DisplayClaims.xuid[0], xboxToken: xsts.Token }), { 'content-type': 'application/json', Authorization: `Bearer ${live.access_token}` });
    this.put(key, { token: mc.access_token, refresh: live.refresh_token });
    return this.get(key);
  }
}

function readJsonSafe(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }

module.exports = { Auth, offlineUuid, AAI_PRESETS };
