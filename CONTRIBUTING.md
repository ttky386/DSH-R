# 参与贡献

欢迎 issue、插件和 PR。先读一遍这份，能省掉来回问。

[English](CONTRIBUTING.en.md)

## 这个项目是什么、不是什么

DSH-X 是 **DeepSeek Harness 的第三方启动器**：管版本安装、启动项、多实例、插件、整合包、同步。

它**不**重做 dsh 的网页界面。凡是「DSH 页面里长什么样」的问题，属于上游（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）；DSH-X 只负责把官方原版页面拉起来。

## 动手前

```bash
npm install          # 只有打安装包才需要（electron / electron-builder）
npm start            # 起管理页，开发入口
npm test             # 全部用例，约 80 秒
```

- **跑测试别接管道**：`npm test | head` 会把输出缓冲成 0 字节，等于白跑。要留证据就重定向到文件。
- 源码运行不需要构建步骤，改完重启即可。没有 lint / 格式化配置，也**别加**。
- 想用 Electron 外壳从源码起：`npm install` 之后 `npm run electron`。

## 代码规矩

细节都在 [AGENTS.md](AGENTS.md)，最要紧的三条：

1. **注释写「为什么」**，用中文。这个仓库里每个不显然的决定都带一段解释（很多是踩坑记录）；不要写逐行翻译代码的注释。
2. **加依赖要极其克制**。服务与页面只 import `node:` 内置模块或相对路径。想引第三方库之前，先看看能不能手写（`zip.js`、`zipfile.js`、`sync.js` 都是手写的）。
3. **改了 `server.js` / `settings.js` 的核心行为，先补用例**。`npm test` 里有三只假服务器（S3 / WebDAV / 代理），网络相关改动靠它们离线验证。

## 提交

- commit message 用**中文**，按功能拆，一条一件事。
- 前缀统一成 `类型: 说明`，类型只有四个，和发版说明的分块对上：

  | 前缀 | 用在 | 发版时归到 |
  |---|---|---|
  | `feat` | 新功能 | 新增功能 |
  | `fix` | 修 bug | 问题修复 |
  | `perf` | 体验、性能、文案、样式调整 | 体验优化 |
  | `chore` | 文档、依赖、构建、重构 | 其他变更 |

  例：`fix: 修复更新运行中的实例后首页卡在「正在安装」`

- 别在 commit 里夹带无关改动。

## PR

- 一个 PR 一件事；改动大就先开 issue 说清楚要做什么。
- 说明里写**用户能看见的变化**，不用写实现过程。
- 提交前跑一遍 `npm test`。
- 不在 PR 里更新版本号 —— 发版由维护者统一 bump。

## 报告问题

用 [issue 模板](.github/ISSUE_TEMPLATE) 建 issue，里面会问版本、系统和日志位置。

日志在：

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\DSH\manager.log` |
| macOS | `~/Library/Application Support/DSH/manager.log` |
| Linux | `$XDG_CONFIG_HOME/DSH/manager.log`（默认 `~/.config/DSH/`） |

**贴之前看一眼**：日志里可能有你的用户名、路径和 profile 名。

## 安全问题

见 [SECURITY.md](SECURITY.md)，别开公开 issue。
