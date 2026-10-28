# 性能基准

在仓库根目录运行，默认使用 9510 端口和三轮中位数。报告路径使用绝对路径，因为 runner 从 server 包启动。

```sh
PERF_OUTPUT="$PWD/test-results/perf/software.json" pnpm perf
PERF_RENDERER=hardware PERF_OUTPUT="$PWD/test-results/perf/metal.json" pnpm perf
```

硬件模式显式选择 Playwright 安装的完整 Chromium，也可用 `PERF_CHROMIUM` 指定二进制；读取到软件光栅或无法辨认的 GPU 会失败。比较报告必须具有相同的浏览器种类、版本、渲染器、运行环境、夹具和轮数。每批及内存每轮记录 `uptime`，机器有其他测试负载时交替运行冻结的旧、新构建，保留全部样本。

完整基准包括真实媒体冷开／热开、五个演示画布交互场景，以及两种 GC 后保留量：

- `markdown.retainedBytes`：预热后创建、显示并删除 96 份正文，清空撤销，再比较堆。每批必须显示全部八个预览。正文缓存计数与堆差一起看；堆还含渲染器及文档的内部保留，不能把全部差值都叫作正文泄漏。
- `session.retainedBytes`：真实媒体画布预热后固定执行 12 次平移／缩放组合，每次回到相同视口。可用 `PERF_SESSION_ITERATIONS` 调整工作量，两份报告必须一致。记录 GC 前后堆、DOM、监听器、纹理和应用缓存，避免把临时分配或离屏剔除误认为泄漏或改善。

本地默认每帧派发一个滚轮步骤；CI 设置 `PERF_SESSION_STEPS_PER_FRAME=5`，仅在内存场景中将每五个相邻步骤合并到一帧，减少软件光栅重复绘制。每组平移／缩放仍分别派发 120 个事件，事件顺序和位移保持一致，预热、12 次测量交互、每四次交互的 GC 采样、三轮中位数及正文工作量均保留；五个交互性能场景的派发节奏不变。允许值为 1～5，报告在 `fixture.sessionStepsPerFrame` 记录节奏，比较时必须一致；早期 v3 报告缺省为 1。

内存回退同时超过基线的 50% 和 2 MiB 才触发比较门槛；启动和交互沿用原有门槛。报告格式为 v3，缺场景、缺轮数、伪造中位数或旧格式报告均不能通过比较。

`pnpm perf:compare` 用候选侧同一套 harness、Chromium 和夹具，顺序构建并测量独立检出的基线与候选，包括两侧全部内存场景。演示画布的同宽、同结构便签在计时前按可见正文的实际排版高度统一几何，消除异步量高时序导致的夹具差异；高度仍参与完整内容哈希校验。基线自身是否带有 memory 脚本不影响测量，不能据此跳过内存比较或减少基线轮数。基线目录必须干净并已按锁文件安装依赖。与 CI 相同的运行方式：

```sh
PERF_N=1000 PERF_ROUNDS=3 PERF_SESSION_STEPS_PER_FRAME=5 \
  PERF_BASE_REF=v0.6.0 PERF_BASE_ROOT=/absolute/path/to/clean-baseline \
  PERF_COMPARE_OUTPUT="$PWD/test-results/perf-comparison" pnpm perf:compare
```

CI 以约 25 分钟内完成整个 perf job 为预算，45 分钟超时用于异常兜底。`comparison.json` 记录总耗时及两侧构建／测量耗时，各报告的 `details.timings` 记录打开、交互和内存分段，`details.memory` 保留每轮正文／会话耗时，便于检查预算和定位增长。

以下为诊断模式，输出 `status=diagnostic`，不能替代完整门禁：

```sh
# 反复打开并记录资源加载瀑布，不执行交互和内存场景
PERF_OPEN_ONLY=1 PERF_RENDERER=hardware pnpm perf
# CPU 采样会扰动耗时，单独用于归因
PERF_PROFILE=打开 PERF_RENDERER=hardware pnpm perf
PERF_PROFILE=热开 pnpm perf
# 十分钟持续会话；计时从基线 GC 完成后开始，另记实际交互次数
PERF_PROFILE=会话 PERF_SESSION_MS=600000 PERF_RENDERER=hardware pnpm perf
```

对已有冻结构建重复测量时，用 `PERF_DIST` 指向构建目录，并直接执行 runner，避免重建：

```sh
PERF_DIST="$PWD/test-results/perf/frozen-dist" PERF_PORT=9510 \
  pnpm --filter @plein/server exec node --import tsx ../../e2e/perf/bench.ts
```

所有测量使用临时数据和 mock 平台。退出时关闭浏览器与测试服务并删除数据目录；不能替代安装版、原生输入或真实模型验收。
