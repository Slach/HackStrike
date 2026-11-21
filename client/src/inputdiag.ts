// ?inputdiag=1 — диагностический оверлей для плейтеста на чужих машинах
// (ГДД §15.40, баг-репорт owner 2026-11-21: Firefox 159/160 + Ubuntu, «клавиша
// считывается раз в секунду», «нельзя ходить и крутить мышь одновременно»).
// Воспроизвести такое на своей машине нельзя — значит, страница сама считает
// первичные события и рисует их на экране: тестеру остаётся прислать скришот.
//
// Как читать оверлей (для каждого симптома — свой счётчик):
//   keys down/up — НЕ растётся при нажатиях → события не доходят до страницы
//     (доставка браузера/ОС, а не игра);
//   held         — «залипание»: держишь W, а held пуст → браузер сам прислал
//     keyup, которого ты не нажимал (режим «раз в секунду»);
//   gap          — пауза МЕЖДУ keydown: «клавиша считывается раз в секунду»
//     видно как большой макс.пауза;
//   mm           — движения мыши: count/с и суммарный |movementX| — если при
//     вращении мышью mm стоит на нуле, мышь под lock не отдаёт дельты;
//   lock         — lost/gained/error: флики pointer lock (курсор мигает) —
//     главный кандидат «нельзя И ходить, И крутить» на Wayland/GTK;
//   fps          — если всё выше в норме, а fps низкий, тормозит рендер.
// Оверлей ничего не меняет в игре: слушает в capture-фазе, только наблюдает.
// Без параметра в URL — одна проверка строки на старте, дальше не существует.

type LockCounts = { lost: number; gained: number; err: number; lastAt: number }
type KeyCounts = { down: number; up: number; lastAt: number; maxGapMs: number }
type MmCounts = { n: number; px: number; lastAt: number; maxGapMs: number }

const keys: KeyCounts = { down: 0, up: 0, lastAt: 0, maxGapMs: 0 }
const mm: MmCounts = { n: 0, px: 0, lastAt: 0, maxGapMs: 0 }
const lock: LockCounts = { lost: 0, gained: 0, err: 0, lastAt: 0 }
const held = new Set<string>()
let fps = 0
let fpsFrames = 0
let fpsWindow = 0

export function installInputDiag(): void {
  if (!new URLSearchParams(location.search).has('inputdiag')) return

  window.addEventListener(
    'keydown',
    (e) => {
      const now = performance.now()
      if (keys.lastAt !== 0) {
        const gap = now - keys.lastAt
        if (gap > keys.maxGapMs) keys.maxGapMs = gap
      }
      keys.lastAt = now
      keys.down++
      if (!e.repeat) held.add(e.code)
    },
    { capture: true },
  )
  window.addEventListener(
    'keyup',
    (e) => {
      keys.up++
      held.delete(e.code)
    },
    { capture: true },
  )
  window.addEventListener('blur', () => held.clear())

  document.addEventListener(
    'mousemove',
    (e) => {
      if (document.pointerLockElement === null) return // считаем только «игровую» мышь
      const now = performance.now()
      if (mm.lastAt !== 0) {
        const gap = now - mm.lastAt
        if (gap > mm.maxGapMs) mm.maxGapMs = gap
      }
      mm.lastAt = now
      if (e.movementX !== 0 || e.movementY !== 0) {
        mm.n++
        mm.px += Math.abs(e.movementX) + Math.abs(e.movementY)
      }
    },
    { capture: true },
  )
  document.addEventListener(
    'pointerlockchange',
    () => {
      lock.lastAt = performance.now()
      if (document.pointerLockElement === null) lock.lost++
      else lock.gained++
    },
    { capture: true },
  )
  document.addEventListener(
    'pointerlockerror',
    () => {
      lock.lastAt = performance.now()
      lock.err++
    },
    { capture: true },
  )

  const panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:2147483647;font:11px/1.45 ui-monospace,monospace;' +
    'color:#37ff9b;background:rgba(0,0,0,.75);padding:6px 8px;border:1px solid #37ff9b66;' +
    'border-radius:4px;pointer-events:none;white-space:pre'
  document.body.append(panel)

  requestAnimationFrame(function tick(t: number): void {
    if (fpsWindow === 0) fpsWindow = t
    else {
      fpsFrames++
      const span = t - fpsWindow
      if (span >= 500) {
        fps = Math.round((fpsFrames * 1000) / span)
        fpsFrames = 0
        fpsWindow = t
      }
    }
    const now = performance.now()
    panel.textContent =
      `keys down=${keys.down} up=${keys.up}  held[${[...held].join(',')}]  ` +
      `gap max ${Math.round(keys.maxGapMs)} мс\n` +
      `mm n=${mm.n} px=${Math.round(mm.px)}  gap max ${Math.round(mm.maxGapMs)} мс\n` +
      `lock lost=${lock.lost} gained=${lock.gained} err=${lock.err}` +
      (lock.lastAt === 0 ? '\n' : `  (${Math.round(now - lock.lastAt)} мс назад)\n`) +
      `${fps} fps · ${navigator.userAgent.slice(0, 44)}`
    requestAnimationFrame(tick)
  })
}
