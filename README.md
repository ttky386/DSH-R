# DSH-R

DSH-R 是 [DSH-X 启动器](https://github.com/yyh-001/DSH-X) 的二次开发项目，专注于把原本偏本机管理的 DSH-X 扩展为可以安全管理远程 Linux DSH 的桌面控制端。

它不是 DSH-X 原作者维护的官方主线，也不是 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)或 DeepSeek 官方产品。上游项目均采用 MIT License，本分支保留同一许可证与作者声明。

## 二开声明

- 原项目：**DSH-X** —— <https://github.com/yyh-001/DSH-X>
- DSH 上游：**DeepSeek Harness** —— <https://github.com/deepseek-ai/deepseek-harness>
- 当前二开基线：DSH-X `v0.1.26-rc.4`
- 项目关系：DSH-R 在 DSH-X 的基础上扩展远程管理能力，不替换 DSH-X 官方仓库，也不冒充上游发布通道。
- DSH-R 启动的仍是 DSH 官方原版 Web 界面；本项目只负责安装、启动、配置和管理，不重写 DSH 的聊天界面。

## 功能说明

### 继承的 DSH-X 本机能力

- 启动项与多实例管理
- DSH 版本安装、更新、卸载与回退
- Profile / 用户目录管理
- 插件、整合包、MCP 与技能管理
- 桌面增强插件：原生通知、右键菜单、侧栏浏览器
- 本机日志、恢复、自更新与多平台桌面外壳

### DSH-R 扩展能力

- **远程 Linux 管理**：Windows 控制端通过 OpenSSH 密钥或 ssh-agent 管理远端 Linux DSH，不保存 SSH 密码。
- **远端只运行 DSH 本体**：远端不安装 DSH-X，不开放 DSH-X API；操作由 SSH 调用受限远端 agent 完成。
- **远程版本管理**：支持安装、删除、替换、优化远端 DSH 版本，并同步修正本地启动项引用。
- **远程 Profile 管理**：支持远端 Profile、配置、依赖、插件、整合包、MCP、技能、恢复档和日志管理。
- **远程文件工作流**：复用 DSH 官方 `file-upload`、`workspace-files`、`sidebar-files`、`documentpreview`、`file-reference` 插件；拖入会话的文件直接流式上传到远端，DSH-X 内可浏览和预览远端 `DSH_HOME` 下的文件。
- **远程 Shell**：内置完整 PTY 终端，支持交互式命令、会话保留和窗口尺寸调整。
- **远程访问适配**：远端 DSH 绑定回环，由远端 reverse-forward 监听 VPN / 局域网地址并改写请求头，适配部分 loopback-only 插件。
- **远程页面集成**：远端 DSH 页面进入 DSH-X 内部标签页，与托盘、实例状态和访问链接共用同一套界面。
- **Linux 桌面支持**：补齐 Linux AppImage / deb 打包、XDG 目录、桌面集成和文件管理适配。
- **Windows 安装器加固**：改进安全退出、残缺旧安装修复、离线核心替换和统一安装位置。

## 功能边界

- 远程控制端主要面向 Windows，远端目标面向 Linux x64 / arm64。
- 远程连接只支持可用 SSH 密钥、ssh-agent 或 OpenSSH 配置，不支持保存或自动填写 SSH 密码。
- 远程桌面通知、剪贴板、文件对话框等插件桌面 API 尚未桥接到 Windows。
- 远程文件面板是只读浏览和受限预览，不允许任意路径写入、删除或重命名；敏感凭据文件会被拒绝读取。
- 拖拽上传、文件树、右侧栏预览和路径点击依赖 DSH 官方插件。
- reverse-forward 只处理 HTTP / WebSocket，不是通用 TCP 代理。
- 当前项目名为 DSH-R，但部分内部包名、进程名和安装器显示仍沿用 DSH-X / DSH；完整品牌重命名尚未执行。
