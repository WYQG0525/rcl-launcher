'use strict';
// preload：只暴露白名单方法，界面拿不到 node 能力

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const api = {
  info: call('app:info'),
  settingsGet: call('settings:get'),
  settingsSet: call('settings:set'),
  openExternal: call('app:openExternal'),

  // 服务器实例
  instancesList: call('instances:list'),
  instancesCreate: call('instances:create'),
  instancesPatch: call('instances:patch'),
  instancesRemove: call('instances:remove'),
  instancesOpen: call('instances:open'),
  instancesPlan: call('instances:plan'),
  serverStart: call('server:start'),
  serverStop: call('server:stop'),
  serverSend: call('server:send'),
  serverStates: call('server:states'),
  serverTail: call('server:tail'),
  propsRead: call('props:read'),
  propsWriteRaw: call('props:writeRaw'),
  opsList: call('ops:list'),
  opsSet: call('ops:set'),
  playersSeen: call('players:seen'),
  backupCreate: call('backup:create'),
  backupList: call('backup:list'),
  backupOpenFolder: call('backup:openFolder'),

  // 游戏档案
  gamesList: call('games:list'),
  gamesCreate: call('games:create'),
  gamesPatch: call('games:patch'),
  gamesRemove: call('games:remove'),
  gamesOpen: call('games:open'),
  gamesProbe: call('games:probe'),
  gamesImport: call('games:import'),
  modpackPick: call('modpack:pick'),
  modpackSummarize: call('modpack:summarize'),
  modpackInstall: call('modpack:install'),
  modpackInstallUrl: call('modpack:installUrl'),
  gameStart: call('game:start'),
  gameStop: call('game:stop'),
  gameStates: call('game:states'),
  gamePlan: call('game:plan'),
  clientStatus: call('dl:clientStatus'),

  // 下载
  dlVersions: call('dl:versions'),
  dlInstallServer: call('dl:installServer'),
  dlInstallClient: call('dl:installClient'),
  dlInstallPaper: call('dl:installPaper'),
  dlInstallFabric: call('dl:installFabric'),
  dlListPaper: call('dl:listPaper'),
  dlListFabric: call('dl:listFabric'),
  dlListForge: call('dl:listForge'),
  dlInstallForge: call('dl:installForge'),
  dlListNeoForge: call('dl:listNeoForge'),
  dlInstallNeoForge: call('dl:installNeoForge'),
  dlInstallLoaderClient: call('dl:installLoaderClient'),
  dlDeletePreview: call('dl:deletePreview'),
  dlPurgeVersion: call('dl:purgeVersion'),
  dlUninstall: call('dl:uninstall'),
  dlLocal: call('dl:local'),

  // 下载管理
  jobsList: call('jobs:list'),
  jobsCancel: call('jobs:cancel'),
  jobsCancelAll: call('jobs:cancelAll'),
  jobsClearDone: call('jobs:clearDone'),

  // 检查更新与磁盘回收
  updateSelf: call('update:self'),
  updateMc: call('update:mc'),
  dlCleanOrphans: call('dl:cleanOrphans'),

  // 内容（模组 / 光影 / 材质）
  contentSearch: call('content:search'),
  contentFiles: call('content:files'),
  contentToInstance: call('content:toInstance'),

  // 登录
  authList: call('auth:list'),
  authRemove: call('auth:remove'),
  authMsLogin: call('auth:msLogin'),
  authMsRefresh: call('auth:msRefresh'),
  authEnsureInjector: call('auth:ensureInjector'),

  // Java 与文件
  javaList: call('java:list'),
  javaBrowse: call('java:browse'),
  javaDownload: call('java:download'),
  pickFolder: call('fs:pickFolder'),
  pickJar: call('fs:pickJar'),
  modsList: call('mods:list'),
  modsOpen: call('mods:openFolder'),
  modsImport: call('mods:import'),
  checkPort: call('net:checkPort'),

  // 窗口与托盘
  confirmQuit: call('app:confirmQuit'),
  cancelQuit: call('app:cancelQuit'),
  closeChoice: call('app:closeChoice'),
  hideToTray: call('app:hideToTray'),
  stopAllNow: call('app:stopAllNow'),

  onConsole: (cb) => on('console', cb),
  onServerState: (cb) => on('server-state', cb),
  onGameState: (cb) => on('game-state', cb),
  onInstallProgress: (cb) => on('install-progress', cb),
  onInstallLog: (cb) => on('install-log', cb),
  onJobs: (cb) => on('jobs-update', cb),
  onDeviceCode: (cb) => on('auth-device-code', cb),
  onAskQuit: (cb) => on('app-ask-quit', cb),
  onAskClose: (cb) => on('app-ask-close', cb),
};

function on(channel, cb) {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}

contextBridge.exposeInMainWorld('mcl', api);
