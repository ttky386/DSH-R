# dsh-x-desktop-notify

DSH-X 外壳的原生通知桥。跑在 dsh 的 **host 侧**，不依赖页面：

- **一轮结束时**发系统原生通知（完成 / 失败 / 达到输出上限 / 被阻断；中止默认不提醒）；标题是「任务已完成」这类结论，正文是**这一轮用户说的话**（`任务：…`），拿不到人类消息时才退回「会话标题 · 时长」；
- **工具要你确认时**发一条「等你确认」：正文第一行同样是这一轮的用户原话，第二行写哪个工具、为什么；
- 顺便把 `notify` / `open` / `reveal` / `clipboard` / `dialog` 五个桌面能力作为 `dshDesktop` 服务借给其它插件。

链路：

```
本插件（dsh 子进程） --本机 HTTP--> 管理服务 /api/desktop/notify --> 外壳 host.desktop --> Electron Notification
```

只有**由 DSH-X 启动**的 dsh 实例才接得上这条链路：外壳给子进程注入 `DSH_X_MANAGER_URL`（管理页实际端口，每次可能顺延）和 `DSH_X_DESKTOP=1`。浏览器模式、用户自己 `dsh` 起来的环境、旧外壳都没有这两个变量——本插件**静默不做事**，不抛错、不重试。

## 为什么是 host 侧

页面插件（比如 `dsh-plugin-notify-sounds`）用浏览器 `Notification`，要求页面开着、权限放行；后台标签页还可能被节流。host 侧直接调外壳：进程在就有通知，窗口最小化、标签页切走都不影响。

两者不冲突，但同一条提醒别开两份——用本插件就把页面那件的系统通知关掉，或者只留其中一件。

## 配置

默认值见 `cordis.patch.yml` 里的注释，patch 行的 `config` 覆盖：

| 键 | 默认 | 作用 |
|---|---|---|
| `onTurnEnd` | `true` | 一轮结束时提醒 |
| `onApproval` | `true` | 工具等用户确认时提醒 |
| `includeSubagents` | `false` | 子代理的轮次也提醒（默认只提醒顶层会话，免得一条任务响一串） |
| `notifyOnAborted` | `false` | 用户自己中止的轮次也提醒 |

外壳设置页的「任务通知」「通知声音」两个开关照常生效：关掉任务通知，接口回 `shown: false, reason: "disabled"`，插件不会换别的通道硬发；提示音只能被插件关小，不能被打开。

## 和设置里的「任务通知」是一个开关

DSH-X 把「任务通知」当原生通知总开关，不需要再给本插件单独加开关：

- 关掉时，外壳拦截所有 `/api/desktop/notify`，管理器还会把本插件的 loader 行停用（`- id: x-desktop-notify / disabled: true` 写进 profile 补丁层），插件不再监听会话事件；
- 打开时删掉禁用块，恢复监听；
- 只处理装了 `dsh-x-desktop-notify` 或 `dsh-x-desktop-bundle` 的环境，没装的环境不会被写上过期覆盖；
- 改完重启 dsh 生效。

插件页里那一行开关是手动覆盖，和总开关不要同时用：总开关打开时会删掉 `x-desktop-notify` 的禁用块，连手动关掉的也会一起恢复。

## `dshDesktop` 服务

其它插件声明 `inject: ['dshDesktop']` 后直接调，不用自己写 HTTP：

```js
export const inject = ['dshDesktop']

export function apply(ctx) {
  const desktop = ctx.dshDesktop
  if (!desktop?.enabled) return            // 不在 DSH-X 里：静默降级

  await desktop.notify({ title: '同步完成', body: '3 个会话已上传', url: 'http://127.0.0.1:9716/?token=…' })
  await desktop.open('https://github.com/yyh-001/DSH-X')
  await desktop.reveal('C:\\Users\\me\\dsh-backup.zip')
  await desktop.clipboard('要复制的内容')
  await desktop.dialog({ kind: 'open', title: '选择备份', filters: [{ name: 'ZIP', extensions: ['zip'] }] })
}
```

返回值就是接口原样的 JSON；`notify` 的 `shown: false` 带 `reason`（`disabled` / `throttled` / `unsupported` / `unreachable`）。完整协议、请求形状、上限与错误码见仓库的 [`docs/desktop-api.md`](../../docs/desktop-api.md)。

## 兼容

- dsh `>= 0.2.0`（用到 `turn/end`、`approval/request`、`session/event`；标题走可选的 `sessionTitle` 服务）。
- DSH-X **核心 + 外壳**两层都要是带 `/api/desktop` 的版本：旧核心没有路由（404），旧外壳没有 `host.desktop`（503）。
- 只有 host 半部，没有 client 模块，不需要页面、不需要重启页面。

## 安装

```sh
dsh plugin --profile web add dsh-x-desktop-notify
```

装完重启 dsh。插件的 `dsh.bundle.patch` 会把自己挂进 profile 的层栈，不用手改 `cordis.patch.yml`。

## 许可

MIT。
