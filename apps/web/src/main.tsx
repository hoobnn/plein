import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { queryClient } from './api/query'
import { App } from './App'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { MotionProvider } from './ui/MotionProvider'
import './stores/theme'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <MotionProvider>
          <App />
        </MotionProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
)
