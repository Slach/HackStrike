// Auto-reload после пердеплоя клиента (M4, плейтест-инфра): во время итераций
// сервер/стенд рестартуют и отдаёт новый хэш-бандл, а вкладки держат старый —
// раньше спасал только хард-релоад владельцем. В проде раз в CHECK_MS тихо
// сравниваем path отдаваемого /assets/index-*.js с собственным import.meta.url
// (хэш меняется ровно при изменении кода → ложных reload нет); в dev'е
// index.html ссылается на /src/main.ts = наш же URL → never fires, HMR live.
// Фейл проверки (стенд в момент пересборки, сеть моргнула) = экспоненциальный
// backoff до MAX_MS, успех возвращает базовый интервал. Обновление бандла в
// разгаре матча всё равно «свежий сервер» (reconnect привёл бы в новую комнату
// старым кодом) — reload без пощады.

const CHECK_MS = 30_000
const MAX_MS = 8 * CHECK_MS

export const startUpdateWatch = (): void => {
  let delay = CHECK_MS
  let reloading = false
  const check = async (): Promise<void> => {
    if (reloading) return
    try {
      const res = await fetch(`${location.pathname}?_rv=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(`updatewatch: status ${res.status}`)
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
      const src = doc.querySelector('script[type="module"]')?.getAttribute('src')
      if (!src) throw new Error('updatewatch: no module script')
      const fresh = new URL(src, location.href)
      const mine = new URL(import.meta.url)
      if (fresh.pathname !== mine.pathname) {
        reloading = true
        console.log(`updatewatch: client bundle ${mine.pathname} -> ${fresh.pathname}, reloading`)
        location.reload()
        return
      }
      delay = CHECK_MS // успех сбрасывает backoff
    } catch {
      delay = Math.min(delay * 2, MAX_MS)
    }
    setTimeout(check, delay)
  }
  setTimeout(check, delay)
}
