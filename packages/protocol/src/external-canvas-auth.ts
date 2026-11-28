import { z } from 'zod'
import { ExternalPlatform } from './external-canvas'

export const ExternalAuthRequest = z.object({ provider: ExternalPlatform }).strict()
export const ExternalAuthState = z.union([
  z.object({ status: z.enum(['authenticated', 'signed-out', 'expired', 'denied']) }),
  z.object({
    status: z.literal('pending'),
    verificationUrl: z.url(),
    expiresAt: z.string(),
    userCode: z.string().optional(),
  }),
])
export type ExternalAuthState = z.infer<typeof ExternalAuthState>
export type ExternalAuthAction = 'status' | 'start' | 'finish'
export const externalAuthPath = (canvasId: string, action: ExternalAuthAction) =>
  `/api/canvases/${encodeURIComponent(canvasId)}/external/auth/${action}`
