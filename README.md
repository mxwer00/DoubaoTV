# 豆包影视盒（DoubaoTV）

一个跑在 Windows 桌面的影视聚合播放器：搜索多个采集站的片源、在线播放、下载到本地离线看，
并附带一个只在局域网内可访问的手机（iPhone）网页入口。

不是网页版套壳站：界面是本地静态页 + 自研主进程网络层，播放器与所有片源请求都在桌面程序内完成，
程序运行不依赖任何外部 Node 服务，也没有 `node_modules`。

## 功能

- **多源聚合搜索**：内置多个采集站，按源并发检索并跨源合并同一部影片，多个线路可切换；某条线路播不动会自动换下一条。
- **在线播放**：本地 hls.js（`ui/vendor/hls.min.js`）播放 HLS，锁定最高码率档，画面按视频像素与屏幕物理像素 1:1 封顶显示，避免被放大发虚；支持「原始 / 铺满」切换与窗口记忆。
- **分类浏览 / 伦理片页**：跨源按分类名匹配抓取各站分类并按影片合并、支持翻页；每次启动自动打开（可关）。
- **后台自动更新片源**：启动后 3 秒跑一次、之后每 6 小时一次，全在主进程异步执行，不打断正在播放的窗口。
- **下载到本地**（`resources/app/downloader.js`）：读 m3u8 → 多档选最高带宽 → 4 并发抓分片 → AES-128-CBC 解密 → 严格按顺序边抓边拼成 `.ts`（fMP4 线路为 `.mp4`）；带进度/速度/取消，失败自动清掉半截文件。
- **手机访问**（`resources/app/lan-server.js`）：本机起一个只监听局域网的 HTTP 服务，把 m3u8 里的子清单/分片/密钥地址改写成本机代理路径，iPhone 同一 WiFi 用 Safari 直接看。
- **其他**：收藏、历史、片源管理（增删改/启用/订阅合并）、界面缩放（Ctrl +/-/0）、数据全部落在程序目录，便携可搬。

## 目录结构

```
electron.exe / *.dll / *.pak …     Electron 运行时（不入库，见下文"如何运行"）
resources/app/
  main.js          主进程：网络层、9 个内置源检索、IPC、窗口与缩放、后台更新
  preload.js       暴露给渲染进程的 IPC 接口
  downloader.js    HLS 分片下载器
  lan-server.js    局域网手机端服务与 m3u8 代理重写
  package.json
  ui/
    index.html  style.css  renderer.js
    vendor/hls.min.js      本地 hls.js
    assets/app-icon.png
    mobile/                手机端页面（index.html / app.css / app.js）
app.ico  app-icon.ico          程序与快捷方式图标
使用说明.txt                    面向使用者的完整说明
```

运行期生成、不入库：`data/`（`sources.json`、`app-config.json`、`favorites.json`、`history.json`、`logs/`）、`downloads/`。

## 如何运行

仓库只含源码。要跑起来需要一个 Electron 运行时放在根目录：

1. 下载 Electron 33.4.11 的 `win32-x64` 发行包（<https://github.com/electron/electron/releases/tag/v33.4.11>，文件名 `electron-v33.4.11-win32-x64.zip`）；
2. 解压后把里面的 `electron.exe`、`*.dll`、`*.pak`、`*.bin`、`*.dat`、`locales\`、`icudtl.dat`、`resources.pak` 等全部放到本目录；
3. 删掉 `resources\default_app.asar`（否则会加载默认应用）；
4. 双击 `electron.exe`（工作目录设为本目录），或建个指向它的快捷方式。

不需要 `npm install`，没有第三方依赖。

## 配置

`data/app-config.json`（首次运行自动生成）：

| 字段 | 说明 |
|---|---|
| `autoUpdate` / `startupEthics` | 启动自动更新片源 / 启动自动打开伦理片页 |
| `qualityHigh` | 锁定最高画质档 |
| `lanEnabled` / `lanPort` | 手机访问开关与端口（默认 `true` / `8899`，占用时自动顺延） |
| `downloadDir` | 下载目录，默认 `downloads\` |
| `zoomFactor` / `windowBounds` | 界面缩放与窗口位置记忆 |
| `subUrl` | 片源订阅地址（JSON 数组 / `{sites:[…]}` / 每行「名称 URL」） |

`data/sources.json` 是启用中的采集源，可在「片源管理」页增删改。

## 说明与免责

- 本程序**不存储、不分发**任何影视文件，只向第三方公开采集接口发起检索、转发播放地址；
  资源内容与可用性由各第三方站点负责，接口随时可能失效。
- 下载功能只是把正在观看的流按顺序存成本地文件，供个人离线观看；请勿再分发或用于商业用途，请遵守当地法律法规。
- 请自行确认所配置的采集源合法合规；内置示例源仅用于技术演示。
