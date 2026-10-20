# 当前版本完整创作 UI 验收

## 结果与范围

以 `53482eb` 为基点，加入生成失败说明底色修复；生产构建与开发态 StrictMode 均完成同一条完整浏览器流程。当前版本的本地 mock 创作链路已统一验收，不再仅依赖分段或旧冻结记录。结构化结果见 `docs/benchmarks/2026-10-20-complete-creation-ui.json`。

用例为 `e2e/creation-end-to-end.spec.ts`。从首页新建项目、铺短剧模板开始，实际通过界面运行剧本和角色／场景抽取、生成两张角色卡及环境／道具卡、编辑两镜分镜并展开，再批量生成图像、视频、对白，生成配乐和导出 MP4。没有直接注入生成结果或替代界面提交；读取文档与任务输入用于核对，受控平台设置用于故障注入。

## 核对内容

- 两个镜头均有图、视频和对白节点。实际提交记录中的角色／环境／道具参考元素 ID 与图片资产一致；图生视频使用对应镜头图片；两句配音使用各自角色音色。
- 对已生成视频发起新任务，等 mock 平台受理后从界面取消，再从任务面板重新获取。按隔离服务 registry 的真实 submit 入口计数，核查不新增提交；没有把 attempts 当作平台提交次数。
- 受控鉴权失败后，原采用候选与结果数组保持，首次 MP4 原文件字节相同。恢复设置后通过画布错误卡片的“重试”完成新候选，显式切换并采用。
- 首版 MP4 在浏览器实际播放、时间推进；填写时间码意见时确认按钮停用，解决意见后才能确认。此为隔离数据中的脚本交互，不是人工创作质量审核。
- 页面刷新、实际关闭并重新启动测试服务后，全部元素字段、世界几何、父级、连线和任务 ID／状态／尝试次数／输入哈希保持。
- 再次导出确实新增结果，新版不继承上一版确认。两份实际 MP4 均完整解码；首版为 1080×1920 H.264、AAC 48kHz、2 秒。mock 视频内容固定，版本与候选身份验证不代表画面质量提升。

每种模式实际观测 submit：文本 3、图片 6、视频 5、配音 2、配乐 1；共 17 次，全部为 mock。19 条任务记录中 17 成功、2 条预期失败（取消后的原远端已终止、受控鉴权失败），最终素材、成片和返工结果均符合断言。未调用真实计费平台。

首次流程中两处失败属于测试假设：已有成片时按钮为“重新导出”；恢复调度会增加 attempts，但不等同再次 submit。修正定位及计数口径后，完整链路通过，没有因此修改产品提交／恢复逻辑。

## UI 调整

失败说明原来仅有透明红色径向渐变，直接叠在旧媒体上，彩色底图使标题与细节难辨认。现在在渐变下使用主题 surface 实底。已复查修改前后截图，并用卡片“重试”完成恢复；旧候选、采用状态和旧 MP4 不被改写。生产与开发两态最终流程均通过，根 TypeScript、专项格式／lint、生产构建通过。

## 复现

专用配置 `e2e/playwright.creation.config.ts` 不借用普通回归的共享后端。用例独立创建临时数据，重启自己的服务并在结束后清理；开发模式仅另启 Vite。macOS 有现成包内 FFmpeg 时复用它，也可通过 PLEIN_FFMPEG_PATH／PLEIN_FFPROBE_PATH 显式指定；否则使用系统工具。字幕烧录需要相应媒体能力。

```sh
(cd apps/web && ../../node_modules/.bin/vp build --mode e2e --outDir /private/tmp/plein-creation-ui-dist)
PLEIN_FLOW_DIST=/private/tmp/plein-creation-ui-dist node_modules/.bin/playwright test -c e2e/playwright.creation.config.ts --output=/private/tmp/plein-creation-ui-production
PLEIN_FLOW_DEV=1 PLEIN_FLOW_DIST=/private/tmp/plein-creation-ui-dist node_modules/.bin/playwright test -c e2e/playwright.creation.config.ts --output=/private/tmp/plein-creation-ui-development
```

本轮使用 8893／8894 端口，生产服务也验证系统分配端口。没有重启制作服务、读取或修改安装数据库，也没有写共享依赖。原始媒体、截图、服务数据和独立构建均为临时产物，核对并提取结构化报告后清理。

尚不关闭真实模型质量、真实供应商异常／费用、原生输入、密集媒体性能及全部功能域汇总验收。这里的重启是正常关闭／重开服务，不冒充进程强杀或断电；整体目标仍未完成。
