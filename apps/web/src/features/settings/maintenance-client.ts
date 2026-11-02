import type {
  BackupRestored,
  CleanupPreview,
  CleanupResult,
  DataSpace,
  LocalBackup,
  MaintenanceSettings,
  MaintenanceStatus,
} from '@plein/protocol'
import { json, request } from '../../api/http'

/** 维护接口共用统一请求层：会话失效时同样回到登录页。 */
function maintenanceRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return request<T>(`/api/maintenance/${path}`, json(method, body))
}

export const maintenanceApi = {
  status: () => maintenanceRequest<MaintenanceStatus>('status'),
  space: () => maintenanceRequest<DataSpace>('space'),
  settings: (settings: MaintenanceSettings) =>
    maintenanceRequest<MaintenanceStatus>('settings', 'PUT', settings),
  backup: () => maintenanceRequest<LocalBackup>('backups', 'POST'),
  restoreCopy: (id: string) =>
    maintenanceRequest<BackupRestored>(`backups/${encodeURIComponent(id)}/restore-copy`, 'POST'),
  preview: () => maintenanceRequest<CleanupPreview>('cleanup/preview', 'POST'),
  cleanup: (token: string) => maintenanceRequest<CleanupResult>('cleanup', 'POST', { token }),
  restoreTrash: (id: string) =>
    maintenanceRequest<{ assets: number }>(`trash/${encodeURIComponent(id)}/restore`, 'POST'),
}
