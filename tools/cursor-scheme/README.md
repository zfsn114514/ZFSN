# ZFSN Red Glow — Windows 光标方案

复刻站点 `assets/cursor/*.svg` 的设计语言：主色 `#ff2d4a`、高斯发光、
主光标热点 `(4, 2)`。共 15 个角色，32×32 / 32bpp，动画为真 `.ani` 帧序列。

## 安装

双击 `install.bat`。会做三件事：

1. 把 `zfsn\*.cur|*.ani` 复制到 `%LOCALAPPDATA%\ZFSN-Cursors\`
2. 写主题文件 `%LOCALAPPDATA%\Microsoft\Windows\Themes\ZFSN.theme`
3. 写注册表 `HKCU\Control Panel\Cursors` 并广播 `SPI_SETCURSORS` 应用

**恢复默认**：`install.bat /restore`

若个别光标没立即变化，注销重登一次即可。

## 设计原则（避免"手绘感"）

- 所有图形用**几何精确**的方式生成：正圆、镜像对称、常量驱动的臂长，
  不手写随意坐标
- 发光 blur 半径统一 3（4× 画布上约 12px）—— 过大会让边缘发虚
- 每个图形都带深色 `#1e020c` 外衬，保证浅色桌面也看得见
- 全部字符 ASCII，无全角符号（见下方"踩坑"）

## 角色对照

| Windows 键名 | 文件 | 中文名 |
|---|---|---|
| `Arrow` | `Normal.cur` | 正常选择（主指针） |
| `Help` | `Help.cur` | 帮助选择 |
| `AppStarting` | `Working.ani` | 后台运行 |
| `Wait` | `Busy.ani` | 忙 |
| `NWPen` | `Handwriting.cur` | 手写 |
| `No` | `Unavailable.cur` | 不可用 |
| `SizeAll` | `Move.cur` | 移动 |
| `SizeNESW` | `SizeNESW.cur` | 对角线调整 2 |
| `SizeNS` | `SizeNS.cur` | 垂直调整 |
| `SizeNWSE` | `SizeNWSE.cur` | 对角线调整 1 |
| `SizeWE` | `SizeWE.cur` | 水平调整 |
| `UpArrow` | `Up.cur` | 备用 |
| `Crosshair` | `Precision.cur` | 精确选择 |
| `IBeam` | `Text.cur` | 文本选择 |
| `Hand` | `Link.cur` | 链接选择 |

## 文件

```
gen_cursors.py        生成器（改设计改这里）
validate_cursors.py   结构与像素校验（必须 0 报错）
make_preview.py       浅/深双背景预览
make_zoom.py          5x 最近邻放大预览
install.bat           安装 / 恢复
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
