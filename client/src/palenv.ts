// Мок matchMedia для jsdom (IS_TOUCH в mobile.ts, §15.29 слушатель ориентации).
export {}
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  ;(window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })
}
