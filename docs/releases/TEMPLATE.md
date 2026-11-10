<!--
发版说明模板，仿 dsh 官方（github.com/deepseek-ai/deepseek-harness/releases）的写法：

- 同一篇里中英文并存，顶部两个锚点互跳；
- 分块固定四段，顺序不变；只用这四段，不要临时造标题；
- 一条一行，句末说明这个改动的用户可见效果，不写根因、不写验证过程、不写安装步骤；
- 预发布（rc / alpha）要在 GitHub 上勾 Pre-release，文件名带后缀；
- 文件名写 `docs/releases/v<版本>.md`，例：`v0.1.23.md`、`v0.1.23-rc.1.md`。

删掉这段注释再发。
-->

<a id="cn"></a>

[中文](#cn) \| [English](#en)

<!-- 只有某个系列的首个候选版本才写这句导语，正式版和后续 rc 都删掉 -->
作为 `X.Y.Z` 系列的首个候选版本，本版本汇总了自 `vA.B.C` 以来的主要用户和开发者相关变更。

### 新增功能

- 例：新增 Linux 版本，出 AppImage，文件管理走 XDG 目录。

### 体验优化

- 例：托盘图标改用带圆角的图标，深色任务栏上不再有白边。

### 问题修复

- 例：修复更新运行中的实例后，首页一直卡在「正在安装」。

### 其他变更

- 例：移除旧版兼容桥，0.1.18 及更早的安装包不再能自动升级。

Full Changelog: [vA.B.C...vX.Y.Z](https://github.com/yyh-001/DSH-X/compare/vA.B.C...vX.Y.Z)

---

<a id="en"></a>

## English

### New Features

- e.g. Add a Linux build: AppImage output, XDG directories for file management.

### Improvements

- e.g. The tray icon is now rounded and no longer shows a white edge on a dark taskbar.

### Bug Fixes

- e.g. Fix the home page staying on "Installing" after updating a running instance.

### Chores

- e.g. Remove the legacy bridge; installers from 0.1.18 and earlier can no longer self-update.
