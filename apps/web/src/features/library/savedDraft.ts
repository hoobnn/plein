/** 创建与更新完成后接手服务端规范化，同时保留等待期间的新输入。 */
export function settleSavedDraft<T>(submitted: T, current: T, normalized: T, placing: boolean) {
  const changed = JSON.stringify(current) !== JSON.stringify(submitted)
  return {
    draft: changed ? current : normalized,
    continuePlacement: !placing || !changed,
    notice: placing && changed ? '已保存提交时的内容，仍有新修改，请再次保存后添加到画布。' : null,
  }
}
