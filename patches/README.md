# 依赖补丁

## pixi.js 8.22.0

`pixi.js@8.22.0.patch` 让 `GraphicsContextSystem` 仅在 WebGPU 后端构造图形批次的绑定组。WebGL 的 `GlGraphicsAdaptor` 直接绑定纹理，不使用这些组；原路径却仍把图片源及采样器留在全局绑定缓存里，图片被正常卸载时触发 `BindGroup` 销毁警告并残留无用缓存项。

补丁同时覆盖包的 ESM 和 CommonJS 入口，通过 `pnpm-workspace.yaml` 与锁文件安装；不改变纹理池淘汰策略，也不屏蔽警告。后续升级 PixiJS 时，核对这个后端条件是否已经在上游修复，迁移或删除补丁后运行以下验证：

- `packages/canvas-core/src/graphics-bindings.test.ts`：WebGL 不新增纹理变更监听，WebGPU 仍绑定实际图片源。此单测不创建真实 GPU。
- 纹理、视图与渲染器单测：共享租约和最后一个拥有者释放后正常卸载。
- `e2e/checkpoint-texture-lifecycle.spec.ts`：实际 WebGL 图片和文本检查点反复切换、关闭与恢复，断言没有资源销毁警告及未处理异常，图片预览完成绘制。

此补丁没有证明 WebGPU 真机资源释放或所有滤镜纹理路径已验收。
