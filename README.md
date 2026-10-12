# Plein

AI 无限画布：视觉创作 + 工作流编排，追求极致审美与丝滑体验。

## 结构

```text
apps/web              Vite + React 19 + Tailwind v4 前端
apps/server           本地服务：Hono（Node）+ SQLite + Yjs 同步 + 资产 + Better Auth
packages/canvas-core  画布内核：PixiJS v8 + 相机 + 输入
packages/doc          文档模型：Yjs（Element / Edge / Undo）
packages/protocol     前后端共享的接口约定（zod）
```

## 本地部署

```bash
docker compose up -d     # 打开 http://localhost:8787
```

画布、素材和数据库都在 `plein-data` 卷里，备份它即可。默认只绑定本机且免登录；要让其他设备访问，按 `compose.yaml` 里的注释改端口并删掉 `PLEIN_AUTH`，首次访问会要求创建所有者账号。

不用 Docker 时：`pnpm install && pnpm build && pnpm start`（需要本机装好 ffmpeg，用于视频封面和音频波形）。

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PLEIN_HOST` / `PLEIN_PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `PLEIN_DATA_DIR` | `./data` | 数据目录 |
| `PLEIN_AUTH` | 本机地址为 `none`，否则 `password` | `password` 时用 Better Auth 登录，只允许一个所有者账号 |
| `PLEIN_PUBLIC_URL` | 按请求推断 | 反向代理后的对外地址 |
| `PLEIN_ALLOWED_HOSTS` | 空 | 免登录模式下额外允许的主机名，逗号分隔 |
| `PLEIN_MAX_UPLOAD_MB` | `2048` | 单个文件上限 |

## 开发

```bash
npm i -g pnpm@12         # 版本由 package.json 的 packageManager 锁定
pnpm install
pnpm dev                 # 前端 http://localhost:5173 + 服务端 :8787（数据在 ./data）
pnpm lint                # Biome 检查（pnpm format 自动修复）
pnpm typecheck
pnpm test                # Vitest
```

性能演示画布不依赖服务端：`http://localhost:5173/#/demo?n=5000`。

## 原则

- 相机与渲染不走 React state，拖动/缩放期间 React 零重渲染
- 二进制资源不进 Yjs 文档，只存 assetId
- 渲染：GPU 画内容，DOM 覆盖层负责编辑与表单（按 LOD 挂载）

## 分支规范

遵循 [Conventional Branch](https://conventionalbranch.org/)：`<type>/<description>`，全小写、连字符分隔。

- type：`feature`/`feat`、`bugfix`/`fix`、`hotfix`、`release`、`chore`；AI 代理自建分支用 `claude/`、`codex/`、`copilot/`、`cursor/`、`ai/`
- 主干 `main` 不加前缀
- 示例：`feature/add-login-page`、`fix/edge-hit-test`、`release/v1.2.0`

三层强制：husky `pre-push` 本地拦截；GitHub 规则集（`.github/rulesets/conventional-branch.json`）禁止创建前缀不合规的分支；`Branch name` CI 用完整正则校验 PR 分支。

## 许可证

[GNU AGPL v3.0](LICENSE)：允许商用、修改与分发，但衍生作品（包括通过网络提供的服务）必须以相同许可证开源。
