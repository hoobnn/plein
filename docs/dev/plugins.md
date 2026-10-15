# 插件开发

plein 的节点、模型平台、模板、自定义元素类型都通过插件提供。内置功能和第三方插件走同一套 API（`packages/plugin-sdk`），所以内置插件就是最好的示例：

- 节点声明：`packages/nodes/src/core.ts`（插件 `plein/core`）
- 节点执行器：`apps/server/src/executors/core.ts`
- 模型平台：`packages/providers/src/mock/`（插件 `plein/mock`，开发测试用）
- 真实平台：`packages/providers/src/{minimax,doubao,bailian,ark}/`（配置与能力见 [模型平台接入](../guide/providers.md)）

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
| `engines.plein`       | 兼容的插件 API 版本范围，不满足时拒绝加载（版本策略见下）                                  |
| `contributes`         | 必须和实际注册的内容完全一致，多了少了都拒绝加载                                           |
| `permissions.network` | 可访问的域名，支持一级通配 `*.example.com`；重定向逐跳检查                                 |
| `permissions.secrets` | 可读取的密钥名（大写下划线），Provider 用到的密钥必须在这里声明                            |
| `permissions.assets`  | `none` / `read` / `write`：执行器读写资产库、Provider 读取参考图                           |
| `permissions.media`   | 执行器用宿主的 ffmpeg 读取媒体信息（`ctx.media.probe`）、合成视频（`ctx.media.compose`）   |

插件 API 的版本就是 `@plein/plugin-sdk` 的版本（`PLUGIN_API_VERSION`），Plein `v0.1.0` 发布时定为 `0.1.0`，此后按语义化版本演进：0.x 期间不兼容的改动升次版本号（`0.2.0`），兼容的新增和修复升修订号（`0.1.1`）。所以清单写 `^0.1.0` 只会匹配 `0.1.x`，API 出现不兼容改动时旧插件会被拒绝加载，不会在错误的假设下运行。

版本记录：

- `0.1.1` 新增配音模型的预置音色 `ModelSpec.voices`（可选字段，旧插件不受影响）。
- `0.1.2`（Plein 0.2.0）新增可选的模型版本 `ModelSpec.version` 与价格 `ModelSpec.price`、按幂等键查任务 `ProviderDefinition.lookup` / `idempotent` 与 `ProviderContext.idempotencyKey`、提交结果未知 `ProviderError.outcome: 'unknown'`，合成规格增加逐段转场、变速、音量包络与响度标准化，以及 `modelParamOf` / `withDefaultModel`；都是新增，旧插件不受影响。

## 节点

`defineNode` 声明类型、版本、端口和参数 schema。参数必须都有默认值；表单由 schema 自动生成，用 `.meta()` 提示控件：

- `title`、`placeholder`、`description`：标签与说明
- `widget: 'textarea'`：多行文本
- `widget: 'model'`：模型下拉框，列出已启用平台中支持节点 `capability` 的模型
- `widget: 'resolution'`：分辨率，选项来自所选模型的 `limits.resolutions`，空字符串表示平台默认；模型没声明时不显示
- `widget: 'modelOptions'`：模型专属参数，按模型引用分开存（`{ [模型引用]: {...} }`），执行器把所选模型那份作为 `extra` 传给 Provider；表单在参数面板的「<模型> 专属」里按模型的 `options` 生成
- `widget: 'hidden'`：不在生成器里显示（如分镜节点的 `shots`，由专门的表格编辑）

可选的 `applyOutputs(params, outputs)`：运行成功后返回要写回参数的部分，比如分镜节点把镜头表写回 `shots`。

参数或端口不兼容地变化时版本 +1，并提供 `migrate(params, fromVersion)`，画布上的旧节点在运行前自动升级参数。

执行器接收已校验的参数和上游输入，只能经过 `ctx.providers.call(能力, 模型引用, 输入)` 调用模型。宿主负责选平台、注入密钥、限流、轮询异步任务、取消，并把结果文件存入资产库，执行器获得的是资产引用。输出端口和类型会被校验。

输入值带 `source`（来自画布上哪个元素），同一端口连了多个上游时，执行器靠它对应参数里的设置（序列节点用它记每段镜头的入出点）。`source` 不计入缓存键。配音节点输出的语音带 `caption`（台词），下游可以直接用作字幕。

`execution` 决定节点怎么运行：`inline` 参数即结果，下游需要时就地计算（文本节点）；`job` 排队运行、结果存进节点、参与整组运行和缓存。默认有 `capability` 为 `job`，否则为 `inline`；不调模型但耗时的节点（序列导出）显式声明 `execution: 'job'`。

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
- `lookup(idempotencyKey, ctx)`（可选）：按幂等键查提交过的任务，找到返回 `{ remoteId }`，查不到返回 `null`（查不到不等于没受理，平台查询可能有延迟，只有同时声明了 `idempotent` 宿主才接着用同一个键提交，否则仍交给用户核查）；`idempotent: true`（可选）表示提交按 `ctx.idempotencyKey` 去重。两者都只在平台官方提供对应合同时声明。提交后没收到回应时，宿主有其一才自动核查或用同一个键重放，否则任务记为「提交结果未知」，等用户人工核查

没有免费远端鉴权探针时，声明 `testScope: 'configuration'`，设置页显示“检查配置”并说明未验证远端连接。不同鉴权方案可用 `credentialAlternatives` 声明任意一组必须完整填写的密钥，例如豆包 API Key 或 App ID + Access Key。

错误统一抛 `ProviderError(code, message)`，`code` 为 `auth`、`quota`、`rate_limit`、`invalid_input`、`content_policy`、`timeout`、`unavailable` 等，节点上据此显示原因，`rate_limit` / `unavailable` / `timeout` 默认可重试。请求可能已到平台却没拿到回应（提交时网络断开、响应读不出来）时带 `outcome: 'unknown'`，宿主不会把它当作没提交；共用的 `shared/http.ts` 对 POST 的传输失败已自动标上。

### 模型声明参数

每个模型可以声明两样东西，节点表单据此生成，不用为每个平台写界面：

- `limits`（`ModelLimits`）：对通用参数的约束，包括 `aspectRatios`、`resolutions`、`duration {min,max}`、`count {max}`、`seed`、`references {max}`、`speed {min,max}`、`instruction`。`seed`、`duration`、`speed`、`instruction` 可声明为 `false` 表示不支持：表单隐藏，宿主也不会传给 Provider。表单只显示支持的选项和范围；换模型时不合法的值自动校正并说明；提交前按它检查。
- `options`（zod object）：专属参数，字段名就是 `extra` 的键。字段都写成可选、不给默认值，表单会多一个「默认」选项，用户没改的不传，平台用自己的默认值；枚举可用 `.meta({ labels: { 值: '显示名' } })`。目录接口把它转成 `optionsSchema` 下发。
- `voices`（`VoicePreset[]`）：配音模型的预置音色，每个写明 `id`、`title`、`gender`（`female` / `male`）和可选的 `age`（`young` / `mature`）。生成设定卡时，宿主按角色的性别、年龄从排第一的配音模型的音色表里挑音色，同类音色轮着分，尽量一人一个声音；不声明的话角色卡的音色只能手填。

缓存键只算所选模型那份专属参数；分辨率留空、专属参数为空时不计入。

能力的输出约定：`audio.transcribe` 返回 `{ type: 'text' }` 全文，能给出时间轴时再加一条 `{ type: 'json', value: { segments } }`（`TranscriptSegment[]`，`start`、`end` 单位秒）；序列节点用它校字幕时间。`video.generate` 可以在视频之外再返回一张图片作为尾帧（如 Seedance 开了「返回尾帧」），生成视频节点从「尾帧」端口输出，可连到下一个镜头的首帧。`ctx.media.compose` 的 `transition` 支持 `fade`（经黑场，不改时长）和 `dissolve`（叠化，相邻镜头重叠）。

`ctx.fetch` 只能访问清单声明的域名，`ctx.secret(name)` 只能读声明过的密钥，`ctx.files.read` 需要 `assets` 权限。

## 加载与隔离

| 类型           | 方式                                                                                | 状态       |
| -------------- | ----------------------------------------------------------------------------------- | ---------- |
| 内置插件       | 主进程内加载，同一套注册表和权限裁剪                                                | 已完成     |
| 本地第三方插件 | 放进 `data/plugins/<id>/`，服务端部分在独立子进程运行，宿主代理网络、密钥和资产访问 | 已完成     |
| MCP 工具节点   | 把 MCP server 的工具包装成节点                                                      | 取消       |
| 自定义元素渲染 | 沙箱 iframe                                                                         | 0.1.0 之后 |

注册是原子的：清单不合规、贡献冲突、权限不足时整个插件标记为加载失败（设置页可见原因），不影响其他插件和服务启动。

### 本机第三方插件

完整示例在 [`examples/plugins/acme-echo`](../../examples/plugins/acme-echo)：两个节点（不调模型的「大声说」、调平台的「问一句」）、一个对话平台和一个提示词预设。

1. 写法和内置插件一样（`definePlugin` + `defineServerPlugin`），服务端入口最后调用 `servePlugin(serverPlugin)`（从 `@plein/plugin-sdk/child` 导入）。
2. 打包成一个不依赖 `node_modules` 的 ESM 文件，清单写 `"main": { "server": "dist/server.mjs" }`。示例用 `node examples/plugins/acme-echo/build.mjs <输出目录>` 打包。
3. 把文件夹（清单 + 入口）放进数据目录的 `plugins/` 下，到 设置 → 插件 → 重新扫描。插件默认不启用，列表里先显示它要的联网域名、密钥和素材权限，用户打开开关后才加载。

运行方式：每个启用的插件一个 Node 子进程，环境变量为空，和宿主之间走 IPC 消息。启动时子进程报上声明（zod schema 转成 JSON Schema），宿主按清单校验后注册；节点参数照样在宿主校验、补默认值。子进程崩溃时在途请求失败，下次请求再拉起；10 分钟内崩溃 3 次就停下，等用户重新加载。取消运行时先通知插件，5 秒没收手就结束进程。

宿主实际管住的：

- 文件：运行时支持 Node 权限模型（`--permission`）时，子进程只能读自己的文件夹，不能写文件、开子进程、起 worker、加载原生模块。设置里按子进程实测的结果显示「已隔离」「文件已隔离 · 网络未隔离」或「未隔离」。
- 联网和密钥：`ctx.fetch` 交给宿主代发，只放行清单声明的域名，重定向逐跳检查；密钥只按清单和本次调用送进子进程。
- 素材和模型：`ctx.assets`、`ctx.providers.call` 都经宿主，权限照清单裁剪；执行器只能输出本次运行里入库或输入进来的素材。

还管不住的：Node 25 之前的权限模型不限制网络，插件代码可以绕过 `ctx.fetch` 自己联网（设置里会标「网络未隔离」）；CPU 占用不设上限（内存上限 512 MB）。所以只装信任的插件。

暂不支持：自定义元素类型、能力（⌘K / 智能体操作）、节点的 `migrate` / `applyOutputs`、`ctx.media`。声明了这些的插件拒绝加载或在调用时报错。

## 接口

- `GET /api/catalog`：已安装的插件、节点（含参数 JSON Schema 与默认值）、平台、模板、元素类型
- `GET/PUT /api/providers/<vendor>/<name>/config`：平台开关、设置与密钥；密钥只回显是否已填，存在 `data/providers.json`（权限 600）
- `POST /api/providers/<vendor>/<name>/test`：测试连接
- `GET /api/plugins/local`：本机第三方插件列表（状态、权限、隔离程度、出错原因）
- `PUT /api/plugins/local/<vendor>/<name>`：`{ enabled }` 启用或停用；`POST …/reload` 重新加载；`POST /api/plugins/local/rescan` 重新扫描（都只限所有者）

开发时 `pnpm dev` 会加载 mock 平台（`apps/server/.env.development` 里的 `PLEIN_MOCK_PROVIDER=1`），无需任何密钥即可完整运行节点。
