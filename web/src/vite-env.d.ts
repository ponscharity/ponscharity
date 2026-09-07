/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RHC_RPC?: string
  readonly VITE_LAUNCHPAD?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
