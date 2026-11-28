# 智能体与 MCP

Plein 里的智能体叫「小满」，在画布右下角。它和画布上的按钮调用同一套能力（`packages/capabilities`），支持的操作包括：读取画布、新建和修改节点、连线、运行单个节点或整组、查看生成结果、加工素材（截取、变速、抽帧、分离音轨等）、批量生成分镜、读写资产库。它的改动按轮记录，可按轮整体撤销，改过的元素会在画布上高亮；撤销只回退画布，已提交的生成任务和费用记录会保留，不会退还平台费用。

## 三种驱动方式

| 方式                     | 用什么模型                                                                                                                               | 适合什么时候用                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 内置智能体               | 已启用平台里支持工具调用的对话模型（如百炼的千问、方舟 Agent Plan 的套餐文本模型）                                                       | 无需安装 CLI；开启登录的远程部署中同样可用                      |
| 本机 Claude Code / Codex | 这台电脑上已安装、已登录的 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex](https://github.com/openai/codex) CLI | 想用自己的订阅额度，或需要 CLI 自带的 MCP、skill 和本机文件操作 |
| 对外开放 MCP             | 外部 AI 应用自己的模型                                                                                                                   | 在 Claude Desktop、Claude Code、Cursor 里直接操作 Plein 画布    |

三种入口使用同一套能力。确认方式随入口和助手设置而定。

- 内置助手和本机 CLI 按所选确认模式执行。外部 MCP 使用规则模式，通过工具回执向外部应用请求确认。单次图片、文本或配音生成可以直接产生费用。
- 计划模式：先列出计划，经确认后执行，并逐项标记完成进度。
- 修改方案：修改已有镜头或节点（如“让第三镜头更紧张”）时，先给出方案卡片，列出要改的字段（前后值）、改完后实际送入的参考、会重新生成的节点、保留项和预计调用次数与费用。批准前可以逐项编辑：点字段旁的笔改成自己的写法、点叉去掉某项改动（都会重新检查参考、要重做的节点和费用），不勾某个镜头或某个要运行的节点（估算跟着变，不勾的节点保留当前结果）。然后只改文字（不调用平台）、只出候选图或执行完整方案；批准时目标已经变了就不执行旧方案。对外 MCP 用 `propose_edit` / `apply_edit_plan` 两个工具，由外部应用确认范围（`only` 选目标、`skip` 跳过步骤）。
- 先选中画布元素再提问，选区会作为上下文一起发过去；多选工具条上的「让小满处理」会带着选区直接打开面板。
- 插件也可以贡献能力，它们会出现在 ⌘K 命令面板和智能体的工具里，见 [plugins.md](../dev/plugins.md)。

## 本机 CLI

Plein 不读取、也不保存 CLI 的登录凭据，用的就是你在终端里登录的那个账号和额度。

- 只在免登录模式（桌面端或本机部署）下可用。智能体以服务端进程的身份在这台机器上运行，所以一旦开启登录，这个功能会自动关闭。设 `PLEIN_AGENT=0` 也可以手动关掉。
- 服务端在本机的 `/mcp` 端点提供画布工具（MCP，Streamable HTTP），每轮分配独立的随机令牌；结束或停止后令牌失效。除此之外，CLI 照常加载你自己的账号、MCP、skill 和配置。
- 每轮对应一个独立进程：Claude Code 用 `claude -p --input-format stream-json --output-format stream-json`，Codex 用 `codex app-server`。下一轮通过 CLI 自身的会话 id 恢复上下文，旧轮的回调、审批和异步写入不能归到新轮。对话记录存在数据库里，工作目录是 `<数据目录>/agent`。
- 本机权限分两档。选「本机操作先问我」时，CLI 修改文件或执行命令之前会先在面板里弹出确认卡片（Claude 用 `--permission-prompt-tool stdio`，Codex 用 `on-request` + `workspace-write` 沙箱）；选「本机操作不用问」则对应 `--dangerously-skip-permissions` 和 `never` + `danger-full-access`。
- 设置 →「本机 AI」里能看到两个 CLI 的路径、版本和登录状态。Plein 会对照 npm 上的 dist-tags 提示新版本（Claude Code 本地版本比 latest 还新时，也会对照 next），可以一键运行更新命令。
- 更新会沿用检测到的安装方式：Homebrew、npm 全局安装，以及 macOS/Linux 上的 Codex 官方独立安装包。独立安装包会重新运行[官方安装器](https://developers.openai.com/codex/cli/#getting-started)，保留原来的包目录和命令入口；无法确认安装来源时提示手动更新。

## 执行记录与上下文

输入框上方的「对话模型」管理当前会话使用的模型，与画布节点的默认生成模型分开。新对话按智能体记住上次选择；打开历史对话时恢复该会话自己的设置。切换模型会先保存，再允许发送，草稿保留；运行中不能更改模型或重置上下文。

- 内置目录只列出已启用平台中支持工具调用的对话模型（含 Agent Plan 的内置及自动发现套餐文本模型）；可直接选择，也可跟随平台默认。平台默认不支持工具调用时，助手会使用目录中第一个支持的模型。
- Codex 通过本机 `app-server` 的 `model/list` 读取模型及各模型支持的推理强度。选择具体模型后，才能选择它支持的推理强度；切换模型会恢复默认推理。目录读取本身不发送生成请求。目录失败或保存的型号已不在目录时会明确提示，可重新读取或重新选择。
- Claude Code 列出 `sonnet`、`opus`、`haiku` 稳定别名，由 CLI 决定具体版本；列出别名不代表账户已经获得对应模型权限。

CLI 会记住会话里的模型覆盖。为可靠地恢复本机配置，从指定模型切回「跟随 CLI 配置」会重新建立模型上下文，并在记录里标出边界；画布和旧记录保留。Codex 指定模型但推理强度留默认时，使用目录报告的该模型默认强度；如果目录未提供默认值，移除已有强度也会重新建立上下文。

「上下文管理」可查看当前模型、系统指令、画布读取方式、本轮选区和用量。画布按需读取；选中元素仍可通过输入框旁的叉移除。

- 内置助手显示最近请求在历史预算裁剪后的本地 token 与文本字节估算，包含系统指令、对话及工具定义。请求预算按模型声明的上下文窗口推出：窗口减去为输出预留的 token（模型最大输出与 8,192 取小）；模型没有声明窗口（自动发现的模型、自定义模型）时按 96,000 tokens，面板会写明「模型未声明上下文窗口，按默认预算」。文本字节上限只做健全性检查，取 256 KiB 与预算 token 数的 4 倍中较大者（未声明窗口的模型固定 256 KiB）。省略的完整历史组会单独说明。模型调用结束后，平台若报告了真实输入 token，就改用真实值（面板标为「模型报告」），并用它和同一请求的本地估算之比校准之后的估算（只修正估算，不会突破预算上限；比值明显偏离时不采纳，重启后重新积累）；每次模型调用的耗时、重试和用量，以及每个工具调用的耗时，随本轮执行事实一起保存。
- 内置助手会自动压缩上下文：新一轮开始前，如果历史连同系统指令和工具定义超过请求预算的 60%（默认），或已攒满 32 轮，就用当前对话模型把较早的轮次写成一份摘要；最近的几轮（至少一轮）在预算内原样保留，并留出余量，让后面几轮攒起来再压缩。摘要记下用户的目标与偏好、已建和已改的元素及任务 id、做过的决定和未完成的事；它只是记录，不构成新的授权。之后每次请求都带上这份摘要，再次压缩时与新的较早轮次合并。压缩期间对话里显示提示，完成后「上下文管理」会写明压缩时间和轮数；完整对话与执行事实仍保存在本地。压缩会多一次模型调用，摘要请求同样受该模型的预算约束；失败时本轮照常进行，按预算省略较早的历史。
- 自动压缩的阈值可在「上下文管理」的「自动压缩」里调整：可以按比例选关闭、50%、60%（默认）、70%、80%、90%，也可以选「固定 token 数」直接填一个绝对值（默认 150,000，范围 16,000–4,000,000；超过该模型预算的 95% 时按 95% 算）。固定值不随模型窗口变化，适合想给大窗口模型限定单步输入的情况。它按会话保存，新对话沿用该智能体上次的选择，只对内置助手生效；调整不会重置上下文。关闭后不再生成摘要，只靠省略较早的完整历史控制大小，最近 32 轮之外的对话也不再并入摘要。请注意成本：每一步模型调用都会重发整段上下文，大窗口模型（例如 1M）按 60% 意味着每一步可能带着几十万输入 token，响应更慢、费用更高，建议给大窗口模型调低阈值。
- 内置助手按需加载工具：每次请求只带一组核心工具（读画布、新建和修改、运行单个节点、查看结果、估价、各类确认卡片，以及能力查询），其余工具（整组运行、分镜与序列编辑、资产库、平台设置等）由模型先用能力目录查到名字，再用 `load_tools` 加载后使用，加载后同一会话里一直可用。这样请求里的工具定义从约 4 万 token 降到约 1 万，把上下文留给对话。已加载的工具只在内存里记录，「重置上下文」后清空；Claude Code、Codex 和对外 MCP 的工具清单不受影响。
- CLI 用量仅在收到可识别的请求用量事件后显示。Codex 使用最近请求的输入 token，Claude 使用该请求输入与缓存读写之和，不把会话累计用量或输出 token 当成当前上下文占用。窗口上限未报告时不显示百分比；切换模型后，旧报告失效。
- 「重置上下文」保留画布、完整可读对话和已提交任务，从下一条消息建立新上下文。内置助手不再发送边界之前的历史；CLI 下一轮启动新会话。该边界会持久保存，服务重启后仍然生效。自动压缩得到的摘要也一并清空；重置不会自动重新提交已有任务。

对话内容在“对话记录”阅读区中，修改方案有独立的分组名称。可用 Tab 聚焦阅读区，再用 PageUp／PageDown 翻页、End 回到底部；阅读区的按键不会删除或移动画布节点。Esc 关闭助手，输入草稿保留。

每轮保存消息、工具调用、审批及执行事实。服务重启后，未正常结束的轮次标为中断；已经提交的任务仍可从任务面板查回，不能确认是否发生的操作保留未知状态，不会自动当成失败重做。面板里的停止表示该轮不再继续，已经提交的远端任务仍按原任务记录跟踪。

内置智能体运行中可以继续发消息：消息在对话里显示为「已排队」，下一次模型请求前追加进本轮并交给模型；本轮结束时还没追加的，会自动作为下一轮开始，最多同时排 5 条。点停止或本轮失败时，没处理的排队消息会取消并提示。排队消息不带技能，沿用当前的确认方式。本机 CLI（Claude Code、Codex）运行中仍需等这一轮结束再发。同一次回复里连续的只读工具调用会并发执行，写入、运行和删除按顺序逐个执行。

内置智能体每轮最多 30 次模型请求和 100 次工具调用；大画布用分页或分区读取，单页 24 KiB、单工具文本 32 KiB、单请求文本默认 256 KiB（声明了大窗口的模型随预算放宽）。历史按完整轮次保留，最多取最近 32 轮，更早的由自动压缩并入摘要。超过预算时会明确停止，避免截断成不完整的工具对话。

视觉读取只向同时声明工具调用与视觉能力的模型发送图片，每轮累计最多八张、单图 1 MiB、合计 4 MiB。其余模型只得到素材标识与文字信息；模型目录的声明不等于真实账号的视觉能力已经验收。

## 技能与画布能力

助手输入框下方的「技能」以及设置里的「技能与画布能力」使用同一份目录。可以按名称、用途或工具搜索，区分 Plein 创作技能和 Codex 本机 Skill，查看完整指引、关联工具、来源及启用状态。「画布能力」视图直接列出当前注册表的工具和操作类型，包括插件贡献的能力。

Plein 首批提供检查画布、整理工作流、优化选中镜头、分镜规划与生成、素材加工五个技能。它们是对现有画布工具的工作指引，不是独立执行器。Plein 开关按用户保存，只控制技能的选用；基础画布工具继续遵循原权限和确认规则。

点击「使用此技能」只带入本轮草稿；已有需求文字保留，空草稿才填入建议需求。停用技能可先「启用并使用」，保存失败不会带入或发送。用户仍需点击发送，消息记录会保存使用的技能。需要选区的技能在没有附带目标时不可选用；服务端也会校验技能存在、已启用、与当前智能体兼容。

Codex 目录来自本机 `skills/list`，显式选用时通过 `turn/start` 的 `skill` 输入传入具体名称和路径。Codex 开关使用 `skills/config/write`，会改变本机 Codex 配置，影响其他使用该配置的客户端；系统、管理员或无法确认来源的技能不能在 Plein 切换。只读目录和详情不创建生成轮次。Claude Code 自带的 skill 仍由 CLI 管理，此面板目前展示其可用的 Plein 技能，不宣称已经发现 Claude 的原生技能。

附带选区会展示具体元素，可以定位和逐个移除，历史消息也能定位仍存在的目标；已删除目标保留 ID 并明确标记。发送时固定目标 ID，即使之后换选区，或插件修改了自己拿到的数组，本轮目标也不会改变。主动点击「让小满处理」会重新带上当前完整选区。外部 MCP 没有发送消息入口，因此在每次工具调用开始时捕获当前选区，供该次调用复用。

智能体增加三个与画布原生功能共用的工具：

- `inspect_node_input`：只读检查最终提示词、实际参考顺序、模型、音色、提示与阻断，不运行节点。默认返回字段目录，原文用 JSON Pointer 下钻分页，续读必须带 `expected_version`；单页最多 24 KiB，输入变化后重读。
- `reorder_inputs`：按完整连线 ID 列表重排同一多输入端口，保留素材与连线身份。
- `replace_input`：替换某个参考槽位的来源，保留连线 ID、目标端口和顺序；校验端口类型，拒绝重复引用，保留旧素材。与顺序调整一样，可按轮整体撤销。

## 对外开放 MCP

在设置 →「MCP」里生成令牌，再按你用的客户端（Claude Code、Claude Desktop、Cursor 等）复制对应的连接配置。外部应用和小满使用同一份能力目录，但外部没有会话里的确认面板和按轮撤销，所以这一层由 MCP 协议层单独补齐，行为和小满并不完全相同（见下）。需要画布的工具优先使用传入的 `canvas_id`，省略时使用正在看的画布，再回退到最近改过的画布。空工作区也可以查询工具、动作、节点和模型，搜索项目，导入素材或项目包，以及新建第一张画布。

- 初次使用按这个顺序了解能力：`list_canvas_capabilities`（工具目录与契约）→ `list_canvas_actions`（扩展操作）→ `list_node_types`（节点类型、参数、端口）→ `list_models`（模型目录与约束）。连接说明里也写了这个顺序。
- 外部 MCP 只在免登录模式下开放。即梦 CLI 还要求监听回环地址。本机文件访问遵循服务端配置的目录范围。
- 令牌只在生成时显示一次，服务端只保存它的 SHA-256。

### 令牌与权限范围

可以同时有多枚令牌，每枚带名称和权限范围，对应能力的副作用等级：`read`（查看）、`edit`（新建、修改、连线）、`run`（调用模型，会花钱）、`destructive`（删除、覆盖和发布到外部画布）。设置页生成时勾选范围，可限制「每天最多调用运行工具」的次数。一次批量调用计一次，服务重启后保留当天已用次数。这是工具调用次数，平台费用和批内任务数另算。设置页可查看和单独撤销令牌。

- `tools/list`、`list_canvas_capabilities` 与能力资源使用同一套外部输入契约。工具有一个可用分支就会出现在令牌目录内。每次调用按具体参数检查所需权限，缺少权限返回 `forbidden_scope`。未声明的具名参数返回 `invalid_params`。
- 旧版的单个令牌自动迁移为一枚「默认令牌」，拥有全部权限，原有配置继续可用。首次创建所有者账号后，再切回免登录模式时，原令牌沿用原有权限和用量，访问迁移后的工作区。
- 每次调用写入审计日志（`external-mcp-audit.jsonl`，在数据目录里）：时间、令牌名、工具名、是否成功和错误码，不记录参数内容。最近记录可从 `GET /api/mcp/external/audit` 读取。

### 确认、幂等与撤销

- 运行类工具外部同样先做预检：输入被阻断时直接返回阻断原因，不会先让你确认再失败。批量分镜 `run_storyboard` 第一次调用只返回含费用的清单，审阅后带 `token` 才提交。
- 删除、单节点视频生成、批量运行、对话模型改写和声明了确认要求的远程编辑会返回 `status: "needs_approval"`（错误码 `needs_user`），带 `reason`，运行节点时还带模型价格。外部应用把原因讲给你，你同意后用相同参数加 `confirm: true` 重试。普通单节点图片、文本、配音生成可直接运行，外部令牌也没有内置智能体每轮的运行次数上限；要限额就在生成令牌时填每日运行次数上限。令牌范围不含 `run` / `destructive` 时直接拒绝。
- 修改类和运行类工具可带 `client_request_id`。同一枚令牌以同一个 id、目标和参数重试时，会复用在途调用或第一次的回执，并带 `replayed: true`。不同参数返回 `invalid_params`。预检失败或等待确认时可以修正后沿用原 id。模型已调用或平台接收情况未知时，回执保留 `execution_outcome` 和本次运行额度。可先按恢复信息核对原任务，再决定下一步。幂等回执保存在进程内存，操作结束后最多保留 30 分钟，缓存满时会提前释放。重启或回执失效后先核对原操作。
- 画布变更在记录了可撤销操作后返回 `undo_token`，有 `edit` 权限的原令牌在 10 分钟内用 `undo_call({ token })` 撤销这一次，机制与「让小满撤销这一轮」相同；只能撤销发起它的那枚令牌做的改动。撤销只回退这一次调用写入的内容，之后别人改过的字段按协同规则保留。项目、资产、外部平台写入及已提交的生成费用有各自的生命周期。

### 错误码

错误结果的 `structuredContent.error` 为 `{ code, message }`，文字末尾也附带错误码。常见值：`not_found`、`stale`（读到的版本过期）、`needs_user`、`input_changed`、`forbidden_scope`、`blocked`（预检阻断）、`invalid_params`（附 `issues: [{ path, message }]`）、`too_large`、`rate_limited`（达到每日运行上限）、`internal`（服务端异常，细节只在服务端日志）、`failed`。需要调用方处理的成功结果（如 `needs_approval`、`stale`、`input_changed`）在 `structuredContent.code` 里给出同样的码。

### 输出上限与长任务

外部工具的单次文本上限是 32 KiB。普通画布读取超限时返回 `too_large`，可用 `get_canvas_page`、`get_element_field` 分页读取。按名称查询的完整节点、模型、工具和扩展操作契约超过上限时，返回 `result_omitted: true` 和 `recovery.uri`。写入、运行及提交状态未明的操作也可通过此方式取回长回执，并保留幂等与可用的撤销信息。用原令牌对 `recovery.uri` 调用 `resources/read`，按 `next_uri` 顺序拼接每页的 `text` 即可还原原文。单条最多保存 4 MiB，进程中的短期结果总共最多 16 MiB，最长保留 30 分钟。容量满时优先释放最早的回执。超过单条上限或回执已释放时会说明原因，先核对原操作的状态。`run_node`、`wait_for_run`、`wait_for_group` 默认最多等 20 秒（可用 `wait_seconds` 调到 50），仍在运行时返回 `running` 和续等提示。客户端请求带 `progressToken` 并接受 `text/event-stream` 时，服务端分段等待并发送 `notifications/progress`。

### 界面动作

读取视口或选区只需 `read` 权限，改变视口、选区和当前画布需 `edit`。外部 `ui_get_selection` 返回活跃窗口的选区快照（`source: "view"`），窗口打开且选区为空时 `total` 为 0。没有打开这张画布的窗口时，返回 `status: "no_viewer"` 和 `source: "unavailable"`。画布在浏览器或桌面端打开时，`ui_focus`、`ui_select`、`ui_set_viewport` 经协同通道推给打开这块画布的最近活跃标签页。成功回执表示已发送，可再读视口或选区核实结果；没有标签页打开时返回明确提示且不影响画布内容。`ui_focus` 省略 `ids` 或传空数组时适应整张画布；`ui_select` 传空数组清空选区；`ui_set_viewport({ x, y, zoom })` 的 `x`、`y` 是落在屏幕中央的世界坐标，`zoom` 范围 0.05–8。`ui_undo({ steps?, redo? })` 让打开这块画布的界面执行撤销或重做（1–20 步），与用户按 ⌘Z / ⇧⌘Z 是同一个撤销栈，因此会回退用户自己的操作，只在用户明确要求时使用；它与「撤销这一轮」不同，后者只回退小满本轮的改动。返回实际执行步数与 `can_undo` / `can_redo`，栈为空时返回 `done: 0`。

### resources 与 prompts

- `prompts/list` 暴露五个创作技能（`canvas-audit`、`workflow`、`shot-revise`、`storyboard`、`media-edit`），`prompts/get` 返回展开后的指引文本；参数有 `goal`、`canvas_id`、`element_ids`。外部没有内置智能体的 `await_approval`，指引里的确认步骤已换成上面的 `needs_approval` / `confirm` 流程。
- `resources/list` 列出最近改过的画布（`plein://canvas/{id}`，分页）；`resources/templates/list` 给出三个模板：`plein://canvas/{id}`（与 `get_canvas_page` 同一分页，查询参数 `section`、`frame_id`、`offset`、`limit`、`expected_version`）、`plein://canvas/{id}/element/{eid}`、`plein://capabilities/{name}`（工具契约和完整输入 schema）。读取需要 `read` 权限；资源不存在返回 `-32602` 并在 `data.uri` 里给出地址。

### 文件送进画布

外部 AI 在另一个进程里，拿不到你的桌面 Cookie，也没法直接把文件交给 Plein。三种途径，最终都走和界面上传同一套写入（流式落盘、按内容去重、类型和大小校验）：

- `import_asset({ source: { path | url | base64, name?, mime? }, place?: { near?, x?, y?, parent_id?, name? } })`：返回 `asset_id`；给了 `place` 且是图片、视频、音频时再返回 `element_id`，落点规则与 `create_element` 相同。
- `request_upload({ name, mime, size })`：大文件用。返回一次性的 `url`，客户端用 `curl -T 文件 "<url>"`（PUT 或 POST）上传，响应里的 `asset_id` 即资产 id；再用 `create_element` 摆上画布。上传地址挂在 `/mcp/upload/:ticket`，随 `/mcp` 一起绕过桌面端 Cookie 校验。

安全边界：

- `base64`：解码后最多 8 MiB，更大的走 `url` 或 `request_upload`。
- `url`：只允许 http / https，不能带账号密码；解析出的任何地址落在回环、私网、链路本地（含 169.254.169.254）、共享地址、组播和保留段都拒绝，混合解析结果只要有一个内网地址就拒绝。连接用的就是校验过的地址（防 DNS 换解析）；最多跟随 5 次重定向，每一跳重新检查；超过单文件上限或 30 秒超时即中止。
- `path`：只在本机免登录模式可用。必须是绝对路径，先解析符号链接再检查，真实路径需在允许目录内（默认用户主目录，可用 `PLEIN_IMPORT_ROOTS` 改），最后用 `O_NOFOLLOW` 打开，所以指向目录外的符号链接、检查后被调包的文件都读不到。额外拒绝隐藏目录与隐藏文件（`.ssh`、`.config` 等）、`~/Library` 以及 Plein 数据目录（里面有令牌和密钥）。
- 上传票据绑定签发它的用户，一次性（用过不论成败即作废）、约 15 分钟过期，声明的 `size` 是上限（先看 Content-Length，再按实际字节数截断）；同一用户未使用的票据最多 32 张。

### 文件取出画布

- `download_asset({ id, save_to? })`：返回带短期票据的下载地址 `download_url`，同时给出 MCP `resource_link` 内容块。传 `ids`（最多 50 个，与 `id` 二选一，不能配 `save_to`）时逐个处理，返回 `items`，失败项带 `error`。`get_asset` 与 `export_sequence_project`（经 `perform_canvas_action`）在外部入口返回同样的结果（旧的相对路径只在没有文件服务的入口保留）。
- 下载地址形如 `/mcp/files/:ticket`，直接 GET 即可（不需要令牌或 Cookie，支持 Range）。票据绑定签发它的用户和具体资产（或登记在册的导出路径），只读，约 10 分钟过期，过期前可重复下载；签发后资产被删或归属变化，下载同样失败。剪辑工程导出走的是进程内的导出接口，不开放任意内部路径。
- 本机模式下可加 `save_to`（绝对路径）直接保存到本地：受与 `import_asset(path)` 相同的目录约束，不覆盖已有文件，目标不能是符号链接。

### 票据模块（`apps/server/src/files/tickets.ts`）

`FileTickets` 是上传与下载共用的票据存储（进程内、只存哈希；重启后票据全部失效）：

- `issueUpload({ ownerId, name, mime, maxBytes })` → `{ ticket, url, expires }`；`takeUpload(ticket)` 一次性取走，返回 `UploadGrant | null`。
- `issueDownload(ownerId, target)` → `{ ticket, url, expires }`，`target` 为 `{ kind: 'asset', assetId, name? }` 或 `{ kind: 'proxy', path, name? }`（`path` 必须匹配 `PROXY_PATHS`）；`getDownload(ticket)` 过期前可重复读取。
- `noteOrigin(origin)` 记下外部应用访问 `/mcp` 的地址用于拼绝对 URL；`uploadUrl` / `downloadUrl` 给出最终地址。
- 工具层通过 `ToolEnv.files`（`FileServices`：`tickets`、`local`、`maxUpload`）使用；`deliverFile(ctx, target, meta, saveTo?)` 把一个文件交付为文字 + `resource_link`。

地址里的主机来自外部应用访问 `/mcp` 时用的地址；设置了 `PLEIN_PUBLIC_URL` 时以它为准。

## 画布操作的完整契约

Agent 按语义调用画布功能。文档编辑复用 `packages/capabilities` 与 `packages/doc` 命令；文件、音色、字幕和资产库操作复用界面正在使用的服务端路由；WebGL 构图截图由打开当前画布的客户端渲染，服务端核对资产和目标后写回。内置助手、本机 CLI 和外部 MCP 使用同一目录。

- `list_canvas_capabilities`：读取当前工具目录，指定 `name` 可查询完整输入契约。`list_node_types` 指定 `type` 时返回完整嵌套参数 schema，适用于场景、关键帧、角色档案、分镜、字幕和混音等参数。
- `list_models` / `set_node_model`：模型目录与节点换模型。`list_models` 按能力列模型，不带 `ref` 返回摘要（是否启用、特性、价格、主要约束），带 `ref` 返回完整 limits 与模型专属参数的 `options_schema`；`enabled_only` 只列已启用平台。`set_node_model` 与界面换模型使用同一份校正逻辑（`packages/capabilities` 的 `adaptToModel`）：不支持的分辨率改回默认，不支持的画幅（含当前模式不接受的 auto）换成支持的，时长和张数夹进范围，草稿模式等收窄分辨率；模型不暴露的参数（如种子）保留但标为 `ignored_params`，模型专属参数按模型 ref 分别保存。返回 `changed`（参数前后值）和 `notes`（原因）。`update_element` 直接写 `params.model` 不会校正，返回里带提示改用 `set_node_model`。
- `rename_element`：改名并同步所有 @ 引用，与界面重命名相同，返回改写的引用数和受影响元素；`update_element` 带 `name` 走同一实现（清空名称除外）。
- `rewrite_prompt`：除 `mode`、`apply` 外支持 `structure`（auto / default / h3）、`detail`（refine / expand）和改写用的对话模型 `model`。预览和写回都会调用改写模型，需要运行权限和确认；写回还需编辑权限。改写期间用户修改了原文时，保留原文并返回生成的草稿。生成模型取自节点 `params.model`，参考素材取自节点实际输入（与 `inspect_node_input` 同源），所以 auto 在 MiniMax H3 的多模态参考任务上会用六段结构。
- `get_sequence` / `edit_sequence`：读取剪辑实例，按版本凭据修改、排序、固定候选、复制固定片段、加入或替换固定素材、移除一次使用。固定片段使用真实素材时长；替换只影响指定实例，旧素材保留。
- `edit_production` / `edit_delivery_notes`：选择试制镜头和目标序列、追加制作目标及决策版本、编辑指定交付版本的反馈。Agent 的目标与决策明确记录 `source=agent`，不产生用户确认。
- `list_canvas_templates` / `place_canvas_template`：铺设插件或用户保存的工作流模板，复用界面的依赖预检、连线校验与引用映射；只创建结构，不运行。
- `extract_analysis_assets` / `plan_analysis`：提取既有拉片关键帧、片段和音轨，建立逐镜分析或采样归纳草稿，或将精确候选转为带来源的分镜计划；模型推断保留未经人工核实的标记。
- `get_story_inputs` / `edit_story_state`：固定原文来源、标记事件与对白范围、关联镜头、记录改编提案、登记连续性主体与追加镜头状态计划。计划写入保留父版本校验。
- `review_candidate`：对审看片刻的具体资产及候选记录状态、标签和意见；候选变化时拒绝旧意见。审片独立于采用，也不等于用户确认内容或批准交付。
- `search_media` / `get_media_sources`：检索跨画布已有文件并读取来源，得到的资产 id 可用 `create_element` 放入画布。
- `list_jobs` / `recover_job` / `cancel_group`：读取任务、按原回执恢复，以及取消整组运行。指定节点查询最新任务不受最近任务窗口限制。未知提交重新提交前须核实平台未受理。
- `create_checkpoint` / `list_checkpoints` / `restore_checkpoint` / `delete_checkpoint`：保存已同步到服务端的画布、查看项目检查点、恢复为新画布或删除检查点。恢复不会自动改变本轮工具的目标画布。
- `list_projects` / `create_project` / `rename_project` / `delete_project` / `list_canvases` / `open_canvas` / `create_canvas` / `rename_canvas` / `duplicate_canvas` / `move_canvas` / `delete_canvas`：项目与画布管理，复用项目与画布路由及所有权校验，三种驱动共用。不依赖当前画布，外部 MCP 在空工作区也能调用。项目和画布都可按标题 `query` 搜索。`list_canvases` 返回所属项目和相对链接 `open_path`，可按 `project_id` 过滤并用 `offset` / `limit` 翻页。`open_canvas` 在用户要求时从当前窗口或指定的 `from_canvas_id` 发起导航，保留离开确认，没有打开窗口时返回链接。读写别的画布可直接使用其 ID。`duplicate_canvas` 复制画布（可指定标题和目标 `project_id`，不复制检查点与会话），`move_canvas` 把画布移到另一个项目且不改内容；两个删除工具是破坏性操作，走确认，且不能删除本会话正在操作的画布。
- `delete_results`：删除节点生成历史里的候选记录，语义与历史面板一致（只删记录不删素材，删到当前采用项时回到「尚未采用」，不自动换候选）。正在被固定片段精确使用的候选及其配对输出会保留，需先在固定片段里替换素材；混合删除会删掉可删的，并用 `kept_fixed` 列出被占用项和占用它的片段，全部被占用时明确拒绝、不返回该字段。返回 `removed`、`current_changed`（是否实际改变了当前输出）、`kept_fixed`（仅在被部分保留时）和没找到的 id。破坏性操作，走确认。
- `get_impact` / `keep_stale` / `revoke_keep` / `run_impact`：影响面板。`get_impact` 只读，返回过期节点及原因、建议、可沿用的候选、费用汇总（缺价格的计入 `cost.unknown`）和每个节点的 `input_hash`；`keep_stale` 带这个哈希确认保留现有结果，输入在那之后又变了会拒绝；`run_impact` 只运行指定节点（默认优先沿用已有候选），需要确认，返回 `group_id` 后用 `wait_for_group` 等结果。
- `run_nodes`：一次运行多个指定节点（1 到 50 个），与界面多选运行共用 `runs.runBatch`：这些节点总是重新运行，它们 @ 引用的卡片的上游先跑；需要确认，返回 `group_id` 后用 `wait_for_group` 等结果。
- `estimate_cost`：运行前估价，不调用平台。`scope` 为 `node`、`upstream`、`downstream`、`frame`，目标范围和「沿用仍有效结果」的判定与对应的运行工具一致；逐节点标 `run`（一定调用）、`maybe`（上游重做后输入变了才会调用）、`reused`（沿用），费用按币种分别合计，模型没配价格的调用记入 `unknown`，不当作 0。
- `list_providers` / `set_provider_enabled` / `test_provider` / `refresh_remote_models` / `set_default_model`：平台与默认模型设置，复用设置页的路由。读取只返回启用状态和每个密钥「是否已填写」，永远不返回密钥明文（设置里疑似密钥的字段也会掩码）；写入只开放启用开关，密钥录入留在设置页。`test_provider` 只检查配置或连接，不证明具体模型、权限或余额可用。
- `get_group_items` 按页读批次内每一项的状态和任务 ID，包括等待复核或使用缓存的项。`get_job` 查看指定任务，`inspect_node_input` 可按 `run_id` 查看当时的输入。用同一 `run_id` 调用 `wait_for_run` 或 `cancel_run`，可以准确等待或取消那次运行。
- 本机即梦画布与即梦短剧的 `external_canvas_*` 工具覆盖登录状态、空间和项目、预览及逐项读取、导入和同步，以及素材读取、导入、替换和发布。写入前可预览具体目标与版本；账号登录由用户在 Plein 中完成。详见[外部画布](external-canvases.md)。
- `get_shots` / `edit_shots`：分镜表逐镜编辑。`edit_shots` 的 `ops` 支持 `add`（接在最后）、`patch`（只改给出的字段，记为手改）、`move`（移到第 N 位并按新顺序重排镜号）、`remove`（已展开的节点和产物保留，标为脱离计划，走确认），带 `expected_version`，全部成功才写入、一次撤销。写入走分镜编辑器同一条路径，会先补记旧计划基线，`sync_storyboard` 才能分清「计划变了」和「节点被手改」；`update_element` 整表替换 `shots` 时也走这条路径，但逐镜修改应使用 `edit_shots`。
- `split_grid`：把宫格图按行列切成单张图片，排在原图右侧并打成记录原图的分镜组，返回 `frame_id`、每格元素与资产 id。服务端用 sharp 切片（先按 EXIF 方向展开），分界与排布来自 `@plein/doc` 的 `gridPlan`，界面「宫格切分」用同一份，两端边界一致；本地加工，不调模型。
- `create_mask`：为局部重绘生成蒙版。对 `plein/image-edit` 节点调用时，原图取自连入 `image` 端口的图片（或 `source_asset_id`），蒙版写入节点的 `mask` 参数（`assetId`、`width`、`height`、`sourceAssetId`，与界面蒙版编辑器的约定一致）；对图片元素调用只生成蒙版资产。用 `rects`、`polygons`（原图像素，或 `normalized` 比例坐标）圈区域，sharp 画成与原图同宽高的黑底白区二值 PNG；`feather` 把边缘向外扩若干像素（平台只认黑白，不做渐变）。也可以用 `mask_asset_id` 接 `import_asset` 送入的外部蒙版：宽高比须与原图一致，会缩放到原图尺寸并二值化。全黑蒙版会被拒绝。
- `capture_stage`：按时刻截取 3D 构图，保留完整场景与轨迹来源。客户端未打开、超时或目标锁定时明确失败；不会调用生成模型。

`list_canvas_actions` 提供扩展操作目录。先指定 `action` 查看完整 schema，再用 `perform_canvas_action` 传入同名操作及 `input`：

| 功能                                 | 操作                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| 本机媒体能力、素材元数据和下载       | `get_media_caps`、`get_asset`                                                           |
| 资产库增删改查                       | `get_library_item`、`create_library_item`、`update_library_item`、`delete_library_item` |
| 全景视角、角色图片归档               | `capture_panorama`、`archive_character_image`                                           |
| 跨画布版本差异、同步、固定和解锁版本 | `get_library_updates`、`apply_library_updates`                                          |
| 工作流模板保存与管理                 | `list_templates`、`save_template`、`delete_template`                                    |
| 音色设计、复刻、登记和管理           | `list_voices`、`create_voice`、`update_voice`、`refresh_voice`、`delete_voice`          |
| 对白时间戳识别及任务恢复             | `recognize_subtitles`、`get_subtitle_recognition`、`recover_subtitle_recognition`       |
| OTIO、FCPXML、SRT 和素材工程包       | `export_sequence_project`                                                               |
| 项目包（.plein）导出与导入           | `export_project_package`、`import_project_package`                                      |

`export_project_package` 先取导出概要（超过 4 GB 上限时拒绝），再签发 `.plein` 的下载票据，可选带历史候选。`import_project_package` 与界面一致，先预检再写入新项目；包文件来自 `asset_id`（先用 `request_upload` / `import_asset` 送入资产库）或本机 `path`，`preview_only` 只校验并返回概要，不写入。

扩展操作的参数与界面使用相同协议。媒体加工 `edit_media` 也直接从加工协议生成参数，包含区域修补、片段替换、尾帧和保持音高，不另维护缩减版字段。

画布内编辑沿用本轮撤销；资产库、模板、音色、识别记录、跨画布同步和检查点独立保存，不能靠“撤销这一轮”回退。付费操作与删除沿用确认模式。系统不把 Agent 的计划、意见或推断写成用户亲自确认或完整观片的证据；界面中的人工确认仍由用户完成。文件选择器、播放器播放头和面板开关属于客户端交互，语义编辑通过上述工具完成。
