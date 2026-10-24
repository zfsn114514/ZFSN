# ZFSN Cursor — 网站同款 Windows 光标与拖尾

适用于 Windows 10/11 x64。独立桌面程序，不是网页插件。默认不设置开机启动，不需要管理员权限；退出时恢复原来的光标方案。

## 使用

1. 获取 `ZFSN-Cursor-win-x64` 构建包并解压。
2. 双击 `ZFSN.Cursor.exe`，点击「启动光标与拖尾」。
3. 可选择是否替换正常箭头／链接手型、是否在全屏应用中暂停拖尾、是否显示同款跟随光晕，并调整特效强度。
4. 「隐藏到托盘」会保持运行；双击托盘图标重新打开设置。
5. 默认关闭窗口会隐藏到托盘；点击「退出并恢复」或托盘菜单「退出并恢复光标」才会停止程序并恢复系统光标。可关闭「关闭窗口时隐藏到托盘」来恢复关闭即退出的行为。
6. 若程序被强制结束后光标没有恢复，运行包内 `restore.bat`，或 `ZFSN.Cursor.exe --restore`。

### 从 GitHub 获取编译包

打开仓库的 **Actions → Build Windows cursor app → 最新成功的运行 → Artifacts → ZFSN-Cursor-win-x64**。
这是 Windows x64 自包含构建，使用者不需要单独安装 .NET 或 Python。
Artifacts 下载通常需要登录 GitHub。构建包不提交到 Git 历史，避免每次拉取网站时多下载上百 MB。

### 自己构建

在 Windows 安装 .NET 8 SDK 后，双击 `build.bat`。生成位置：`dist\win-x64\ZFSN.Cursor.exe`。
也可执行：

```text
dotnet publish ZFSN.Cursor.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -o dist/win-x64
```

## 控制终端与常用设置

暗红面板、黄色标题、切角按钮与网站的 2077 游戏菜单主题呼应。按钮支持键盘焦点，窗口支持 DPI 缩放和滚动。

- **登录 Windows 后自动启动**：默认关闭。勾选后写入当前用户的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，无需管理员权限；登录后自动启用光标并隐藏到托盘。取消勾选会删除该项。
- 请先把程序解压到固定目录再启用自启动；移动 EXE 后，需要取消再重新勾选。Windows 任务管理器也可单独禁用启动项。
- **手动打开时自动启用光标**：与 Windows 自启动分开设置，默认关闭。
- **关闭到托盘**：默认开启；最小化也会隐藏到托盘。双击托盘图标打开窗口，托盘提供启动／暂停和退出。
- **即时调整与保存**：指针替换、全屏暂停、光晕、强度即时生效；设置保存在 `%LOCALAPPDATA%\ZFSN\Cursor\settings.json`，下次打开恢复。
- **恢复特效默认值**：恢复箭头、光晕、全屏暂停和 100% 强度，不更改自启动选项。
- **打开设置目录**：可自行备份或删除配置文件。删除后下次启动使用默认值。

## 与网页的一致性

- 正常指针和链接圆环来自 **同一份** `assets/cursor/arrow.svg`、`point.svg`，不是沿用旧 `cursor-scheme` 的加粗手绘版本。
- 源文件哈希统一按 LF 换行验证，避免 Windows 检出为 CRLF 时误报。原图经浏览器按 32×32 透明背景栅格化，再打包为 Windows CUR；热点与网页一致，分别为 `(4,2)`、`(12,12)`。
- 拖尾沿用网页算法：最多 26 粒子，每次最多 4 个采样，间距 7px，寿命每 60Hz 帧减 `.028`，速度衰减 `.95`，半径 `2.6–4.5px`，三段红色径向渐变。
- 另有网页同款 620px 光晕，沿用 `.12` 跟随系数与 `.14 / .05 / 0` 的径向透明度；可独立关闭。网页光晕在内容下方，桌面软件的光晕在透明覆盖层上，这一层级差别无法完全复刻。
- 按显示器 DPI 缩放，支持负坐标的多显示器；停止移动后粒子自然消失。
- Windows 的手型角色由各软件自己报告。网站可以知道每个可点击元素，而桌面程序无法统一判断第三方软件所有自绘按钮；游戏自绘指针、独占全屏和安全桌面也不属于普通系统光标。因此不能保证所有软件、所有 DPI 下逐像素相同。

## 实现与退出

`SetSystemCursor` 只临时替换运行中的 Arrow 和 Hand，不改系统光标注册表。关闭时用 `SPI_SETCURSORS` 重新加载用户原来的方案。
拖尾窗口使用逐像素透明、点击穿透、禁止激活的 layered window，仅覆盖粒子所在的小范围，空闲时隐藏。
通过 `GetCursorPos` 获取位置，不记录键盘，不保存鼠标轨迹，不上传数据，不注入其他进程。默认在全屏程序前暂停拖尾。

## 验证范围

已在 Linux 云端完成 Windows x64 交叉编译、资源结构校验、粒子算法测试。
**云端没有 Windows 桌面，不能替代对实际透明合成、点击穿透、系统光标切换和多屏 DPI 的 Windows 实机验证。**

```text
dotnet run --project Tests/TrailTests.csproj
python verify_assets.py
```
