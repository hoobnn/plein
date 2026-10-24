import type { Voice } from '@plein/protocol'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { queryClient, queryKeys } from '../../api/query'

/** 有音色还在训练时多久重新拉一次；服务端拉列表时顺手向平台查状态 */
const TRAINING_POLL = 20_000

/** 我的音色：资产库「音色」页与音色下拉共用一份 */
export function useVoices() {
  return useQuery({
    queryKey: queryKeys.voices,
    queryFn: api.voices,
    refetchInterval: (q) =>
      q.state.data?.some((v) => v.status === 'training') ? TRAINING_POLL : false,
  })
}

/** 服务端确认后的单条结果写回列表 */
export function cacheVoice(voice: Voice) {
  queryClient.setQueryData<Voice[]>(queryKeys.voices, (list = []) =>
    list.some((v) => v.id === voice.id)
      ? list.map((v) => (v.id === voice.id ? voice : v))
      : [voice, ...list],
  )
}

export function dropVoice(id: string) {
  queryClient.setQueryData<Voice[]>(queryKeys.voices, (list) => list?.filter((v) => v.id !== id))
}

export const voiceTraits = (v: Pick<Voice, 'gender' | 'age'>) =>
  [v.gender === 'female' ? '女' : v.gender === 'male' ? '男' : '', v.age === 'mature' ? '成熟' : '']
    .filter(Boolean)
    .join(' · ')
