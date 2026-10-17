import type {
  BackupRestored,
  CleanupPreview,
  CleanupResult,
  DataSpace,
  LocalBackup,
  MaintenanceSettings,
  MaintenanceStatus,
} from '@plein/protocol'
import { ApiError } from '../../api/client'

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const response = await fetch(`/api/maintenance/${path}`, init)
  const value: unknown = await response.json()
  if (!response.ok) {
    const error = value as { error?: string; message?: string }
    throw new ApiError(
      response.status,
      error.error ?? 'http_error',
      error.message ?? response.statusText,
    )
  }
  return value as T
}

export const maintenanceApi = {
  status: () => request<MaintenanceStatus>('status'),
  space: () => request<DataSpace>('space'),
  settings: (settings: MaintenanceSettings) =>
    request<MaintenanceStatus>('settings', 'PUT', settings),
  backup: () => request<LocalBackup>('backups', 'POST'),
  restoreCopy: (id: string) =>
    request<BackupRestored>(`backups/${encodeURIComponent(id)}/restore-copy`, 'POST'),
  preview: () => request<CleanupPreview>('cleanup/preview', 'POST'),
  cleanup: (token: string) => request<CleanupResult>('cleanup', 'POST', { token }),
  restoreTrash: (id: string) =>
    request<{ assets: number }>(`trash/${encodeURIComponent(id)}/restore`, 'POST'),
}
