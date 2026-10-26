# P11 序列实例 UI 实施记录

> 2026-10-26 证据事故后状态：原 `test-results/creative-workbench` 文件已丢失；以下为当时的实现与复核记录，旧 SHA 暂不能现场重查。当前版重建与最终新证据见[恢复记录](evidence-recovery.md)，不将重跑冒充原运行。

2026-10-25，实施者 `p05_source_mapping`。P07 已独立验收；主 Agent 放行本窗口后，基于 `p01_baseline` 冻结的 doc／nodes／SDK 接口实施。当前是作者实现与定向测试记录，P11 整体工程门禁、实际 UI 和真实媒体输出由主 Agent 另行验收。

## 实际改动

- `SequenceEditor` 的选段、修剪草稿、设置补丁、排序、交互版本和检查器身份使用 `sequenceRowKey`／`clipInstanceId`。普通实例通过既有命令重新读取当前行，保留其他最新行；排序使用完整实例列表 CAS。旧 v1 与 animatic 的 source／shot 兼容分支保留。
- 读取真实输入时，以 `inputEdges` 的 edgeId／from port 和该端口的 `currentResult` 填充 SDK 的 sourcePort、edgeId、resultId、runId、originCanvasId；没有输出时保持原 pending 实例，不拿 primary 或其他输入替代。固定行直接由公开 `arrangeSequence` 解析保存的 segment。
- 新 `SequenceInstanceTools` 支持明确选择当前／历史视频候选并固定，固定不会改变原采用项；实际时长来自资产元信息。复制、添加、替换和移除只作用于具体实例，新增共享行必须明确选择 native／voice／mix，不自动复制叙事、对白、more 或音效。固定段全部实际使用者可查看并定位。叙事绑定直接保存真实 canvas／board／shot 身份，不增加另一份映射状态。
- 固定候选读取有独立操作代次、元素实例和行快照核对；关闭小窗或切换目标后迟到元信息不保存。新写入还即时核对当前 session、engine、canvas、sequence、底层元素、只读及锁定。旧参数恢复、字幕识别／恢复和原序列操作同时复用这些权限边界。
- 手工字幕按稳定实例分组；首次编辑、复制、移除和重排使用 nodes 的公开字幕 helper。旧 keyVersion=1 兼容轨保持原文／时码／隐藏及原过期依据，真实编辑必须先通过旧键检查；不直接刷新 inputKey 消除陈旧。两条实例的字幕不会以 source 合并。
- 预览解码键由实例 ID＋实际 assetId＋媒体种类组成：同文件重复使用独立解码，重排保持各自身份，同一实例换文件则重建解码器。音频 buffer 可以按资产共享，但每次 offset／gain／rate 继续由统一时间线独立排程；voice 关闭原声，native 不认领对白，显式新行不提供旧版自动声音选项。
- `DeliveryReview` 使用 `sequenceSourcesAt` 列出当前成片时刻覆盖的全部来源，并显示各实例的源秒数／速度／文件／原候选。重叠意见可指定实例或保留为整片意见，不猜第一来源；意见保存 clipInstanceId。定位先检查当前确切实例，删除或历史未知时保留出处并提示，不借同名对象重绑。交付视频卸载暂停、移除 src 并 load。
- 主 Agent 的 `sequenceFocus` 接点已消费：`openSequence(sequenceId, clipInstanceId)` 对有效目标选择并 seek；数据未就绪时不消费，请求完成后按 requestId 清除，避免任务进度更新重复 seek。引导与 P07 入口由主 Agent 接线，本窗口未改这些文件或 store。

## 旧项目与金样

只读核对 `P11/pre-migration/` 四份 JSON，逐份 SHA 与 manifest 相符，未覆写输入、Yjs 或冻结 MP4。已确认必须保留：隐式 B／C／A 顺序与自动声音；多端口相同 source 的两行和旧四条字幕；手改文字／时间／隐藏及换文件陈旧；同资产 A／B 的速度与 0.5 秒重叠。迁移正确性以 `p01_baseline` 的独立数据回归为准，UI 不建立第二份迁移算法。

## 已执行检查

```sh
pnpm exec vp test run apps/web/src/features/sequence --maxWorkers=2 --reporter=default --reporter=json --outputFile=test-results/creative-workbench/P11/ui-unit-tests.json
pnpm --filter @plein/web typecheck
pnpm exec tsc -p .
```

序列域 7 文件 65 项全部通过，零失败／跳过。原始 JSON 的 SHA-256 为 `3068c671e06c0a52ae832f309e21b7b997fd1fdae8aeddbab88fc60c73427304`。其中新增 4 项覆盖确切非主端口／pending、无生成出处的视频与实例身份、重复文件的解码生命周期、native／voice／mix 独立排程；其余为原序列、animatic、参数恢复、播放头及引擎生命周期回归，不将它们累计为 P11 全部测试。

web 与根 E2E 类型检查、10 个定向文件 `vp check`、定向 `git diff --check` 已通过。初轮两个新增 scene 测试使用了不符合新资产合同的逻辑 ID，已改为合法 64hex 后通过；没有以假 ID 证明真实资产保留。

## 待主 Agent 运行的实际 UI

新 `e2e/sequence-instances.spec.ts` 有 3 个待执行用例：

1. 固定确切候选，明确声音／两镜叙事绑定，分别修剪 A `[0,2)`、B `[4,6)`／speed2，重排后还原、独立手工字幕，实际导出 2.5 秒并在 1.75 秒核对 A 源 1.75／B 源 4.5，定位具体实例。SQLite submit journal 与本地序列执行请求分别记录。
2. 明确历史候选不改变采用，hold 实际文件元信息后关闭小窗，释放响应也不能保存；同帧只读拒绝后续写入。
3. 删除原来源和固定素材视图后保存的文件仍可预览；锁定／viewer 仍可读，不能写入或开始导出。

UI 测试使用独立临时 8 秒真实 WebM，便于 Chromium 解码；它是浏览器兼容的受控增量，不冒充冻结 MP4 的真实服务验收。候选生成出处是明确的 controlled fixture，没有实际平台任务；真人质量、操作数与费用保持 null。测试不会播放音频、不覆盖 golden 或冻结文件；本作者未运行共享 build／E2E，也未调用付费平台。

本次冻结的 10 个源码／测试 SHA 保存在 `test-results/creative-workbench/P11/ui/source-hashes.json`。后续如复核修订将保留原报告并另记新哈希；当前没有自行预填 L3、P11 最终或 L4 通过。

## 本轮入口接线独立复核与新增 UI 用例

2026-10-25，复核者 `p05_source_mapping`。本次独立复核对象是主 Agent 新增的 `ShotSegmentReferences`、Workbench／引导／制作总览入口、`BatchChecklist` 和 `BatchPlanDetails` 接线；前述本人实施的序列编辑器仍由主 Agent 独立验收。本轮没有修改这些产品文件，没有运行共享 build／E2E。

- Workbench 与引导读取同一 `shotSegmentMapping`，没有另设镜头到素材映射账。固定段的第二叙事镜可以没有 video 生成节点；列表仍按确切实例显示当前声音、源区间、资产及原始出处。多序列没有明确选择时保留歧义，不按第一条猜测。引导将固定段标为待审看，不继承原生成出处的人工通过结论。
- `定位此剪辑实例` 在点击时重新核对当前 engine／canvas／调用方目标和完整实例内容，再以 `openSequence(sequenceId, clipInstanceId)` 定位。只读／viewer 可以查看范围与定位，生成按钮仍使用即时 `writable` 权限合同。
- 发现并关闭了清单同帧范围变化的旧 token 提交缺口：`planVersion` 随成功预检绑定，scope／文档／离线变化即时使版本失效；提交同时检查版本及当前 engine／canvas／sync.connected／doc.readOnly，服务端返回的新预检也只能由同代次且当前目标接收。没有等待 React 下一次渲染才使旧清单失效。
- 另发现并关闭了无 `nodeId` 的固定段清单行“定位”空操作：原按钮现在只显示于节点行，映射详情逐实例提供纯 `onLocateMapping` 回调。`BatchChecklist` 点击时重读 engine／canvas／调用方目标与同一映射 helper，核对实际 clipInstanceId 和清单版本；检查通过后关闭清单并精确打开实例，没有借第一来源回退。

只读核对主 Agent 原始 `test-results/creative-workbench/P11/root-mapping-tests.json`：实际是 **3 个文件、35 项通过**，零失败／跳过；JSON 的 8 个 suite 不表示 8 个文件。它与本窗口原 65 项分开报告，未将尚未运行的浏览器用例计入。

`e2e/sequence-instances.spec.ts` 现有 **6 条待主 Agent 运行的实际 UI 用例**，保留原 3 条，新增：

- 第 4 条：真实固定同段映射两镜，第二镜无 video 节点；从 Workbench 与引导都定位第二实例，并通过真实按钮取得带 asset／instance／native 声音映射的沿用清单，检查零执行请求与 SQLite job。
- 第 5 条：真实键盘复制第二个序列，未明确范围时阻塞；通过原生范围选择后只显示选中序列的映射，再从 Workbench 定位原序列的确切第二实例。
- 第 6 条：两个 live 序列都能预检为可生成，明确选择新候选模式；可信确认按钮 click 的原生捕获事件内切换序列，验证旧 scope token 不得提交。只触发真实 DOM 事件，不直接调用 React／store handler。

新增用例只在 setup 使用真实文件与受控 typed doc 数据；导航、范围选择和清单读取均经过实际 UI，不直接调用 `openSequence` 或构造清单。第 4／5 条的固定素材明确没有生成出处，不冒充平台任务。测试只包含零提交断言，当前没有浏览器通过证据。

本轮 spec 的 SHA-256 为 `5c18b94ee4551881376cbd33cabea19a5eaac5525dcc38dd7def892913c1a49a`；原 3 用例冻结 manifest 保留。单文件 `vp check --fix` 与根 `tsc -p .` 已实际通过。本轮新入口接线的只读复核通过，无剩余已知阻塞；6 条实际 UI、P11 整体工程门禁和 L4 均未由本签署预填通过，待主 Agent 统一运行与独立验收。

## 未映射字幕与历史交付的窄 UI 补充

主 Agent 在独立数据复核发现反例后，分别明确授权本作者补充 `SubtitleEditor` 与 `DeliveryReview`；这两段是作者实现，不计作本人对自身 UI 的独立验收。数据主体的独立结论另见 `P11-data-review.md`。

- 未映射旧字幕以只读原因、完整原 cue JSON 和迁移前完整轨 JSON 展示；没有猜测绑定、加入成片或清除按钮。编辑器沿用数据作者的 `unmappedCues`／`legacyTrack` 合同，正文中的 literal `@` 不重写为角色引用。
- 历史交付保留原 `confirmedAt`／出处和意见，显示“历史范围曾人工确认此文件”；意见／解决／删除／确认只读。历史标记进入版本身份，写动作即时读取最新标记，textarea 草稿也经同一守卫；历史记录不显示当前创作批准与当前草稿定位入口，原文件和意见时间码仍可回看。新本地导出的当前记录继续独立审阅。此代码已由 `p08_shot_analysis` 另行只读回查，无新增代码阻塞。
- 第 7 条故障 UI 使用实际 v1 孤立 cue 迁移，核对完整原值，编辑有效 cue 后保留证据，再通过真实图层多选／复制及刷新核对 literal 文本。第 8 条明确使用受控旧确认元数据；原按钮的真实 click 内同帧变为历史后，额外 Yjs 更新应为零；实际复制再次建立历史边界，随后新本地输出可以单独写意见和脚本确认。受控确认不是自然人的批准，相关指标仍为 null。

主 Agent 首跑日志 `P11/playwright.log` 中前 **5 条实际 UI 通过**，已覆盖真实 MP4、双来源回源、只读、引导及两个范围；后三条停在 harness 准备／操作路径，尚未通过。本作者逐份读取失败 trace／截图后，仅修 spec：第 6 条经实际计划差异面板确认手配节点，第 7 条使用未被 Generator 遮挡的真实图层 treeitem 多选，第 8 条先切回剪辑预览再导出。原断言未放宽，原 5 条不重复累计；主 Agent 将单独复跑第 6／7／8 条。

当前 **8 条 UI 用例**的冻结 SHA：

| 文件                             | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `SubtitleEditor.tsx`             | `ac97bdbe473fe0c409a0e282974e18259b7b5ab33e2a2f3672f7018ffc5f25ad` |
| `DeliveryReview.tsx`             | `0ee194f3c64a32bf323da7397e736a3ca1c969d47bb572ad26aa05fb6636bb68` |
| `e2e/sequence-instances.spec.ts` | `90855b963630fbbc6aeb67bd19fbb1530a3df7bd19095bbe6cf15c17dffb2f01` |

上述产品／spec 的定向 `vp check`、根 `tsc -p .` 和定向 `git diff --check` 已通过。本作者没有运行共享 build／浏览器；后续 3 条 UI 的实际结果、P11 最终门禁与 L4 仍待主 Agent 登记。

## 2026-10-26 原执行出处与回归修订

主 Agent 因出处合同变化再次开放窄窗口，本段是作者记录。`instanceModel` 的当前承载位置改用 `sourceCanvasId`；原执行证据只在 `isGenerationOrigin(result.generationOrigin)` 验证完整五元组时透传，缺失不从本地位置／候选／run 拼造。交互身份同时比较实际文件、本地候选与原执行 tuple。Tools／交付回看分别显示完整原始出处和本地选定事实，缺原始证据时为“未知”。受控 fake candidate 的第 2 条 UI 改为核对 selection 五元组与 origin 缺失，没有给 fixture 塞入假执行证据。

只读核对主 Agent 复跑日志：第 6／7 条已实际通过；第 8 条当时仍因有旧 results 时按钮实际叫“重新导出”而未完成，现已修成真实名称。因为原始出处产品合同已变，主 Agent 将对最终版本重新运行全部 8 条；早阶段的 5＋2 通过保留，不累计成新的 8 条样本。

旧回归另有两处收口：离开回看时用真实剪辑按钮 click capture 读取仍在播放的精确时刻，不再读清 src／load 后的零秒；继续断言 playing→暂停、卸载、src／srcObject／source 清除和网络／就绪／缓冲状态复位，恢复误差仍小于 0.1 秒，意见时间阈值不变。原始状态附为 `delivery-release-state` JSON，currentSrc 仅记录，不作资源释放的错误判断，也不冒充 RSS／JS GC。窄屏的版本变化错误是实际可见性回退，现将提示移到视频之前，原 viewport 断言保留。

新增原执行／本地别名分离的定向模型报告 `P11/ui-origin-tests.json`：1 文件 3 项通过；它包含此前的两项，不与旧 65 项累计。6 个定向源码／spec 的 `vp check` 和根 `tsc -p .` 通过。本作者仍未运行共享构建／浏览器，旧 54-case 计划的 INT 留证也不写成 54 项通过。最终 UI 与新出处的数据独立门禁等待主 Agent 分项验收。
