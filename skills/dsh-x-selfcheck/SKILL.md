---
name: dsh-x-selfcheck
description: 只读自检本机 DSH-X（DeepSeek Harness 启动器）环境：管理页、数据目录、DSH_HOME/profile、运行实例、插件/技能、同步配置与近期日志。用户说 DSH 起不来、管理页打不开、插件/技能不生效、日志有报错，或要求「体检一下 DSH 环境」时使用。输出人读报告或 `--json`，不改任何文件。
whenToUse: 用户问 DSH-X/DSH 环境是否正常、启动失败、页面打不开、插件被禁用、技能没加载、管理页状态、日志报错，或需要在动手修之前先摸清环境时。
---

# DSH-X 环境自检

这个 skill 解决一个问题：DSH-X 出状况时，AI 往往先猜着改文件，而启动器自己的状态（管理页、数据目录、profile、实例、日志）散在四五个地方。这个脚本把它们收成一份只读诊断报告，让后续动作有依据。

它**只读**：不写设置、不改补丁层、不启停 dsh、不装插件。要修，等报告出来、和用户确认后再动手。

## 什么时候用

- 用户说「DSH 起不来 / 管理页打不开 / 启动就退 / 端口被占用」
- 用户说「插件没生效 / 技能不加载 / 页面功能少了」
- 用户让你先看看环境，或贴了一段看不懂的日志
- 你准备改 DSH-X 相关配置，动手前想确认当前事实（版本目录、DSH_HOME、profile、运行实例）

## 怎么跑

脚本在**本文件同目录**的 `scripts/selfcheck.mjs`，只用 Node 内置模块，无需安装依赖。先确定 skill 目录，然后：

```bash
node <skill目录>/scripts/selfcheck.mjs
```

它在 1 秒内跑完，默认输出中文人读报告。常用参数：

| 参数 | 作用 |
|---|---|
| `--json` | 输出机器可读 JSON（给 AI 解析用），字段契约见下 |
| `--verbose` | 人读报告里展开通过项明细 |
| `--net` | 额外探测外网/代理：管理页可用时 POST `/api/proxy/test`；未指定 `--port` 且管理页未连接时才由脚本直连探测，不走系统代理；指定端口但未连接时不直连，报告目标探测未执行 |
| `--no-logs` | 跳过日志分析（日志很大或用户不让读时） |
| `--port <n>` | 指定管理页端口（默认依次尝试 `PORT` 环境变量、settings.json、3780） |
| `--profile <name>` | 指定 profile（默认取管理页状态、settings.json、内置 `web`） |
| `--help` | 用法 |

退出码：

| 退出码 | 含义 |
|---|---|
| `0` | 全部正常，或只有提示（`info` 不改变退出码） |
| `1` | 有警告（多数不影响使用，报告里按 `→` 处理） |
| `2` | 有失败项（环境确实坏了） |
| `3` | 脚本自身出错（读参数/环境异常，看 stderr） |

先看 `FAIL`，再看 `WARN`，最后翻 `--verbose` 的细节。多数检查带分区名、证据（`|`）和处置建议（`→`）；正常项通常只有标题。

## JSON 怎么读

`--json` 输出：

```
{
  tool: "dsh-x-selfcheck", schema: 1, version, at, elapsedMs, platform,
  target: { managerUrl, managerVersion, managerFound, installDir, dataDir,
            dataDirSource, dshHome, dshHomeSource, profile, logsSource },
  checks: [{ id, section, status, title, detail, evidence, hint }],
  summary: { ok, info, warn, fail, verdict, exitCode }
}
```

`status` 是 `ok|info|warn|fail`；`target` 是这次自检认定的环境事实——写修复建议时以它为准，不要另猜 `dataDir`/`dshHome`。JSON 里进报告的文本会过一遍脱敏（常见 token / 密钥 / Authorization / Cookie 形态，凭据只报存在、不读内容），但它不是发布级审查：贴整段日志到公开渠道前先自己扫一眼。

## 九类检查与常见处置

- **环境**：平台/Node 版本、`%APPDATA%\DSH`（macOS 为 `~/Library/Application Support/DSH`，Linux 为 `~/.config/DSH`）里的 settings.json 是否合法、安装目录有没有自带 `node/` 运行时。Node < 22.18 会提示。
- **管理页**：端口上有没有 DSH-X 管理页（靠 `/api/ping` 的 `{app:'dsh-x'}` 辨认）、是否在安装/操作中、有没有自更新、**钉住的实例端口是否互相冲突**。端口被别的程序占了会直接报冲突者。
- **版本与数据**：dataDir 可读可写、剩余磁盘、`versions/<版本>` 是否完整（managed 版本要有 `node_modules/@deepseek-ai/dsh/lib/bin.js`）、`config.json` 记录的版本与磁盘差异。系统全局装的 dsh 不算 managed，属正常。
- **DSH_HOME / profile**：`~/.dsh`（或设置的 dshHome）可写性、`profiles/` 列表、所选 profile 的 `package.json`/`node_modules`、`cordis.patch.yml` 是否仍是顶层条目列表、`disabled: true` 行数、lock 文件属主是否还活着、补丁备份。`.credentials.yaml` 只报存在。
- **实例**：运行中的「版本 × profile」、上次启动失败记录（`failure.tail` 是服务端脱敏后的报错尾部，脚本进报告前再截断/脱敏）、`autoFix`（启动器自动禁用过哪些插件）、页面自检 health。
- **插件**：已装插件缺版本（`node_modules` 里没有）、被禁用、补丁层里的遗留 disable 行、autoFix、恢复档备份。
- **技能**：frontmatter 坏掉、同名技能跨根遮蔽、本自检技能有没有注册、本地技能发现是否被关、技能根里的空目录与断链。
- **网络与同步**：代理模式与下载源组合、云同步缺哪些项（只报缺项名，不报密钥）、`--net` 时的外网连通性。
- **日志**：最后 3000 行按 10 类模式聚合（启动失败、插件 import 失败、插件版本不兼容、找不到模块/junction 异常、页面自检失败、自动禁用、安全启动、端口占用、子进程非零退出、依赖修复）。**只有当前有实例在跑时**，超过 3 天的旧警告才会降级为「历史事件」；没有实例在跑时旧警告照样会报。

典型对应关系：

| 报告/日志信号 | 通常怎么办 |
|---|---|
| `cordis.patch.yml 不是合法的条目列表` | 仅发现顶层形状不符合预期，YAML 语法及字段未验证；列出文件和证据，由用户确认后自行处理，不据此恢复或改写配置 |
| `failed to import loader entry` / 插件 import 失败 | 插件树单点故障会让 dsh 秒退；去插件页关掉/重装对应插件 |
| `插件与 dsh 版本不兼容` | 日志拒绝了插件版本；保持当前 Harness，核对实际加载版本及来源，建议升级插件，或在依赖和必需性核实后由用户确认禁用/卸载；证据不足不执行 |
| `Cannot find module` / `-4094` / junction 读不了 | pnpm 链接悬空；管理页的启动自愈会处理，仍有问题再清 profile 的 `node_modules` 重装 |
| 端口已占用 | 看报告给的占用者；改设置里的实例端口，别和管理页端口撞 |
| `页面自检：…失败` | 客户端插件包缺失/损坏；按 health.failed 里的 URL 定位 |
| 技能根下大量没有 `SKILL.md` 的目录 | 不是技能，dsh 不会加载；可以清，不影响功能 |
| `本地技能行没有被强制启用` | 不一定是故障；能出现在技能列表里就说明 dsh 自己在扫。只有确实看不到本地技能时才去技能页打开「启用本地技能」 |

## 边界

- 未指定 `--port` 时，管理页没在跑仍可检查本地文件（settings、版本目录、profile、manager.log），实时状态未知。指定 `--port` 后只使用该目标提供的来源证据，不回退当前终端的配置、日志、用户目录或技能目录；缺证报告未核实。目标 `/api/settings` 返回的是有效设置，原始设置文件的位置及语法未验证。
- 日志默认走管理页 `/api/logs/export`（服务端已脱敏）；仅未指定 `--port` 时，接口不可用才回退本地 `manager.log.1` + `manager.log`。显式目标不可达或日志接口失败则报告缺少目标日志；进报告前脚本会再脱敏一遍。
- 不替代启动器自带的自检：页面自检、`/api/proxy/test`、启动自愈、恢复档各司其职，这个脚本只汇总事实。
- 不要为了自检去重启 dsh 或改 profile；报告只提示「哪里可能有问题」，改动前先征得用户同意。

## 安装/升级

- 管理页 → 技能 → 从 GitHub 导入，填仓库里的 `skills/dsh-x-selfcheck` 目录（tree URL），或
- 直接放进 `~/.dsh/skills/dsh-x-selfcheck/`（Windows 可用 junction 链到仓库，改动即生效）。
- 升级就是替换这一个目录；脚本无依赖、无构建步骤。
