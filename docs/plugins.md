# 插件开发

plein 的节点、模型平台、模板、自定义元素类型都通过插件提供。内置功能和第三方插件走同一套 API（`packages/plugin-sdk`），所以内置插件就是最好的示例：

- 节点声明：`packages/nodes/src/core.ts`（插件 `plein/core`）
- 节点执行器：`apps/server/src/executors/core.ts`
- 模型平台：`packages/providers/src/mock/`（插件 `plein/mock`，开发测试用）
- 真实平台：`packages/providers/src/{minimax,doubao,bailian,ark}/`（配置与能力见 [模型平台接入](providers.md)）

## 结构

一个插件分两部分：

| 部分                            | 内容                                   | 运行位置                                  |
| ------------------------------- | -------------------------------------- | ----------------------------------------- |
| 共用部分 `definePlugin`         | 清单、节点声明、模板、元素类型         | 前后端都可导入，只能是纯数据和 zod schema |
| 服务端部分 `defineServerPlugin` | Provider（模型平台适配器）、节点执行器 | 只在服务端                                |

```ts
import { defineNode, definePlugin, defineExecutor, defineProvider, defineServerPlugin } from '@plein/plugin-sdk'

export const plugin = definePlugin({
  manifest: {
    id: 'acme/tools',
    version: '1.0.0',
    name: 'Acme 工具',
    engines: { plein: '^0.1.0' },
    contributes: { nodes: ['acme/upper@1'], providers: ['acme/llm'] },
    permissions: { network: ['api.acme.com'], secrets: ['ACME_API_KEY'], assets: 'none' },
  },
  nodes: [upperNode],
})

export const serverPlugin = defineServerPlugin(plugin, {
  providers: [acmeProvider],
  executors: [defineExecutor(upperNode, async ({ params }) => ({ text: [{ type: 'text', text: params.text.toUpperCase() }] }))],
})
```

## 清单 `plein-plugin.json`

| 字段                  | 说明                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `id`                  | `vendor/name`，全小写。插件贡献的节点、Provider、模板、元素类型都必须在同一个 `vendor/` 下 |
| `version`             | 语义化版本                                                                                 |
| `engines.plein`       | 兼容的插件 API 版本范围，不满足时拒绝加载                                                  |
| `contributes`         | 必须和实际注册的内容完全一致，多了少了都拒绝加载                                           |
| `permissions.network` | 可访问的域名，支持一级通配 `*.example.com`；重定向逐跳检查                                 |
| `permissions.secrets` | 可读取的密钥名（大写下划线），Provider 用到的密钥必须在这里声明                            |
| `permissions.assets`  | `none` / `read` / `write`：执行器读写资产库、Provider 读取参考图                           |

## 节点

`defineNode` 声明类型、版本、端口和参数 schema。参数必须都有默认值；表单由 schema 自动生成，用 `.meta()` 提示控件：

- `title`、`placeholder`、`description`：标签与说明
- `widget: 'textarea'`：多行文本
- `widget: 'model'`：模型下拉框，列出已启用平台中支持节点 `capability` 的模型
- `widget: 'hidden'`：不在生成器里显示（如分镜节点的 `shots`，由专门的表格编辑）

可选的 `applyOutputs(params, outputs)`：运行成功后返回要写回参数的部分，比如分镜节点把镜头表写回 `shots`。

参数或端口不兼容地变化时版本 +1，并提供 `migrate(params, fromVersion)`，画布上的旧节点在运行前自动升级参数。

执行器拿到已校验的参数和上游输入，只能经过 `ctx.providers.call(能力, 模型引用, 输入)` 调用模型。宿主负责选平台、注入密钥、限流、轮询异步任务、取消，并把结果文件存入资产库，执行器拿到的是资产引用。输出端口和类型会被校验。

## 提示词预设

`definePromptPreset` 声明一条预设，用户在提示词框行首输入 `/` 选用，并在清单 `contributes.prompts` 里列出 id：

- `template`：插入的文本，`【…】` 是待填占位，插入后选中第一个
- `appliesTo`：适用的能力（`image.generate`）或节点类型（`plein/llm`），不填表示所有带提示词的节点
- `params`：选用时一并设置的参数，如 `{ aspectRatio: '1:1', count: 1 }`，节点没有的参数忽略

## 模型平台（Provider）

`defineProvider` 声明设置项（zod，设置页据此生成表单）、密钥、模型和每个模型支持的能力，实现：

- `submit(request, ctx)`：同步平台直接返回结果；异步平台返回 `remoteId`，宿主按 `pollAfterMs` 调 `poll`
- `poll(remoteId, ctx)` / `cancel(remoteId, ctx)`：任务被取消或超时时宿主会调 `cancel`
- `test(ctx)`：设置页的“测试连接”

没有免费远端鉴权探针时，声明 `testScope: 'configuration'`，设置页显示“检查配置”并说明未验证远端连接。不同鉴权方案可用 `credentialAlternatives` 声明任意一组必须完整填写的密钥，例如豆包 API Key 或 App ID + Access Key。

错误统一抛 `ProviderError(code, message)`，`code` 为 `auth`、`quota`、`rate_limit`、`invalid_input`、`content_policy`、`timeout`、`unavailable` 等，节点上据此显示原因，`rate_limit` / `unavailable` / `timeout` 默认可重试。

`ctx.fetch` 只能访问清单声明的域名，`ctx.secret(name)` 只能读声明过的密钥，`ctx.files.read` 需要 `assets` 权限。

## 加载与隔离

| 类型           | 方式                                                                                | 状态       |
| -------------- | ----------------------------------------------------------------------------------- | ---------- |
| 内置插件       | 主进程内加载，同一套注册表和权限裁剪                                                | 已完成     |
| 本地第三方插件 | 放进 `data/plugins/<id>/`，服务端部分在独立子进程运行，宿主代理网络、密钥和资产访问 | M5         |
| MCP 工具节点   | 把 MCP server 的工具包装成节点                                                      | M5         |
| 自定义元素渲染 | 沙箱 iframe                                                                         | 0.1.0 之后 |

注册是原子的：清单不合规、贡献冲突、权限不足时整个插件标记为加载失败（设置页可见原因），不影响其他插件和服务启动。

## 接口

- `GET /api/catalog`：已安装的插件、节点（含参数 JSON Schema 与默认值）、平台、模板、元素类型
- `GET/PUT /api/providers/<vendor>/<name>/config`：平台开关、设置与密钥；密钥只回显是否已填，存在 `data/providers.json`（权限 600）
- `POST /api/providers/<vendor>/<name>/test`：测试连接

开发时 `pnpm dev` 会加载 mock 平台（`apps/server/.env.development` 里的 `PLEIN_MOCK_PROVIDER=1`），不需要任何密钥就能跑通节点。
