/** 空对话里的示例：随画布状态变化，选区类示例只在真有选中时出现 */
export function agentSuggestions(state: { elementCount: number; selectedCount: number }): string[] {
  if (state.selectedCount > 0)
    return [
      '用选中的角色参考图和配音，做一段 5 秒的视频',
      '看看这块画布，还缺哪些环节',
      '选中的视频节奏太慢，帮我调整一下',
    ]
  if (state.elementCount > 0)
    return [
      '看看这块画布，还缺哪些环节',
      '帮我检查角色和场景的设定是否前后一致',
      '把现有内容整理成清晰的创作流程',
    ]
  return [
    '帮我把这个创意做成一分钟短剧：',
    '先帮我写一个三幕剧本',
    '搭一套角色、场景和分镜的画布，我再来调整',
  ]
}
