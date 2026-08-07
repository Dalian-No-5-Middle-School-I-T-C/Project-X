# Third Party Notices

## TWAIN DSM SDK (twain-dsm 2.5.1)

- 来源: https://github.com/twain/twain-dsm (tag v2.5.1, 2022-11 发布)
- 作者: TWAIN Working Group
- 许可证: **GNU LGPL v2.1** (详见上游 `COPYING` 文件: https://github.com/twain/twain-dsm/blob/master/COPYING)
- 用途: 本项目仅使用其公开头文件 `twain.h` 与官方预编译发行版 `TWAINDSM.dll`（`Releases/dsm_020403` 的 32/64 位 Windows 版本），作为 TWAIN 协议的最小运行依赖随 `scanner-bridge` 一同分发。
- 包含内容:
  - `include/twain.h` — TWAIN 规范头文件
  - `dsm/win-x64/TWAINDSM.dll` — 64 位 Data Source Manager（随 Scanner Bridge x64 构建分发）
  - `dsm/win-ia32/TWAINDSM.dll` — 32 位 Data Source Manager（随 Scanner Bridge ia32 构建分发）
- 免责声明: TWAIN Working Group 对本 SDK 不提供任何明示或暗示担保。本项目对 TWAINDSM.dll 不做任何修改，仅原样复制分发。

依据 LGPL v2.1 第 6 节，本通知随二进制分发一同提供；上游完整源代码可从上述仓库获取。
