# 预览程序复用与引擎释放验收

## 问题与修复

`da1e93c` 的预览 Shader 工厂在每次建立引擎时调用 `compileHighShaderGlProgram`。Pixi 8.22 的该函数直接构造 `GlProgram`，并不经过 `GlProgram.from` 缓存；预处理还会递增 `SHADER_NAME`，使等价程序的源码及 `_key` 随重新进入画布而变化。Pixi 的 `createIdFromString` 会在模块级保留这些不同源码键。此前将该工厂视为已复用程序的判断不准确。

现在同一模块只创建一次逻辑 `GlProgram`，各引擎仍创建独立 Shader 和 local uniform。关闭引擎销毁自己的 Shader，保留共享逻辑程序；各 WebGL context 的 GPU 程序仍由自身 renderer 创建和释放，不能据此声称跨 context 只编译一次。

新增 CPU 回归先在原实现失败，修复后通过；它检查共享程序身份、uniform 隔离、先后销毁及重新创建。浏览器回归另核对实际像素、半透明合成、缩放、检查点预览关闭及恢复，以及千媒体画布连续进出后的资源所有权。

## 证据边界

本轮使用隔离服务、Mock 平台和本机无头 Chromium／SwiftShader，不产生模型费用，不改变安装版或制作数据。未改变批处理几何和小卡片 Shader 选择条件。初步占位图几何调查不足以支持扩大 Shader 范围，因此未修改该逻辑。

插桩诊断只用于检查程序名与调用阶段；正式性能结果使用原始未插桩基准。候选六次打开保持相同的预览程序名，但每个新 context 仍有程序初始化，耗时存在波动。性能收益须与独立原始报告一起判断，不作为硬件帧率或长时使用证明。

## 当前测量

未插桩完整三轮基准：冷开首预览 937.6ms，热开 786.3ms；前一批相同环境原实现分别为 955.5／886.8ms，五类交互无回归门槛触发。六次打开均 1000／1000 预览就绪，无预览、请求或运行时错误。结果见[原始报告](../benchmarks/2026-10-21-shared-preview-perf.json)。不同批次仍有波动，不把本批差值写成稳定收益。

[旧构建诊断](../benchmarks/2026-10-21-preview-program-baseline-trace.json)三次重新进入均出现 `preview-graphics-vertex-2`／`fragment-2`；[候选诊断](../benchmarks/2026-10-21-preview-program-candidate-trace.json)三次均保持原名。诊断本身的热开中位数为 672／668.9ms，不支持明显的启动提速结论。旧构建诊断是重新采集的独立批次：首次诊断的临时输出曾被候选覆盖，未将其冒充原始留存。

## 最终定向验收

修复提交 `0ed1e1d`。核心 11 文件／81 项通过；生产构建和开发 StrictMode 各 36 项通过，均无失败、跳过或 flaky。实际像素与半透明合成、多引擎关闭恢复、千媒体资源释放、触控取消后重开和预览失败恢复均保留原业务断言。canvas-core、Web、root 三处 TypeScript 及改动文件格式／lint 通过；没有再跑全仓覆盖率。

[结构化记录](../benchmarks/2026-10-21-preview-program-reuse.json)保留源码哈希、构建身份及原始报告哈希。验收仍为本机软件浏览器证据；原生窗口再次读取仍报告 Mac 已锁屏，实际 IME、窗口变化和硬件长时使用未据此关闭。
