# ZFSN Red Glow — Windows 光标方案

复刻站点 `assets/cursor/*.svg` 的设计语言：主色 `#ff2d4a`、高斯发光、  
主光标热点 `(4, 2)`。共 15 个角色，32×32 / 32bpp，动画为真 `.ani` 帧序列。

## 安装

双击 `install.bat`。会做三件事：

1. 把 `zfsn\*.cur|*.ani` 复制到 `%LOCALAPPDATA%\ZFSN-Cursors\`
2. 写主题文件 `%LOCALAPPDATA%\Microsoft\Windows\Themes\ZFSN.theme`
3. 写注册表 `HKCU\Control Panel\Cursors`，再调 `apply.ps1` 广播  
   `SPI_SETCURSORS` 让新光标立即生效

**恢复默认**：`install.bat /restore`

若第 3 步失败，脚本会自动试 `rundll32 user32.dll,UpdatePerUserSystemParameters`，  
并提示你注销重登（注册表已写好，注销后一定会生效）。

**只应用不重装**（注册表已写好时）：

```
powershell -ExecutionPolicy Bypass -File apply.ps1
```

## 为什么 apply 是独立 .ps1

最初把 `SystemParametersInfo` 的 P/Invoke 写成 bat 内联的  
`powershell -Command "..."` 一行式。cmd 与 PowerShell 的引号规则互相打架，  
`\"` 转义被双重处理，生成的 C# 源码被撕成两截，`Add-Type` 编译失败 ——  
表现就是满屏 `SOURCE_COMPILER_ERROR`。

改成独立 `.ps1`（用单引号 here-string，零转义）+ bat 用 `-File` 调用后，  
这个问题类彻底消失。**凡是含引号/反斜杠/花括号的 PowerShell 代码，都不要塞进 bat。**

## 设计原则（避免"手绘感"和"发暗"）

- 所有图形用**几何精确**的方式生成：正圆、镜像对称、常量驱动的臂长，
  不手写随意坐标
- 发光 blur 半径统一 3（4× 画布上约 12px）—— 过大会让边缘发虚
- 每个图形都带深色 `#2d040e` 外衬，保证浅色桌面也看得见
- 描边 ≥ 1.9px：32px 下 1.7px 经 LANCZOS 下采样后被发光糊掉
- 填充透明度 ~60%：原 23% 几乎看不见
- 全部字符 ASCII，无全角符号（见下方"踩坑"）

### 曾踩的坑：发光变成黑雾

第一版光标"发暗、不易辨识"。用像素分析定位 —— 可见像素里占满前列的是
`(0,0,0,10)` 这种**纯黑低透明度**像素，正红一个都排不上。

根因：`ImageFilter.GaussianBlur` 会**独立模糊 RGB 通道**，而透明区的 RGB 是
`(0,0,0)`，混进来就把红色发光拉成了黑雾。

修法：**只模糊 alpha 通道**，再用纯色层贴上：
```python
alpha = lay.getchannel("A").filter(ImageFilter.GaussianBlur(blur * S))
base = Image.new("RGBA", (CV, CV), color[:3] + (0,))
base.putalpha(alpha)
```
修完 Normal 的构成从「447 暗 / 0 亮红」变成「581 亮红 / 0 纯黑」。

### 曾踩的坑：钢笔几何算错

`draw_pen` 把「宽度」偏移沿**笔轴**方向加了，画出来是个细长三角条
（可见像素仅 26，全套最小）。正确做法是用轴 `u=(0.707,-0.707)` 和
宽 `v=(0.707,0.707)` 两个正交向量构造平行四边形。修完 233 个可见像素。

## 角色对照

| Windows 键名    | 文件                | 中文名       |
| ------------- | ----------------- | --------- |
| `Arrow`       | `Normal.cur`      | 正常选择（主指针） |
| `Help`        | `Help.cur`        | 帮助选择      |
| `AppStarting` | `Working.ani`     | 后台运行      |
| `Wait`        | `Busy.ani`        | 忙         |
| `NWPen`       | `Handwriting.cur` | 手写        |
| `No`          | `Unavailable.cur` | 不可用       |
| `SizeAll`     | `Move.cur`        | 移动        |
| `SizeNESW`    | `SizeNESW.cur`    | 对角线调整 2   |
| `SizeNS`      | `SizeNS.cur`      | 垂直调整      |
| `SizeNWSE`    | `SizeNWSE.cur`    | 对角线调整 1   |
| `SizeWE`      | `SizeWE.cur`      | 水平调整      |
| `UpArrow`     | `Up.cur`          | 备用        |
| `Crosshair`   | `Precision.cur`   | 精确选择      |
| `IBeam`       | `Text.cur`        | 文本选择      |
| `Hand`        | `Link.cur`        | 链接选择      |

## 文件

```
gen_cursors.py        生成器（改设计改这里）
validate_cursors.py   结构与像素校验（必须 0 报错）
make_preview.py       浅/深双背景预览
make_zoom.py          5x 最近邻放大预览
install.bat           安装 / 恢复
apply.ps1             应用光标（SPI_SETCURSORS），可单独运行
zfsn/                 生成的光标文件
```

重新生成：`python gen_cursors.py && python validate_cursors.py`

## 踩坑记录（都是实测踩出来的）

1. **`.ani` 的 `anih` 头是 9 个 DWORD = 36 字节**，最后一个是 `flags`。  
   少打一个字段会让后续 chunk 偏移全错 —— 文件"生成了"但读不出来
2. **RIFF 块 ID 必须正好 4 字节**。动画序列块的规范名是 `"seq "`（带尾随空格），  
   写成 `"seq"` 会让整个文件结构崩
3. **`.ani` 的 `fram` 块里是完整 ICO 格式**（6 字节头 + 16 字节目录项 + DIB），  
   不是裸 DIB
4. **DIB 的 AND 掩码是「每字节内 MSB 优先」**。用 `struct.pack("<I")` 打包会因小端  
   反转字节序，导致读写不一致、所有 alpha 被清零（光标全透明）
5. **热点存在每帧 ICO 的目录项里**。漏了就默认 `(0,0)`，点击落在光标左上角
6. 手型光标用圆角矩形拼出来必然"手绘感" —— 改用站点原版的同心圆环
7. 32bpp BMP DIB 的 `biHeight` 是 XOR+AND 双倍高度，不是图像高度
