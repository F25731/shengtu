export {}

declare global {
  interface Window {
    __YUNYI_REFRESH_BALANCE__?: () => void
  }
}
