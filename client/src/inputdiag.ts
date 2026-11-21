// ?inputdiag=1 — диагностический оверлей для плейтеста на чужих машинах
// (ГДД §15.40, баг-репорт owner 2026-11-21: Firefox 159/160 + Ubuntu, «клавиша
// считывается раз в секунду», «нельзя ходить и крутить мышь одновременно»).
// Воспроизвести такое на своей машине нельзя — значит, страница сама считает
// первичные события и рисует их на экране: тестеру остаётся прислать скришот.
//
// Два входа в один и тот же счётчик:
//   1) URL-параметр ?inputdiag=1 — вручную (для себя, через DevTools);
//   2) серверный флаг по нику: держатель стенда дёргает
//      GET /api/diag?name=Ник&on=1 → сервер шлёт welcome.diag=1 при входе и
//      {"t":"diag"} мгновенно онлайн — владелец говорит тестеру просто
//      «перегрузись и побегай», ни URL, ни DevTools тестеру не нужны.
// setDiag(true|false) идемпотентна: слушатели навешиваются/снимаются один раз,
// счётчики при выключении обнуляются.
//
// Как читать оверлей (норма при активном вводе показана в скобках):
//   keys ~n/с   — keydown с autorepeat при зажатой клавише: ~20-35/с (X11) или
//     ~1/с при зажатой без repeat (тогда «раз в секунду» видно прямо здесь);
//     held[...] — что зажато сейчас; пустеет сам при живой клавише =ghost;
//   last N мс   — с последнего keydown: при зажатой WASD не должно расти;
//   mm ~n/с     — движения мыши под lock: норм 60-125+/с; единицы/секунды при
//     вращении = Firefox не доставляет дельты (главная ветка «не крутится»);
//   ghost×N     — keyup, за которым в пределах 1.2 с пришёл новый keydown той
//     же клавиши ПОКА мышь двигалась: «отпустил не сам» — ОС/браузер рвёт
//     удержание во время движения мыши (механика «нельзя И идти, И крутить»);
//   lock lost/gained — >2-3 флапаньев за заход = мигающий lock (grace-фикс
//     Controls уже смягчает это); err>0 = отказ самого захвата;
//   fps         — всё выше в норме, а дёргается — винить рендер при низком fps.
// Оверлей ничего не меняет в игре: слушает в capture-фазе, только наблюдает.

const held = new Set<string>()
const downAt = new Map<string, number>()
// keyup живой клавиши, запоминаем чтобы поймать «фантомное нажатие» следом
const pendingGhost = new Map<string, { t: number; movedDuringHold: boolean }>()
let ghost = 0

const keys = { down: 0, up: 0, lastAt: 0, maxGapMs: 0 }
const mm = { n: 0, px: 0, lastAt: 0, maxGapMs: 0 }
const lock = { lost: 0, gained: 0, err: 0, lastAt: 0 }

// скользящий бакет за последнюю секунду (для ~n/с)
const bucket = { t: 0, keyN: 0, mmN: 0, mmPx: 0 }
let keyRate = 0
let mmRate = 0
let mmPxRate = 0
let fps = 0
let fpsFrames = 0
let fpsWin = 0

let installed = false
let panel: HTMLElement | null = null
let rafOn = false

function onKeyDown(e: KeyboardEvent): void {
  const now = performance.now()
  if (keys.lastAt !== 0) {
    const gap = now - keys.lastAt
    if (gap > keys.maxGapMs) keys.maxGapMs = gap
  }
  keys.lastAt = now
  keys.down++
  bucket.keyN++
  if (!e.repeat) {
    // «фантомное нажатие»: после отпускания в<1.2с новый press той же
    // клавиши, и всё это пока мышь под lock двигалась — человек такие
    // двойные нажатия осознанно не делает; рвёт удержание доставка.
    const p = pendingGhost.get(e.code)
    if (p !== undefined && now - p.t < 1200 && mm.lastAt > p.t && p.movedDuringHold) ghost++
    pendingGhost.delete(e.code)
    held.add(e.code)
    downAt.set(e.code, now)
  }
}

function onKeyUp(e: KeyboardEvent): void {
  keys.up++
  if (held.has(e.code)) {
    pendingGhost.set(e.code, {
      t: performance.now(),
      movedDuringHold: mm.lastAt >= (downAt.get(e.code) ?? 0),
    })
  }
  held.delete(e.code)
  downAt.delete(e.code)
}

function onBlur(): void {
  held.clear()
  downAt.clear()
  pendingGhost.clear()
}

function onMouseMove(e: MouseEvent): void {
  if (document.pointerLockElement === null) return // считаем только «игровую» мышь
  const now = performance.now()
  if (mm.lastAt !== 0) {
    const gap = now - mm.lastAt
    if (gap > mm.maxGapMs) mm.maxGapMs = gap
  }
  mm.lastAt = now
  if (e.movementX !== 0 || e.movementY !== 0) {
    mm.n++
    const d = Math.abs(e.movementX) + Math.abs(e.movementY)
    mm.px += d
    bucket.mmN++
    bucket.mmPx += d
  }
}

function onLockChange(): void {
  lock.lastAt = performance.now()
  if (document.pointerLockElement === null) lock.lost++
  else lock.gained++
}

function onLockError(): void {
  lock.lastAt = performance.now()
  lock.err++
}

function tick(t: number): void {
  rafOn = true
  if (fpsWin === 0) fpsWin = t
  else {
    fpsFrames++
    const span = t - fpsWin
    if (span >= 500) {
      fps = Math.round((fpsFrames * 1000) / span)
      fpsFrames = 0
      fpsWin = t
    }
  }
  if (bucket.t === 0) bucket.t = t
  else if (t - bucket.t >= 1000) {
    keyRate = bucket.keyN
    mmRate = bucket.mmN
    mmPxRate = Math.round(bucket.mmPx)
    bucket.t = t
    bucket.keyN = 0
    bucket.mmN = 0
    bucket.mmPx = 0
  }
  if (panel !== null) {
    const now = performance.now()
    const age = (last: number): string => (last === 0 ? 'нет' : `${Math.round(now - last)} мс`)
    panel.textContent =
      `keys ~${keyRate}/с  held[${[...held].join(',')}]  last ${age(keys.lastAt)}  (макс.пауза ${Math.round(keys.maxGapMs)})\n` +
      `mm   ~${mmRate}/с px ${mmPxRate}  last ${age(mm.lastAt)}  (макс.пауза ${Math.round(mm.maxGapMs)})  ghost×${ghost}\n` +
      `lock lost=${lock.lost} gained=${lock.gained} err=${lock.err}  last ${age(lock.lastAt)}\n` +
      `${fps} fps · ${navigator.userAgent.slice(0, 44)}`
  }
  if (installed) requestAnimationFrame(tick)
  else rafOn = false
}

/** Идемпотентный переключатель оверлея. false снимает слушатели, панель и
 *  обнуляет счётчики — повторный true начинает с чистого листа. */
export function setDiag(on: boolean): void {
  if (on === installed) return
  installed = on
  if (!on) {
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('mousemove', onMouseMove, true)
    document.removeEventListener('pointerlockchange', onLockChange, true)
    document.removeEventListener('pointerlockerror', onLockError, true)
    panel?.remove()
    panel = null
    keys.down = 0
    keys.up = 0
    keys.lastAt = 0
    keys.maxGapMs = 0
    mm.n = 0
    mm.px = 0
    mm.lastAt = 0
    mm.maxGapMs = 0
    lock.lost = 0
    lock.gained = 0
    lock.err = 0
    lock.lastAt = 0
    ghost = 0
    held.clear()
    downAt.clear()
    pendingGhost.clear()
    return
  }
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)
  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('pointerlockchange', onLockChange, true)
  document.addEventListener('pointerlockerror', onLockError, true)
  panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;left:8px;top:8px;z-index:2147483647;font:11px/1.45 ui-monospace,monospace;' +
    'color:#37ff9b;background:rgba(0,0,0,.75);padding:6px 8px;border:1px solid #37ff9b66;' +
    'border-radius:4px;pointer-events:none;white-space:pre'
  document.body.append(panel)
  if (!rafOn) requestAnimationFrame(tick)
}

/** Авто-старт по URL-параметру (для себя через DevTools). Серверный флаг —
 *  через setDiag из main.ts (§9.2 welcome.diag / {"t":"diag"}). */
export function maybeInstallFromUrl(): void {
  if (new URLSearchParams(location.search).has('inputdiag')) setDiag(true)
}
