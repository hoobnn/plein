import type { Project, ProjectImportResult } from '@plein/protocol'
import { ExportPackageDialog, ImportPackageDialog } from '../features/projects/ProjectPackage'
import { AnimatePresence } from '../ui/motion'

export function HomePackageDialogs({
  exporting,
  importing,
  onCloseExport,
  onCloseImport,
  onImported,
}: {
  exporting: Project | null
  importing: File | null
  onCloseExport(): void
  onCloseImport(): void
  onImported(result: ProjectImportResult): void
}) {
  return (
    <>
      <AnimatePresence>
        {exporting && <ExportPackageDialog project={exporting} onClose={onCloseExport} />}
      </AnimatePresence>
      <AnimatePresence>
        {importing && (
          <ImportPackageDialog file={importing} onClose={onCloseImport} onImported={onImported} />
        )}
      </AnimatePresence>
    </>
  )
}
