// ?inputdiag=1 — диагностический оверлей для плейтеста на чужих машинах
// (ГДД §15.40, баг-репорт owner 2026-11-21: Firefox 159/160 + Ubuntu, «клавиша
// считывается раз в секунду», «нельзя ходить и крутить мышь одновременно»).
// Воспроизвести такое на своей машине нельзя — значит, страница сама считает
// первичные события и рисует их на экране: тестеру остаётся прислать скришот.
//
// Ревизия после первого же скрина-отчёта: кумулятивных счётчиков мало — по ним
// не отличить «события не доходят» от «тестер не нажимал». Поэтому у каждой
// строки есть СВЕЖЕСТЬ (last N мс назад — растёт на глазах при доставочном
// провале) и РЕЙТ за последнюю секунду (~n/с — нормальные цифры поданы ниже).
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
// Без параметра в URL — одна проверка строки на старте, дальше не существует.

const held = new Set<string>() // код -> время keydown (мс, performance)
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
    },
    { capture: true },
  )
  window.addEventListener(
    'keyup',
    (e) => {
      keys.up++
      if (held.has(e.code)) {
        // «отпустил не сам» фиксируется только если клавиша реально
        // удерживалась; movedDuringHold — отличает ghost от простого тапа
        pendingGhost.set(e.code, {
          t: performance.now(),
          movedDuringHold: mm.lastAt >= (downAt.get(e.code) ?? 0),
        })
      }
      held.delete(e.code)
      downAt.delete(e.code)
    },
    { capture: true },
  )
  window.addEventListener('blur', () => {
    held.clear()
    downAt.clear()
    pendingGhost.clear()
  })

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
        const d = Math.abs(e.movementX) + Math.abs(e.movementY)
        mm.px += d
        bucket.mmN++
        bucket.mmPx += d
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
    const now = performance.now()
    const age = (last: number): string => (last === 0 ? 'нет' : `${Math.round(now - last)} мс`)
    panel.textContent =
      `keys ~${keyRate}/с  held[${[...held].join(',')}]  last ${age(keys.lastAt)}  (макс.пауза ${Math.round(keys.maxGapMs)})\n` +
      `mm   ~${mmRate}/с px ${mmPxRate}  last ${age(mm.lastAt)}  (макс.пауза ${Math.round(mm.maxGapMs)})  ghost×${ghost}\n` +
      `lock lost=${lock.lost} gained=${lock.gained} err=${lock.err}  last ${age(lock.lastAt)}\n` +
      `${fps} fps · ${navigator.userAgent.slice(0, 44)}`
    requestAnimationFrame(tick)
  })
}
