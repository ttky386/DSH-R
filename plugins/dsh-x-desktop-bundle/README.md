# dsh-x-desktop-bundle

DSH-X 桌面插件组。**一个包挂全组**：profile 的依赖与层栈里只出现这一个名字，成员作为它的依赖装进来。

首版成员：

| 成员 | 提供什么 |
|---|---|
| [`dsh-x-desktop-notify`](../dsh-x-desktop-notify/README.md) | 宿主侧原生通知（一轮结束、等待确认）+ `dshDesktop` 服务（notify / open / reveal / clipboard / dialog） |

## 为什么是「组」

一个功能一个包，但用户不该为每个包各改一次 profile。组包负责挂载：它的 `cordis.patch.yml` 把成员的 row 按顺序插进层栈，用户只加一个依赖。

以后加成员，只动两处：

1. `package.json` 的 `dependencies` 加一行（版本钉 `^x.y.z`）；
2. `cordis.patch.yml` 加一段 `insert`，把成员自己的 row 抄过来（`id` 保持成员包里那个）。

用户侧不用重新理解安装方式。

## 装法

```sh
dsh plugin --profile web add dsh-x-desktop-bundle
```

装完重启 dsh。层栈里会出现 `dsh-x-desktop-bundle` 一项；成员的 row 由它带进来。

**别单独再装成员**。`dsh plugin add dsh-x-desktop-notify` 会让它成为 profile 的直接依赖，dsh 的 bundle 重算看到它自带 `dsh.bundle.patch`，会把它也加进层栈——同一条通知就挂两遍、响两次。要调某个成员，用组包 patch 里的 `config` 覆盖，不要单独装。

## 和整合包 / 内置的关系

- **整合包**（`.dspack`）要带这个组时，`dependencies` 和 `bundles` 都只写 `dsh-x-desktop-bundle` 一行，不展开成员。
- **内置**：组包就是以后随安装包走的那个单元。改成 `file:<安装目录>/…` 的本地源即可，成员和挂载方式都不用变。

## 版本

- 组包自己的版本按「组成员或默认配置有变化」提；
- 成员用 `^` 钉范围，成员单独发版后，重装一次 `dsh plugin install` 就能拿到；
- 组包不重复成员的 README 与配置说明，细节看成员自己的文档。

## 许可

MIT。
