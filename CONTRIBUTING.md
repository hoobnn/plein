# 参与开发

## 环境

- Node ≥ 24（版本写在 `.node-version`）；pnpm 版本由 `package.json` 的 `packageManager` 锁定
- ffmpeg / ffprobe：生成视频封面、音频波形和导出成片都要用到；烧字幕需要带 libass 的构建

```bash
npm i -g pnpm@12
pnpm install
pnpm dev                 # 前端 http://localhost:5173 + 服务端 :8787（数据在 ./data）
```

性能演示画布不依赖服务端：`http://localhost:5173/#/demo?n=5000`。

## 常用命令

| 命令                 | 作用                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| `pnpm lint`          | Vite+ 检查（Oxfmt 格式 + Oxlint 规则）加 markdownlint                                   |
| `pnpm format`        | 格式化代码，并应用能安全自动修复的规则，包括 markdownlint 能自动修的项                  |
| `pnpm typecheck`     | 全部包的类型检查                                                                        |
| `pnpm test`          | Vitest 单测与集成测试                                                                   |
| `pnpm test:coverage` | 统计全部应用及公共包源码覆盖率，执行覆盖率门槛，输出 `coverage/index.html` 与 JSON 汇总 |
| `pnpm smoke`         | 启动真实服务，经 HTTP 和 Yjs WebSocket 读写，重启后确认数据没丢                         |
| `pnpm verify`        | 依次运行 lint、typecheck、test:coverage、smoke，pre-push 钩子自动运行                   |
| `pnpm e2e`           | Playwright 界面冒烟：基于 mock 平台覆盖从短剧模板到导出的完整流程                       |
| `pnpm perf`          | 画布渲染性能基准                                                                        |

本地检查由 git 钩子（husky）完成，`pnpm install` 时自动装好：pre-commit 运行 `vp staged`，只格式化、检查暂存文件；pre-push 运行 `pnpm verify`，改了 `package.json` 或 `pnpm-lock.yaml` 时再跑 `pnpm audit:deps`。推送 main 不触发云端 CI，云端只在 Dependabot PR、打 `v*` 标签发版和手动运行（Actions → CI → Run workflow）时跑完整检查与 e2e、perf（e2e 按文件分 12 片并行，失败重试一次，重试才通过的标为 flaky）；发版说明写在 `docs/releases/<标签>.md`，打标签时自动用作 Release 正文；依赖安全检查另有每周定时。急用可 `git push --no-verify` 跳过钩子，之后在 Actions 里手动补跑一次 CI。

验收分四层：单测、集成、启动冒烟、真实样例，各层的准入和写法见 [docs/acceptance-0.1.0.md](docs/plan/acceptance-0.1.0.md)。

工具链是 [Vite+](https://viteplus.dev)（命令 `vp`）：Oxfmt 负责格式化代码、样式、Markdown、YAML 和 HTML，Oxlint 做代码检查（含类型感知规则），Vitest 运行单元测试，`vp pack`（tsdown）打包服务端和桌面端。规则和格式选项都写在根目录的 `vite.config.ts`。

覆盖率包括未被测试导入的 `apps/*/src` 和 `packages/*/src` 源码，只排除测试、类型声明、生成代码及测试辅助文件。桌面端也属于测试项目。CI 和 `pnpm verify` 使用同一套覆盖率门槛：全局底线防止回退，本次收敛的调度、输入准备、列表快照及桌面状态模块另设更高门槛。单元测试覆盖率和浏览器端到端测试分别计数，不能把 mock 平台通过解释为真实平台验收。当前范围、证据和覆盖缺口见[结构优化记录](docs/dev/refactoring-2026-10-17.md)。

格式化遵循 `.gitignore`，排除构建产物；`pnpm-lock.yaml` 保留 pnpm 自己生成的格式。Markdown 段落不强制折行，代码块和 HTML 里内嵌的代码不做二次格式化。Markdown 规则另由 markdownlint 检查，配置在 `.markdownlint.jsonc`，VS Code 的 markdownlint 插件读取同一份配置。

## 代码结构

```text
apps/web               Vite + React 19 + Tailwind v4 前端
apps/server            本地服务：Hono（Node）+ SQLite + Yjs 同步 + 资产 + 任务队列 + Better Auth
apps/desktop           Electron 外壳，在 utilityProcess 里运行 apps/server
packages/canvas-core   画布内核：PixiJS v8 + 相机 + 输入
packages/doc           文档模型：Yjs（Element / Edge / Undo）
packages/flow          工作流：依赖图、执行顺序、按依赖调度、缓存键
packages/nodes         内置节点声明（plein/core）、短剧模板与提示词
packages/capabilities  画布能力层：界面、⌘K、智能体和对外 MCP 共用
packages/protocol      前后端共享的接口约定（zod）
packages/plugin-sdk    插件 API：清单、节点、Provider、执行器
packages/providers     模型平台适配器（服务端）：MiniMax、豆包语音、百炼、火山方舟及 mock
```

应用内部按领域组织：

```text
apps/web/src
  canvas/      画布接线与元素操作：CanvasView、节点卡片、覆盖层、导入、宫格、分组
  shell/       编辑器外壳：工具栏、侧栏、菜单、选区条、结果条、命令面板
  features/    功能域，组件、store 与领域逻辑放在一起：agent、library、sequence、
               storyboard、generator、runs、templates、settings、projects、onboarding
  stores/      跨功能的全局状态：canvas、catalog、session、sidebar、theme、assetMeta
  ui/          通用控件，不含业务流程
  pages/       路由页面：Home、Editor、Login、ProjectOpen
apps/server/src
  <领域>/      每个领域一个目录，路由统一叫 routes.ts：agent、assets、canvases、library、
               mcp、plugins、projects、prompt、runs、sync、templates
  http/        HTTP 基础设施：来源校验、文件响应
  storage/     SQLite schema、迁移与数据访问
```

包之间的依赖只能自上而下：`apps/*` → `capabilities` / `providers` / `protocol` → `nodes` / `canvas-core` / `flow` → `doc` / `plugin-sdk`。`doc`、`canvas-core`、`flow`、`nodes` 不依赖 React 和 Node 专属 API，前后端、Worker 和测试都能直接用。

设计取舍见 [architecture.md](docs/dev/architecture.md)，界面规范见 [design-spec.md](docs/dev/design-spec.md)。几条硬约束：

- 相机与渲染不走 React state，拖动 / 缩放期间 React 零重渲染
- 二进制资源不进 Yjs 文档，只存 assetId
- GPU 画内容，DOM 覆盖层负责编辑与表单（按 LOD 挂载）

## 桌面端

```bash
pnpm dev:desktop         # Vite + Electron；服务端直接运行源码，接口经 Vite 代理到 :8787
pnpm start:desktop       # 先构建服务端和前端，再用构建产物启动（与安装包的运行方式一致）
pnpm dist:desktop        # 出 macOS 安装包（Apple 芯片），没有证书时 ad-hoc 签名
```

桌面端保留系统原生标题栏和窗口按钮：macOS 使用系统菜单栏、⌘ 快捷键，关闭窗口后应用继续运行，可从 Dock 重开；Windows 使用窗口菜单栏、Ctrl 快捷键和系统窗口布局，关闭最后一个窗口即退出。菜单中的撤销、重做和全选会作用于当前画布或文本编辑器，设置可用 `CmdOrCtrl+,` 打开。窗口位置、尺寸和最大化状态保存在应用数据目录的 `window-state.json`；显示器变化时会将窗口移回可见工作区。开发工具菜单仅在开发模式显示。

首次运行会下载 Electron。服务端只接受桌面端窗口的请求（每次启动生成的令牌放在窗口 Cookie 里），所以开发模式下用普通浏览器打开 5173 会返回 403。ffmpeg 构建、打包和签名发布见[桌面端文档](docs/dev/desktop.md)。

## 分支

分支名遵循 [Conventional Branch](https://conventionalbranch.org/)：`<type>/<description>`，全小写，单词之间用连字符。

- type 可选 `feature`/`feat`、`bugfix`/`fix`、`hotfix`、`release`、`chore`；AI 代理自己建的分支用 `claude/`、`codex/`、`copilot/`、`cursor/`、`ai/`
- 主干 `main` 不加前缀
- 示例：`feature/add-login-page`、`fix/edge-hit-test`、`release/v1.2.0`

命名规则有三道关卡：本地由 husky `pre-push` 拦截；GitHub 规则集（`.github/rulesets/conventional-branch.json`）不允许创建前缀不合规的分支；PR 分支再由 `Branch name` CI 用完整正则校验一遍。

Dependabot 自动创建的 `dependabot/*` 分支是保留的例外，PR 检查会同时核验作者必须为 `dependabot[bot]`；手动使用该前缀创建的 PR 仍会被命名检查拒绝。

## 提交

提交信息的格式是 `<emoji> type(scope): 中文描述`，例如 `✨ feat(canvas): 新增小地图`。type 和 emoji 一一对应，由 husky `commit-msg` 钩子里的 commitlint 校验，完整对照表见 `commitlint.config.cjs`。

## 依赖检查

- Dependabot 每周一北京时间 09:00 检查整个 pnpm workspace 和 GitHub Actions，有更新时自动创建 PR。生产依赖和开发依赖的 minor / patch 各自分组更新，major 单独评审；所有更新都不自动合并。
- `Dependency security / dependency-review` 检查 PR 新引入的依赖，带进 high / critical 漏洞就失败。
- `Dependency security / dependency-audit` 用原生 `pnpm audit` 检查整份锁文件，生产、开发和间接依赖都覆盖到。它在 PR、推送 main、每周定时和手动触发时运行；发现 high / critical 漏洞就阻断，审计服务本身报错也按失败处理。本地可以运行 `pnpm audit:deps`。

pnpm 12 的锁文件包含多份 YAML 文档，上游的依赖图解析对此还有[兼容问题](https://github.com/dependabot/dependabot-core/issues/15904)，所以保留原生审计来补足依赖图覆盖不到的部分。两项检查都基于已知漏洞数据库，通过不代表依赖风险已经全部排除。要真正阻止带漏洞的 PR 合并，还需要在 main 的合并规则里把这两个 job 设为必需检查。
