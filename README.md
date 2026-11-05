# RCL

一个 Windows 上的 Minecraft 启动器，界面思路照 PCL2：**启动游戏**和**开服务器**是两个独立页面，程序本体不内置任何 MC 文件——版本、核心、Java、资源、模组全部按需下载，所以安装包只有 116MB。

用 Electron 写的，没有运行时依赖（zip 解析、bundler 解包都是手写的），只有 devDependencies 里的 electron 和 electron-builder。

改动记录见 [CHANGELOG.md](CHANGELOG.md) —— 里面每一版的"验证"栏写的是**实际跑过的**，没写的别当成已验证。

## 能做什么

**开服务器**
- 原版服务端（自动处理 Mojang 的 bundler 格式，内嵌依赖解一次全实例共用）、Paper、Fabric、Forge、NeoForge
- 控制台实时日志、发指令、优雅停止、崩溃自动重启、server.properties 图形化编辑、世界备份
- 每个服独立目录、独立内存与 Java 版本

**启动游戏**
- 三种登录：离线 / 微软正版（设备码登录，XBL→XSTS→launcher 全流程）/ authlib-injector 第三方（LittleSkin 等，登录框在游戏里弹）
- 令牌用系统 DPAPI（`safeStorage`）加密存本地，明文不落盘
- 每个档案独立游戏目录，可选窗口尺寸、全屏、直连服务器、额外 JVM/游戏参数
- 游戏参数严格按版本 profile 声明拼装，不硬编码；加载器主类与 `-p` 模块路径也从产出的 profile 读，不假定

**下载**
- 任何 Mojang 清单里的版本都能取（不限固定几个），正式版/快照/旧 Beta 都能筛
- **点版本名进详情页**（照 PCL2 的层级）：顶部一个"客户端 / 服务端"总开关，下面一行一个核心 —— 原版、Paper、Fabric、Forge、NeoForge，各自懒加载版本列表；OptiFine 列出来但标"暂不支持"
- 详情页里能直接「删除本版本文件」，删除前会**列出将要没掉的存档名和上次修改时间**，目录被多个档案共用时会单独标出来并且不删目录
- 整合包：直接搜 Modrinth，不用填版本，点一条列出它全部版本，选一个装成新档案（`.mrpack` 的模组文件按 sha1 校验，覆盖配置自动铺，服务端专用文件跳过）
- 模组 / 光影 / 材质包：Modrinth 免密钥可用；CurseForge 需要自己的 API Key（社区免密钥镜像已全部失效）
- Java 运行时按需下载（清华 Adoptium 镜像优先，回落官方）
- 默认走 BMCLAPI 镜像，设置里可换，任何一步失败自动回落官方源；NeoForge 官方站在国内直连大面积超时，已加 BMCLAPI 镜像规则，安装器依赖也改由我们预下载
- 删除版本时能顺带回收不再被任何档案使用的共享库，并清掉空目录

**版本隔离**（设置里五档，照 PCL2）
- 关闭 / 隔离所有版本 / 隔离可安装 Mod 的版本 / 隔离非正式版 / 隔离可安装 Mod 的版本与非正式版
- 同时决定**档案目录**和**库目录**放哪：隔离时加载器和该版本的库进 `store/versions/<版本>/libraries`，删版本就彻底回收，不留孤儿
- 只影响之后新建的档案与之后下载的库；已有档案的路径写死在记录里，改设置不会让存档"凭空消失"
- 旧共享库保留作只读回退，切换策略不会让你重下

**下载管理**
- 所有下载任务集中一页：进度、速度、剩余时间、当前文件、已完成/失败数
- 可单个取消、全部取消；取消会真的断流，已下的部分留作 `.part` 续传
- 同一件事同一时刻只跑一份：连点、界面重绘后按钮复活再点、或从不同入口（下载页 / 准备客户端 / 装整合包）撞车，都只会等同一份结果，不会重复占带宽，也不会并发写坏同一个文件

**其它**
- 系统托盘：叉掉可以后台运行，也可以设置成直接退出，支持"记住选择"
- 检查更新：比对最新 MC 版本与已装版本的 Paper 新构建；RCL 自身更新需要在设置里填一个返回 JSON 的更新源地址
- 导入已有游戏目录：只在原地建档案，不复制不移动；删档案（哪怕勾了删文件）也不会碰你的目录
- 界面动效克制：切页面淡入、弹窗弹出、按钮按下有反馈、下载中进度条走一道扫光。列表项**故意不做**入场动画——筛选和选中都会重绘，重绘就重播，反而满屏闪。系统开了"减少动态效果"时全部关闭

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
node scripts/e2e.cjs 1.21.1 neoforge
node scripts/e2e.cjs 1.21.1 client     # 会真开一个游戏窗口
```

想强制走国内镜像：前面加 `MIRROR=bmclapi`。

## 已知限制

- Quilt 的整合包不能自动安装，会明确报错而不是装个坏的
- **OptiFine 不支持**：官方只发带 GUI 的安装器，无头打补丁要引第三方 patcher，还没做（新版用钠系模组基本能覆盖它的作用）
- CurseForge 整合包不支持（`.zip` 结构和 `.mrpack` 不同，且必须 API Key）
- 微软正版登录和 LittleSkin 第三方登录的**完整流程没有用真账号验证过**，代码按公开协议写的，第一次用建议先备份存档
- Forge 整合包（`.mrpack` 里 `dependencies.forge`）没整体跑通过；Forge 客户端安装本身跑通了（官方安装器 `--installClient`）
- 整合包档案的**启动没实测过**，只验到启动计划拼装正确（主类、classpath、参数、资源都对）
- NeoForge 客户端装完只验到 classpath 与 `-p` 模块路径拼装正确，没有真的开窗口启动过
- 界面是单人自用取向，没有做国际化、没有做主题编辑器

## 还没做

- OptiFine 支持（需要可靠的无头打补丁方案）
- 数据包（只有 CurseForge 有，需要 API Key）
- 存档编辑、截图管理这类"PCL2 里有但用不上"的功能没做

## 版权

仓库里不含任何 Minecraft 文件、素材或商标资源，运行时从 Mojang / BMCLAPI / Paper / Fabric / Forge / Modrinth 的公开接口下载。这些服务和内容的权利归各自所有者；authlib-injector 是 yushijie 的项目，LittleSkin 是第三方认证服务，用它请遵守其规则。本项目仅供个人学习使用。
