import type { AgentKind, AgentSkill, AgentSkillCatalog, AgentSkillDetail } from '@plein/protocol'
import { AgentSkills, SkillError } from './skills'
import { AgentError } from './session-types'

/**
 * 技能目录的会话侧入口：把技能层的错误翻译成会话统一的 AgentError。
 * 技能本身的管理在 skills.ts，这里只负责对外语义。
 */

/** 技能目录：内置指南与本机 CLI 技能 */
export function skillsCatalog(
  manager: AgentSkills,
  ownerId: string,
  agent: AgentKind,
  refresh = false,
): Promise<AgentSkillCatalog> {
  return manager.catalog(ownerId, agent, refresh)
}

/** 一份技能的完整说明（正文只在内置指南里有） */
export async function skillDetail(
  manager: AgentSkills,
  ownerId: string,
  agent: AgentKind,
  id: string,
): Promise<AgentSkillDetail> {
  try {
    return await manager.detail(ownerId, agent, id)
  } catch (error) {
    if (error instanceof SkillError) throw new AgentError(error.code, error.message)
    throw error
  }
}

/** 启用或停用一份技能 */
export async function skillToggle(
  manager: AgentSkills,
  ownerId: string,
  agent: AgentKind,
  id: string,
  enabled: boolean,
): Promise<AgentSkill> {
  try {
    return await manager.toggle(ownerId, agent, id, enabled)
  } catch (error) {
    if (error instanceof SkillError) throw new AgentError(error.code, error.message)
    throw error
  }
}
