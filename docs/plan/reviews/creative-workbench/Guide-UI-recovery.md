# 2026-10-26 创作引导滚动修复独立复核

独立复核者 `p05_source_mapping`；产品修复和实际浏览器执行者为主 Agent `/root`。本记录只签本轮 Guide 范围，不能把整个 103 项运行写成通过，也不代替本人曾实施的 P05／P11 UI 的独立验收。

已实际读取安全根 `.creative-workbench-evidence/2026-10-26-recovery/ui/current/report.json`，SHA-256 `beb648c4fbd521903b3bd9465a990eef453e7b62812120c8d962dd058fe25d9d`。该整轮为 101 通过、2 失败、零跳过；其中 Guide 五份规格共 19/19 全部通过：boundaries 8、layout 2、production 3、progress 2、主规格 4。两个全局失败分别属于交付媒体即时采样和 P07／P11 展开接线，未借本子集签署关闭。

修前已亲看两个失败截图、上下文和实际源码：长总览加入后，滚动 body 的 flex 子元素会压缩，分镜名 `p.truncate` 被压到零高度；窄屏中旧测试同时要求关闭、试做选择和第三步同屏命中，也不符合长内容的滚动操作。根修为 body `min-h-0` 和直接子元素 `shrink-0`，保留自然高度及纵向滚动，关闭按钮位于滚动区外。该修复没有改只读、持久化、生成或身份逻辑。

已回查窄屏新测试：逐一真实 `scrollIntoViewIfNeeded`，然后要求目标自身包含 `elementFromPoint` 命中；每次滚动后另核关闭按钮全界在视口内且自身可命中。原删除镜头、等待重新选择、撤销／重做、确切候选定位及零新增执行请求断言均保留，没有放宽为任意 Guide 内元素命中。无需增加复述 CSS 的单测。

本人实际查看三份当前新截图：`guide-missing-trial.png`、`guide-mobile-dialog.png`、`guide-narrow-names.png`。第三步通过滚动可见，关闭按钮仍可用；菜单／Esc、窗口切换、同名目标消歧和已删镜头不重绑按原交互执行。原失败截图仍保留，不以新截图冒充原运行。

新独立原始报告引用、19 条用例、复核时源码及实际查看图的 SHA 保存在 `P02/independent-guide-ui-review.json`，SHA-256 `0f9f696d21d9237480194db0fe34887e7ebf860d452569e095a6cd328c28440f`。本轮 Guide 修复及对应 L3 范围通过；没有修改产品、共享构建或自行运行浏览器。受控文档／任务状态不冒充真人创作验收，质量与人工可接受性仍为未知。
