# RCL

一个 Windows 上的 Minecraft 启动器，界面思路照 PCL2：**启动游戏**和**开服务器**是两个独立页面，程序本体不内置任何 MC 文件——版本、核心、Java、资源、模组全部按需下载，所以安装包只有 116MB。

用 Electron 写的，没有运行时依赖（zip 解析、bundler 解包都是手写的），只有 devDependencies 里的 electron 和 electron-builder。

## 能做什么

**开服务器**
- 原版服务端（自动处理 Mojang 的 bundler 格式，内嵌依赖解一次全实例共用）、Paper、Fabric、Forge
- 控制台实时日志、发指令、优雅停止、崩溃自动重启、server.properties 图形化编辑、世界备份
- 每个服独立目录、独立内存与 Java 版本

**启动游戏**
- 三种登录：离线 / 微软正版（设备码登录，XBL→XSTS→launcher 全流程）/ authlib-injector 第三方（LittleSkin 等，登录框在游戏里弹）
- 令牌用系统 DPAPI（`safeStorage`）加密存本地，明文不落盘
- 每个档案独立游戏目录，可选窗口尺寸、全屏、直连服务器、额外 JVM/游戏参数
- 游戏参数严格按版本 profile 声明拼装，不硬编码

**下载**
- 任何 Mojang 清单里的版本都能取（不限固定几个），正式版/快照/旧 Beta 都能筛
- 整合包：直接搜 Modrinth，不用填版本，点一条列出它全部版本，选一个装成新档案（`.mrpack` 的模组文件按 sha1 校验，覆盖配置自动铺，服务端专用文件跳过）
- 模组 / 光影 / 材质包：Modrinth 免密钥可用；CurseForge 需要自己的 API Key（社区免密钥镜像已全部失效）
- Java 运行时按需下载（清华 Adoptium 镜像优先，回落官方）
- 默认走 BMCLAPI 镜像，设置里可换，任何一步失败自动回落官方源
- 删除版本时能顺带回收不再被任何档案使用的共享库，并清掉空目录

**下载管理**
- 所有下载任务集中一页：进度、速度、剩余时间、当前文件、已完成/失败数
- 可单个取消、全部取消；取消会真的断流，已下的部分留作 `.part` 续传

**其它**
- 系统托盘：叉掉可以后台运行，也可以设置成直接退出，支持"记住选择"
- 检查更新：比对最新 MC 版本与已装版本的 Paper 新构建；RCL 自身更新需要在设置里填一个返回 JSON 的更新源地址
- 导入已有游戏目录：只在原地建档案，不复制不移动；删档案（哪怕勾了删文件）也不会碰你的目录

## 开发

```bash
npm install
npm start                 # 起界面
```

数据目录默认 `%APPDATA%\RCL`，想隔离出来单独跑：

```bash
MCL_DATA=D:/somewhere npm start
```

界面无头自检（跑一遍 IPC + 渲染 + 建/删档案，结果打到 stdout）：

```bash
MCL_SILENT=1 MCL_SELFTEST=1 npm start
```

打包 Windows 安装包：

```bash
npm run dist
```

产物输出目录写在 `electron-builder.yml` 的 `directories.output`，那是我本机的路径，你用自己想要的目录替换。没有代码签名证书，装的时候 Windows SmartScreen 会拦一下，选"仍要运行"。

端到端验证脚本（真的下载、装核心、起服务器、发指令、停止）：

```bash
node scripts/e2e.cjs 1.21.1 paper --fresh
node scripts/e2e.cjs 1.21.1 fabric
node scripts/e2e.cjs 1.20.1 forge
node scripts/e2e.cjs 1.21.1 client     # 会真开一个游戏窗口
```

## 已知限制

- NeoForge 和 Quilt 的整合包不能自动安装，会明确报错而不是装个坏的
- CurseForge 整合包不支持（`.zip` 结构和 `.mrpack` 不同，且必须 API Key）
- 微软正版登录和 LittleSkin 第三方登录的**完整流程没有用真账号验证过**，代码按公开协议写的，第一次用建议先备份存档
- Forge 整合包（`.mrpack` 里 `dependencies.forge`）没整体跑通过；Forge 客户端安装本身跑通了（官方安装器 `--installClient`）
- 界面是单人自用取向，没有做国际化、没有做主题编辑器

## 版权

仓库里不含任何 Minecraft 文件、素材或商标资源，运行时从 Mojang / BMCLAPI / Paper / Fabric / Forge / Modrinth 的公开接口下载。这些服务和内容的权利归各自所有者；authlib-injector 是 yushijie 的项目，LittleSkin 是第三方认证服务，用它请遵守其规则。本项目仅供个人学习使用。
