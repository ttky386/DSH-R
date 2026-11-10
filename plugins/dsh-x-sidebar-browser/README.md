# dsh-x-sidebar-browser

DSH-X 的首方 agent 工具：操作**官方**右侧栏 Browser tab（Electron `<webview>`，不是截帧、不是另起的浏览器）。

## 工具

`sidebar_browser`，一个工具、一组 action：

| action | 作用 |
|---|---|
| `status` | 平台、当前 Session、Browser frame、URL/标题 |
| `open` / `navigate` | 打开/导航（http/https；裸域名补 https） |
| `back` / `forward` / `reload` | 历史与刷新 |
| `snapshot` | 页面文本 + 带编号的交互元素 ref |
| `click` / `type` / `press` / `select` / `scroll` / `wait` | 用 ref 或 CSS selector 操作 |
| `eval` | 在页面里执行 JS 表达式（带该 tab 的登录态） |
| `screenshot` | 截当前可见页面，作为 PNG 附件返回 |
| `close` | 关闭当前 Browser tab |

## 会话规则

Browser tab 是按 Session 的。命令只投递给**当前屏幕上**的那个 Session；agent 在 A 会话、用户切到 B 会话时，命令会超时并给出提示，不会操作 B 的页面。

## 安装

本地 link 到某个 profile：

```json
"dependencies": {
  "dsh-x-sidebar-browser": "link:C:/Users/18078/Desktop/dsh-x/dsh-dist/plugins/dsh-x-sidebar-browser"
}
```

并把 `dsh-x-sidebar-browser` 加进 `dsh.profile.bundles`。重启 dsh 生效。

## 安全

`eval`、`click`、`type` 都在侧栏那个 `<webview>` 里执行，带着该 tab 的 cookie/登录态。把 `sidebar_browser` 当成「允许对方操作你正在看的这个页面」；不要在已登录敏感站点的工作区里随意让它跑 `eval`。

## 来源

Host/Client 的结构参考了 [dsh-sidebar-browser](https://www.npmjs.com/package/dsh-sidebar-browser)（MIT，Copyright (c) 2026 The dsh-sidebar-browser authors）与 [dsh-sidebar-browser-control](https://github.com/XUFENGCHINA/dsh-sidebar-browser-control)（MIT）。本实现按 Session 隔离命令队列，ref 属性使用 `data-dsh-x-sb-ref`，与第三方插件互不干扰。
