import type { TabaneApi } from '../shared/types'

declare global {
  interface Window {
    tabane: TabaneApi
  }
}

export {}
