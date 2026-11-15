// Auto-reload после пердеплоя клиента (M4, плейтест-инфра): во время итераций
// сервер/стенд рестартуют и отдаёт новый хэш-бандл, а вкладки держат старый —
// раньше спасал только хард-релоад владельцем. В проде каждые CHECK_MS тихо
// сравниваем path отдаваемого /assets/index-*.js с собственным import.meta.url
// (хэш меняется ровно при изменении кода → ложных reload нет); в dev'е
// index.html ссылается на /src/main.ts = наш же URL → never fires, HMR live.
// Обновление бандла в разгаре матча всё равно «свежий сервер» (reconnect
// привёл бы в новую комнату старым кодом) — reload без пощады.
// Проверка через query-параметр, чтобы никакой cache/etag не соврал.

const CHECK_MS = 4000
let reloading = false

export const startUpdateWatch = (): void => {
  setInterval(async () => {
    if (reloading) return
    try {
      const res = await fetch(`${location.pathname}?_rv=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) return
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html')
      const src = doc.querySelector('script[type="module"]')?.getAttribute('src')
      if (!src) return
      const fresh = new URL(src, location.href)
      const mine = new URL(import.meta.url)
      if (fresh.pathname !== mine.pathname) {
        reloading = true
        console.log(`updatewatch: client bundle ${mine.pathname} -> ${fresh.pathname}, reloading`)
        location.reload()
      }
    } catch {
      // стенд перезагружается/сеть моргнула — следующая проверка разберётся
    }
  }, CHECK_MS)
}
