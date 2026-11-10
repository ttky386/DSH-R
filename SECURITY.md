# 安全策略

DSH-X 是第三方启动器，本身不处理账号凭据，但它会：

- 起子进程、注入环境变量（`NODE_OPTIONS`、`PATH`、代理变量）到 dsh 进程；
- 读写你的用户目录（`%APPDATA%\DSH`、`~/Library/Application Support/DSH`、`$XDG_CONFIG_HOME/DSH`）；
- 从 npm registry 与 GitHub Releases 下载代码并执行；
- 通过 electron-updater 自动更新外壳。

这些路径上任何一处能被绕过，都属于安全问题。

## 报告方式

**别开公开 issue。** 用 GitHub 的私密漏洞报告：

https://github.com/yyh-001/DSH-X/security/advisories/new

请在报告里写清：影响版本、复现步骤、是本地利用还是需要用户交互、你希望的披露时间。

## 支持范围

只维护最新发布版。旧版本的问题如果没有在新版复现，不单独修。

## 不在范围内

- DeepSeek Harness 本体的问题（请找官方仓库）；
- 你自己机器上被改坏的 `settings.json`、profile 或插件树（先用「恢复档」或 `plugin-tool.js` 自救，再来看是不是启动器的问题）；
- 依赖项（Electron、pnpm、npm）自身的漏洞 —— 报告给上游，我们会跟版本。
