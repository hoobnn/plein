# 智能体与 MCP

Plein 里的智能体叫「小满」，在画布右下角。它和画布上的按钮用的是同一套能力（`packages/capabilities`）：读画布、新建和修改节点、连线、运行节点或整组、查看生成结果、加工素材（截取、变速、抽帧、分离音轨等）、批量跑分镜、读写资产库。改动按轮记录，可以整轮撤销，改过的元素会在画布上高亮。

## 三种驱动方式

| 方式                     | 用什么模型                                                                                                                               | 适用场景                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 内置智能体               | 已启用平台里支持工具调用的对话模型（如百炼的千问）                                                                                       | 不想装 CLI；开启登录的远程部署里也能用                          |
| 本机 Claude Code / Codex | 这台电脑上已安装、已登录的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex](https://github.com/openai/codex) CLI | 想用自己的订阅额度，或需要 CLI 自带的 MCP、skill 和本机文件操作 |
| 对外开放 MCP             | 外部 AI 应用自己的模型                                                                                                                   | 在 Claude Desktop、Claude Code、Cursor 里直接操作 Plein 画布    |

通用行为：

- 花钱（运行生成）和删除前先在面板里出确认卡片。
- 计划模式：先列计划，同意后执行并逐步打勾。
- 选中画布元素再提问，选区会作为上下文发过去；多选工具条上的「让小满处理」会带着选区打开面板。
- 插件可以贡献能力，出现在 ⌘K 命令面板和智能体的工具里，见 [plugins.md](../dev/plugins.md)。

## 本机 CLI

Plein 不读取也不保存 CLI 的登录凭据，用的是你在终端里的同一个账号和额度。

- 只在免登录模式（桌面端或本机部署）可用；开启登录后自动关闭，因为智能体以服务端进程的身份在这台机器上运行。设 `PLEIN_AGENT=0` 可以关闭。
- 服务端在本机 `/mcp` 提供画布工具（MCP，Streamable HTTP），每个对话一个随机令牌；除此之外 CLI 照常加载用户自己的账号、MCP、skill 和配置。
- 每个对话一个长驻进程：Claude Code 用 `claude -p --input-format stream-json --output-format stream-json`，Codex 用 `codex app-server`；进程退出后用 CLI 自己的会话 id 续聊。对话记录存在数据库里，工作目录是 `<数据目录>/agent`。
- 本机权限两档：「本机操作先问我」时 CLI 改文件、跑命令前在面板里出确认卡片（Claude 用 `--permission-prompt-tool stdio`，Codex 用 `on-request` + `workspace-write` 沙箱）；「本机操作不用问」对应 `--dangerously-skip-permissions` 和 `never` + `danger-full-access`。
- 设置 →「本机 AI」显示两个 CLI 的路径、版本、登录状态，对比 npm 上的 dist-tags 提示新版本（Claude Code 本地领先 latest 时也看 next），可以一键运行更新命令。

## 对外开放 MCP

设置 →「MCP」生成一个长期令牌，按客户端（Claude Code、Claude Desktop、Cursor 等）复制对应的连接配置。外部应用拿到的是和小满相同的全部能力；不传 `canvas_id` 时操作你正在看的那块画布，没有打开的就用最近改过的。

- 同样只在本机免登录模式开放。
- 令牌只在生成时显示一次，服务端只保存它的 SHA-256；重新生成会让旧令牌失效。
- 外部应用的改动不进任何会话的撤销栈，确认交给外部应用自己的界面。
