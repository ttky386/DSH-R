# 发布清单（dsh-x-desktop-notify）

插件本身已经能装能用：`dsh plugin --profile <名字> add <本地路径>` 在真 dsh 上装载过，`node --test` 全绿。差的是「发给别人」那几步，都要用你自己的账号。

## 1. 发布到 npm

```sh
cd plugins/dsh-x-desktop-notify
npm publish --access public        # 包名 dsh-x-desktop-notify 若被占，改名后同步 package.json / cordis.patch.yml / README
```

发布前过一遍：

- `npm test` 全绿；
- `files` 只带 `lib`、`cordis.patch.yml`、`README.md`、`LICENSE`（不含 `test/`）；
- `dsh.bundle.patch` 指向的 `cordis.patch.yml` 在包里，且 `keywords` 带 `dsh-plugin`（市场收录要求）。

## 2. 上插件市场

`package.json` 的 `dshhub` 字段（displayName / summary / categories）就是市场条目要用的文案；向市场仓库提 PR 加条目即可。

## 3. 接进 DSH-X 桌面工作台整合包

组包 `dsh-x-desktop-bundle` 发布后，包里只写组，不展开成员。改 `packs/dsh-x-workbench/manifest.json` 两处：

```diff
-    "dsh-plugin-notify-sounds": "^1.9.0"
+    "dsh-x-desktop-bundle": "^0.1.0"
```

`bundles` 同样换名，`version` 从 `1.0.0` 提到 `1.1.0`，然后：

```sh
node scripts/make-pack.mjs packs/dsh-x-workbench
```

两件别同时装：`dsh-plugin-notify-sounds` 的页面通知和本插件会各响一次。要保留页面那件的提示音/标题前缀，就在它的设置里关掉系统通知。

**发布顺序**：先 `dsh-x-desktop-notify`，再 `dsh-x-desktop-bundle`（组包依赖成员）。反过来组包装不上。

## 4. 与 DSH-X 的关系

- 插件只认 `DSH_X_MANAGER_URL` + `DSH_X_DESKTOP=1`；协议在 `docs/desktop-api.md`，本包只是它的一个客户端。
- 核心和外壳是两层：`/api/desktop` 的路由在核心（`server.js`），真正的 Notification 在外壳（`shell/main.mjs`）。发布时两层版本都要到位，否则旧壳回 503、旧核心回 404。
- 插件不 import Electron、不 import `shell/`，只在 host 侧走本机 HTTP——和 AGENTS.md 的分层约束一致。
