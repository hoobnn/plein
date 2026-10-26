# P11 数据、实际媒体与归档独立复核

> 2026-10-26 证据事故后状态：原 `test-results/creative-workbench` 文件已丢失；以下为当时的实现与复核记录，旧 SHA 暂不能现场重查。当前版重建与最终新证据见[恢复记录](evidence-recovery.md)，不将重跑冒充原运行。

2026-10-25，独立复核者 `p05_source_mapping`。本记录保留前一冻结基点的 L1／L2 签署；2026-10-26 原始执行出处子项已重开，当前状态见文末，不能将原签署当作新合同的最终门禁。主 Agent 仍负责完整后端与 UI 验收；本人的序列 UI，以及另获授权补写的未映射字幕／历史交付 UI，不包含在此独立签署内。没有修改数据产品、运行共享 build／浏览器或调用付费平台，没有播放声音。

## 实际检查范围

逐项读取 `video-segment`、实例命令与迁移、不可变快照、typed 复制、nodes 序列／字幕／工程转换、SDK provenance、交付追加、资产强引用、项目包与检查点接点；对照 `P11.md` 与 `P13.md` D 波合同，读取实际服务用例及原始报告。21 个已复核源码 SHA 存于 `P11/independent-reviewed-source-hashes.json`，manifest SHA 为 `51c4dddca7cf9cfb81fb4cf5f4f49690e9953ce9228fd12343f8d9c4c9fe5d7e`。

实例、来源元素／端口、候选／run 与当前叙事分别保存。固定实例读取 segment 快照，不以当前采用项替代；删除原生成节点和素材视图后仍用原文件。复制重发实例／cue 身份，按实际复制目标映射当前叙事；原始生成出处与旧交付来源不自由替换。新共享行的 native／voice／mix 明确选择，声音和字幕时间仍复用统一 timeline。

## 反例与关闭依据

- 原段值与新增交付 provenance 的输入／读取别名可能绕过 Yjs。已回查两端独立深快照与只读属性，外部输入、asset／origin／narrative 及历史标记不能借读对象修改持久值；明确 `editDelivery` 仍能按合同写当前意见与确认。别名负例同时检查 Yjs 字节、更新与 Undo，不只比较一个缓存对象。
- 原 v1 迁移会丢掉失去来源的手工 cue。独立内存重放确认旧全文被丢弃后，由数据作者保留 `unmappedCues[{cue,reason}]` 与完整 `legacyTrack`，不加入 active cues，不更新原 inputKey。已复查 create／commit／retain／duplicate 与 typed 复制都携带原证据；原隐藏状态、额外字段和 literal `@` 保留。
- 原冲突检测未检查只存于历史交付的 segment 身份。独立重放确认 S／A 历史与 S／B 新实例可以共存后，修复已比较历史中已知的 asset／完整 origin；不同值拒绝，同一已知事实允许复用，不从 sourceOut 推算完整素材时长。
- 原副本的旧确认会让新范围引导显示“当前成片已确认”。独立实际复制重放后，现有 copy／template／fresh 或冲突 import／checkpoint 都显式标记 `historical`，保留旧 `confirmedAt` 与 sources；数据写入立即拒绝历史意见／确认，Guide／Overview 不提升为当前结论。修后再次重放：新叙事已映射、旧来源仍在原 scope，Guide 为 ready，拒绝编辑且 Yjs 字节不变，见 `independent-history-review.json`。
- 新视频覆盖守卫最初无法读取常见 WebM 的流时长标签。实际临时 VP9／Opus 验证了容器 1.008 秒、视频流 `tags.DURATION` 1 秒而无 `stream.duration`；修后公开 `probeMedia` 返回 videoDuration=1，未借容器时长充当画面覆盖。临时文件已删除，结果见 `independent-webm-duration.json`。长音轨不证明完整视频覆盖的守卫保留。

## 迁移金样与定向回归

四份迁移前金样的原 SHA 全部复算一致。受版本控制的 fixture 中，elements／edges／bindings／durations、原 timeline／spec／SRT 与金样逐值一致；迁移测试只排除新增 provenance 和有意重发的 cue ID，其他输出逐项对比，SRT 逐字比较。实际保留了多端口旧默认输出的四条重复字幕、原 inputKey、手调／隐藏和变速／叠化，没有为新身份整理掉旧输出。

本人实际运行的独立定向报告如下，均零失败／跳过；重复文件不累计为新的独立样本：

| 报告                                | 实际结果                                                    | SHA-256                                                            |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `independent-data-after-fixes.json` | doc／nodes／capabilities 3 文件 19 项通过                   | `c4c92c286cd53d7c5c4edfa248dcf7832cf07d9be0f504fe6fce0511b1afcfc2` |
| `independent-history-tests.json`    | delivery／clipboard 相关 3 文件 9 项通过，含前份已跑的 5 项 | `faebca4b8c6df67667e36c5b27d2bc6527c8ce6108370c95ac6190a17ab0f41f` |

## 最终实际文件与归档证据

最终冻结目录是 `P11/accepted-evidence/`，没有以旧目录代替。已核对作者 `accepted-media-archive-P12.json` 为实际 2／2、零跳过，SHA `71ab748ef0ad19a0347f8b7c45f287a2cbf5d26355f67e928ae6bcd7a468bdd1`。它们是本地服务链路，不能累计为另一组创作样本。

独立实际解码先核对早期保留文件的帧／PCM，再对最终四个文件完整视频解码哈希与同段 PCM 比较，均一致；最终文件 SHA／尺寸／帧数另行复算。证据为 `independent-accepted-media-review.json`，SHA `07b9f5fd4ded1f0f1ac6bd1dcf2097cdc2f5f3d40fa17b640c197f1abf2cc20a`。

- 最终 MP4 SHA 为 `f7656d0aa8e2c2c4f8b6776b204ed4240db81d29b2e012dd986615aba04d50a1`，与实际 delivery／P12 asset 一致；H.264、1280×720、30 fps、75 帧、2.5 秒。上三分之一区域灰度降采样后，首段／末段／叠化像素 MAE 分别为 0.03776／0.01823／0.25391；错误 speed 的对照为 5.65104。
- native 的 440 Hz 幅值约 0.07482、880 Hz 近零；voice 的 880 Hz 约 0.13118、440 Hz 近零；mix 两者均存在。文件／PCM 分析没有播放音频，也不证明对白语义或口型。
- 直接读取工程 ZIP，内含源文件仍等于冻结源 SHA `749fe4c152fc5885b311f876220d3cdfb27ced561f6e8502f9ce60c2a21c0241`。SRT 逐字核对 A `[0.2,0.9)`、B `[1.6,2.3)`；clip-map、OTIO 私有映射与交付 sources 一致，FCPXML 可解析、总长 5/2 秒且有二倍 timeMap。成片 1.75 秒列出两个实际实例，对应 A 源 1.75／B 源 4.5。
- 最终 P12 报告 SHA 为 `b92f3973c94bfd88abf609c0c831d801de3a59cfdc9c92023ee3b5f36297857a`，请求绑定同一 actual asset／delivery／result 和当时 goalRevision，字幕证据等于实际导出计划，完整解码 75 帧；服务用例检查零 calls／call_history 且交付记录不被技术检查改写。报告明确未检查 OCR、语义、身份与真实动作。
- 已逐行检查实际 current／all 包各导入 1／2 个候选，SQLite 重开、真实模板复制、无 ID 冲突与冲突导入、检查点恢复及实际 GC。原 source／view 删除和换采用不改变固定素材；旧确认在各边界变为历史，新本地导出产生可单独审阅的当前记录。GC 删除一年旧的孤立资产，同时保留仍有实例／交付／检查点强引用的源文件；包收集与索引使用 typed 扫描，没有只依赖任意字符串。

本签署关闭数据／本地媒体／归档工程复核。实际 UI 的最终三条复跑及整体 P11 由主 Agent 另行确认；剪辑软件实机导入、真实模型、自然人的批准／效率／质量和 L4 均未由这些确定性测试证明。

## 2026-10-26 执行出处子项重开

后续独立反例暴露：旧保存候选的本地 canvas／node／result／run 别名不能直接拼成原始生成出处。新冻结合同将 `NodeResult.generationOrigin` 明确为已知原执行的完整五元组；`VideoSegment.origin` 只来自该证据，`selection` 单独记录固定时的本地候选五元组。缺失原证据时必须显示未知。

前一 `accepted-evidence/` 的文件解码、时间转换、声音、SRT 和归档事实仍保留，但其中旧 origin 标签不能用来证明新五元组合同；原 21 源 manifest 亦不冒充当前源码冻结。原始执行出处、alias 复制／导入及新冻结 sidecar 的最终独立回查仍待新数据实现／证据冻结。

本复核者本轮接写了 `instanceModel`、Tools／DeliveryReview 的新 tuple 显示与相关测试，属于作者工作，不作自身独立验收。其余数据产品仍只读，由主 Agent 协调数据作者与独立复核者收口。

## 2026-10-26 新证据根最终数据差异复核

独立复核者 `p05_source_mapping`。已重新读取安全根 `.creative-workbench-evidence/2026-10-26-recovery/P11/` 的当前原始报告及实际文件，不沿用丢失目录的通过结论。当前 24 个数据、SDK、后端及测试源码的复核时哈希、原始报告哈希和证据身份见 `independent-final-full5-review.json`，SHA-256 `10e2b8f2b0faef8edfaac2d01fb690b612c1bc7a9551286354dac305f4da474e`；源码哈希是复核时捕获，不冒称测试前快照。早阶段 `independent-current-full5-review.json` 保留，由最终报告取代。本人的 UI／helper 仍排除在独立验收范围之外。

| 当前原始报告                                | 实际读取结果                                               | SHA-256                                                            |
| ------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `current-data-metadata-after.json`          | 20 文件、161/161、零失败／跳过                             | `f25228c45ec64501f03a3c0b6620ce6aa9d576dc770828223e2fd08765998477` |
| `current-media-archive-metadata-after.json` | 实际媒体／包 4/4、零失败／跳过                             | `3577aaf4f8293dda6f5c7748617487c0d27f7b1dbfb9d09f84a100c145115f87` |
| `final-output-publication.json`             | metadata 最后冻结后 7 文件、82/82、含最新 8 项 origin 专项 | `53c2c61019af7bca57d2bb3cf583c2e6a6cda823312f6aa576239d3afb7513ec` |
| `all-result-origin-unit.json`               | 新 metadata 定向 11/11，已包含于前述数据范围               | `ac416ee652717f969af670c62c05f636d27af962c4c92c9950f5732468aba010` |
| `current-legacy-animatic.json`              | 原样片交付兼容 1/1                                         | `0408c854b54e193910ae7180f30cc381431c75ab1d4648d2c8a54692423cf578` |

报告有重叠，不相加为独立样本。首次 `output-publication-regression.json` 的 81/82 失败仍保留：原测试把允许新增的私有 receipt 当成执行内容全字节不变；修后只剥离 `outputEvidence`，其余 Frozen 字段整体深相等，原付费次数、人工恢复和当前范围变化只入历史的断言均保留。

最终 `final-output-publication.execution.json` 的执行前后源码表实际相同；在该次 as-run 复核时，复核过的 24 个源码哈希逐一相符，后端冻结表的 5 个核心文件及 `sequence-snapshot.ts` 的 SHA `b605656986b4c6d80ff2d0abe7e4b8ca5b6b08b7b87e408d60bd8c2e0599c163` 亦现场复算一致。执行快照的文件总数不当作人工逐项码读数量。后续 P03 公开属性隔离修复另见 [P03](P03.md) 与 [P11](P11.md) 的补充记录，不据此宣称当前源码仍与该次 as-run 完全相同。

本轮新增独立反例及关闭依据：

- 已发布候选恢复到本地别名时，原实现会把新 local `result.id` 拼进旧原始 tuple。现 `Frozen.outputEvidence` 在发布前持久保存完整冻结输入指纹、done journal `key/attemptId/requestId`、输出 `port/ordinal` 与完整 `PortValue` 指纹及原五元组。同 epoch 只精确复用旧 tuple；缺失／非法输出证据、同 asset 但完整载荷变化均保持未知。首次空 marker 区分新执行尚未发布与旧任务缺少原输出证明；仅 scope 三字段不足以推断原候选。新的实际 `manual_resubmit` 提交身份产生新候选，不套旧 tuple。已读源码和实际 8 项新 raw，known 恢复明确深比旧 `f.result.generationOrigin`，同时要求 local result ID 另发。
- 新 `generationOrigin` 曾仅对 video 隔离。本人纯内存 image 反例实际出现 `updates=0` 而 Yjs 字节变化。数据作者改为 `snapshotResultEvidence`：新 metadata 的 create／add／read 入口均拥有独立且不可替换的 tuple；video 保持完整深隔离，无 origin 的旧非 video payload 保留原路径。本人重新执行 image 入参／读出／替换／追加、known video、legacy image 三分支核验，字节与 Undo／update 均符合合同；结果为 `independent-result-origin-probe.json`，SHA `5feeb8f9984f57994b379a4c30d684e4c74e9cc2842dce640df1877242200b87`。该 probe 的占位 asset ID 只测 API 身份，不作真实媒体留存证明。

当前实际证据使用 `media-metadata-after/`，不混用早阶段 `media/` 或原丢失的 accepted 目录。已按字节复算成片 SHA `89e7c3ade30699031261719d1cc66f1eb32f204d4885a844c1987b843b8f85c7`，与新 delivery、P12 请求及 observed asset 相同；P12 原始 JSON SHA 为 `ba78b5a6425dbdc4a43125ccbb3243b95121bce263f381969c3f46dfc9987ba8`。实际读取新 ZIP，clip-map 与两条 delivery sources 仅差声明的 shotId 投影，SRT 逐字保持 A `[0.2,0.9)`／B `[1.6,2.3)` 和 literal `@林夏`；同一 segment 的两个实例仍各自保留 speed、叠化区间及叙事。原 v1 兼容由当前受版本控制的金样与新迁移测试检查，已丢失的原四份 capture JSON 不声称重新找回。

新 `known-origin-archive.json` SHA 为 `4beb1db45dd8ba5f82b25d0f65f3202f87dee172a86123e247331f85c5c04f28`。已逐字段比对真实 mock 首任务的原五元组在 template、checkpoint、current／all 冲突导入后保持相同，selection 指向实际本地 canvas／node／candidate／run alias；首任务 setup 为 1 submit，后续为 0。主成片、声音路由及 legacy live 例均为受控来源、0 模型调用，缺原生成证据只保留 selection，不伪造 origin。legacy live 仅在确切当前实例／来源／端口／边、无显式叙事及无固定段时使用冻结叙事关联；源码与实际源节点重绑／删除后的新记录一致。current／all 的实际候选数为 1／2，旧确认显式历史化，不继承到新范围。

当前 L1／L2 数据、原执行身份、后端恢复与归档差异复核通过，已知数据阻塞关闭。本轮只重新核对文件字节、JSON 和 ZIP，没有再次运行大套测试／FFmpeg 解码／共享构建／浏览器，也没有播放声音；D 波实际解码及最终 UI 由主 Agent 和其他独立复核者完成。真实模型、自然人批准、动作质量、口型、剪辑软件实机导入及 L4 未由本签署证明。

## 正常展开到 v2 序列的追加独立复核

2026-10-26。恢复 UI 暴露真实 P07／P11 集成回归：旧 `linkSequence` 在 `connect` 自动建立稳定实例后，写回此前缓存的 source-only clips，导致新序列映射损坏并被真实生成清单阻断。原 103 项中的失败及 `producer-before.json` 的 3 失败／1 通过均保留，不归因于 codec 或降低原 UI 要求。

数据作者新增独立 v2 分支，连接后重新读取完整当前实例。本人逐项只读回查：已固定当前叙事行不补回生成依赖，手工字幕保留；仅真实 source／port／唯一 edge 对应的 live legacy 行更新计划管理对白，非 legacy 声音、别端口、坏 edge、历史叙事与 detached 配音不被接管；同 source 多实例各自 ID、顺序及入出点保留。已标记 v2 的损坏行不会被过滤为可付费的新行。另程序化比对 v1 原 body 与 Git HEAD 逐字相同，SHA-256 `0b05244039c5209bc66fda3468a1a5e202d5c8c28413278c8d704b0d3dd20790`。

当前 `producer-final.json` 实际为 7 文件 55/55、零失败／跳过，SHA-256 `1b55d822fb9530f5adf0d01e76f26c6c6e246e8302f52e5fd3f0a31fb480a564`；执行前后源码表相同。`storyboard.ts` 当前 SHA 为 `ba4f5a7d2e6a8c4683e69ce62f89e7b711a54462b389398488df1be5c5c429bd`。P01 原双人输入的目录构造器／显式 v1、v2 版本真实 Doc 探针另核：v2 三个完整独立实例、schema 及映射有效，更新不换 ID，0 run／submit；不以该内存探针代替最新版浏览器调用。

独立签署 `P11/independent-producer-review.json` SHA-256 `4b939f990806c5f4ac1c3613e71985af788359c674dd127469afae120f78b422`。根随后实际重建并运行原 P07 四项，最新四项全部通过，主路径原“生成 1 项”断言及真实单项 commit／submit 保留，详见 [P07 新签署](P07.md)。该追加数据集成阻塞已关闭；本人的序列 UI 仍由其他独立复核者验收，未借本签署自验。
