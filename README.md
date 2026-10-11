# Plein

AI 无限画布：视觉创作 + 工作流编排，追求极致审美与丝滑体验。

## 结构

```text
apps/web              Vite + React 19 + Tailwind v4 前端
packages/canvas-core  画布内核：PixiJS v8（WebGPU 优先）+ 相机 + 输入
packages/doc          文档模型：Yjs（Element / Edge / Undo）
services/             后端服务（API、媒体处理）
```

## 开发

```bash
corepack enable          # 启用 pnpm（版本由 package.json 的 packageManager 锁定）
pnpm install
pnpm dev                 # http://localhost:5173
```

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
