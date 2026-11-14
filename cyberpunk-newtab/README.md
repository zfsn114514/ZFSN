# ZFSN://HOME — 夜之城新标签页

一个 **赛博朋克 2077 风格** 的 Chrome / Edge 新标签页扩展。它会把浏览器默认的 Google 新标签页替换成夜之城风格的网络面板，并且磁贴完全由你自己管理。

> 这是原创界面，不含《赛博朋克 2077》的游戏素材；只借鉴了霓虹黄 / 青、切角、扫描线、故障字等视觉语言。

## 功能

- **替换新标签页**：打开新标签就是 `ZFSN://HOME`，不再是 Google 搜索页。
- **磁贴自由管理**
  - `+ ADD` / `N` 快捷键新建磁贴
  - 悬停磁贴后可以 **编辑**、**删除**
  - 拖动磁贴右下角的 **⠿ 拖拽手柄** 排序
  - 支持 `http(s)` 链接、域名、局域网 IP（如 `192.168.0.1`）
  - 图标留空会自动读取网站 Favicon（见下方「图标来源」）；也可以填 emoji 或图片 URL
- **多搜索引擎**：Google / Bing / 百度 / DuckDuckGo / 哔哩哔哩 / GitHub，点搜索框右侧的引擎名即可循环切换。
- **智能地址栏**：输入 `github.com`、`192.168.0.1` 会直接打开；输入普通文字才会搜索。
- **四套配色**：NIGHT CITY（黄/青）、NETRUNNER（青/黄）、AFTERLIFE（红/金）、BLACKWALL（紫/绿）。
- **本地数据**：磁贴和设置保存在 `chrome.storage.local`，不上传服务器；支持 JSON 导入/导出备份。
- **离线可用**：除磁贴本身指向的网站外，不依赖任何在线资源。
- **键盘操作**：`/` 或 `Ctrl/Cmd+K` 聚焦搜索，`Esc` 清空搜索，`N` 新建磁贴。

## 图标来源

磁贴图标按下面的顺序尝试，前一个加载失败自动换下一个，全都失败才显示站点首字：

1. **Chromium 本地 favicon 缓存**（`chrome.runtime.getURL('/_favicon/?pageUrl=…')`）——装成扩展后走这条，离线可用、不联网、画质最好；
2. **站点自己的 `/favicon.ico`**——局域网设备（路由器、NAS）只有这条路；
3. **公共图标服务**（`favicon.im` → DuckDuckGo → Google）——预览环境（直接用 `http://` 打开 HTML）没有扩展 API 时靠它显示真图标。内网 / 私有 IP 会自动跳过这一步。

> 第 3 步会把「你要访问的域名」发给图标服务；如果你的网络环境不希望这样，装成扩展后就不会用到它。

## 安装（Chrome）

1. 打开 `chrome://extensions/`
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择这个文件夹：`D:\ZFSNwebsite\cyberpunk-newtab`
5. 打开一个新标签页即可

如果新标签页没有变化，检查是否有其他新标签页扩展（如 Infinity、Tabliss、Bonjourr）正在覆盖它，先停用其中一个。

### Edge

打开 `edge://extensions/`，同样开启开发者模式，然后“加载解压的扩展程序”。

## 首次安装的示例磁贴

默认带了 11 个磁贴：Bing、哔哩哔哩、苦力怕论坛、MC导航、中文百科、谷歌邮箱、GitHub、路由器配置、DNS代理、IP 查询、ZFSN 主页。

其中 **路由器配置** 和 **DNS代理** 是常见地址示例：

- 路由器：`http://192.168.0.1/`
- DNS 代理：`http://192.168.0.1:3000/`

如果你家的地址不同，悬停磁贴 → 点铅笔图标改成自己的地址即可。也可以在“设置 → 数据 → 恢复示例”里重置。

## 添加 / 编辑磁贴

### 添加

- 点击磁贴列表最后的 `+ ADD NODE`
- 或点击右上角 `+ ADD`
- 或按 `N`

填写：

| 字段 | 说明 |
| --- | --- |
| 名称 | 显示在磁贴上的名字 |
| 链接 | `https://...`、`example.com`、`192.168.0.1:3000` 都可以 |
| 图标 | 留空自动抓取；可填 `🎮` 之类的 emoji；也可填图片 URL |
| 标签 | 显示在名称下方的小字，例如 `CODE`、`VIDEO`、`LAN` |
| 信号色 | 磁贴左侧信号条的颜色 |

### 排序

鼠标移到磁贴右下角，按住 **⠿ 手柄** 拖动到另一个磁贴的左侧或右侧。顺序会自动保存。

### 删除

鼠标移到磁贴 → 点垃圾桶图标。会弹出确认框，避免误删。

## 设置

点击右上角 `CONFIG`：

- 默认搜索引擎
- 四套界面主题
- 界面动效 / 扫描线开关
- 导出备份、导入备份、恢复示例、清空磁贴

## 数据与隐私

- 数据只存在本机浏览器扩展存储里（`chrome.storage.local`），不会同步到任何服务器。
- 磁贴图标通过 Chrome 自带的本地 Favicon API 读取；如果读取不到，会显示名称首字作为备用。
- 扩展没有网络请求权限，也不包含统计脚本。点击磁贴 / 搜索时才会离开新标签页去访问目标网站。
- 导出的备份是普通 JSON 文件，包含磁贴名称、链接、图标、标签、颜色和界面设置，不包含浏览记录。

## 文件结构

```
cyberpunk-newtab/
├── manifest.json      # Manifest V3 配置，chrome_url_overrides.newtab
├── newtab.html        # 新标签页结构
├── styles.css         # 夜之城视觉、扫描线、切角、响应式
├── app.js             # 磁贴 CRUD、拖拽、搜索、存储、设置
├── icons/             # 扩展图标 16/32/48/128
└── README.md
```

## 自定义

- 改颜色：`styles.css` 顶部的 `:root` 和四套 `html[data-theme=...]`。
- 改默认磁贴：`app.js` 顶部的 `DEFAULT_TILES`。
- 改默认搜索引擎：`app.js` 顶部的 `ENGINES` 和 `DEFAULT_SETTINGS`。
- 改标题 / 副标题：`newtab.html` 里的 `.hero__title`、`.hero__tagline`、`.brand`。

## 卸载

`chrome://extensions/` → 找到 `ZFSN://HOME — 夜之城新标签页` → 移除。卸载后 Chrome 会恢复默认新标签页；扩展数据也会一并删除，建议先导出备份。

## 可选：打包发布

```powershell
Compress-Archive -Path D:\ZFSNwebsite\cyberpunk-newtab\* -DestinationPath D:\ZFSNwebsite\cyberpunk-newtab.zip
```

如果要发布到 Chrome Web Store，需要把 `manifest.json` 里的版本号、描述和图标准备齐全，并在开发者后台创建项目。个人自用直接“加载已解压的扩展程序”就够了。
