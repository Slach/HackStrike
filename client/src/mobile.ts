// Мобильная адаптация (ГДД §15): определение touch-устройства на стороне JS и
// оверлей meatview — аналоговый стик движения слева («под большой палец»:
// палец лежит на pads постоянно, скольжением выбирается одно из 8 направлений
// + нейтраль = w/a/s/d и их диагональные комбинации, §15.11) + круг прицела
// справа (перетаскивание пальцем,
// схема Gun Bros: палец на круге ≡ захваченная мышь). Плюс кнопка ДЕЙСТВИЕ
// (=Space: edge-джек-ин) и слежение за экранной клавиатурой: CSS-переменная
// --kb даёт деке якорь палитры НАД клавиатурой (§15.2).
//
// Протокол не меняется: оверлей пишет в те же KeysState/yaw-pitch, что
// клавиатура с мышью; сервер типа устройства не видит (§9.2).

import type { Controls } from './controls'

/** Детект по JavaScript-признакам, не по User-Agent (ГДД §15): UI решает
 *  наличие пальца, а не бренд. Десктоп с сенсорным экраном получит оверлей —
 *  сознательный trade-off: он мыши не мешает, а coarse-only сломал бы планшеты
 *  и hybrid-ноутбуки. */
export const IS_TOUCH =
  matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints ?? 0) > 0

/** ДЕПЛОЙ на touch: развернуть на весь экран и принудить ландшафт (GDD §15.4).
 *  Fullscreen-first, затем screen.orientation.lock('landscape') — Chrome на
 *  Android разрешает lock только в fullscreen, поэтому ждём промис перед локом.
 *  iOS Safari: requestFullscreen на не-<video> и orientation.lock недоступны —
 *  там эффект даёт только установка в standalone (PWA «Домой»); вызовы молча
 *  фолбэкаются. Парный выход — exitLandscapeFullscreen при resetSession. */
export function enterLandscapeFullscreen(): void {
  void (async () => {
    const de = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => void
    }
    try {
      if (typeof de.requestFullscreen === 'function') {
        await de.requestFullscreen()
      } else {
        de.webkitRequestFullscreen?.()
      }
    } catch {
      /* без жеста/разрешения браузер отказал — играем в окне */
    }
    const so = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>
    }
    try {
      await so.lock?.('landscape')
    } catch {
      /* нет API (iOS) или запрещён — держим ориентацию как есть */
    }
  })()
}

/** Выход из боя/лобби: снять лок ориентации и fullscreen (§15.4). */
export function exitLandscapeFullscreen(): void {
  const so = screen.orientation as unknown as { unlock?: () => Promise<void> | void }
  void Promise.resolve(so.unlock?.()).catch(() => undefined)
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void }
  if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
    if (typeof doc.exitFullscreen === 'function') void doc.exitFullscreen().catch(() => undefined)
    else doc.webkitExitFullscreen?.()
  }
}

/** Палитра/оверлеи поднимаются над экранной клавиатурой: --kb держится в CSS
 *  на :root, обновляется на resize visualViewport (mobile.ts — единственный
 *  владелец переменной, hackview читает её через CSS). */
export function startKeyboardTracker(): void {
  const vv = window.visualViewport
  const apply = (): void => {
    const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0
    document.documentElement.style.setProperty('--kb', `${kb}px`)
  }
  apply()
  if (vv !== null) {
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
  }
  window.addEventListener('resize', apply)
}

// Touch-пиксель «дороже» мышиного, а палец по кругу ходит меньше курсора:
// базовая чувствительность прицела ×3 против прежних 0.0032 (ревебр owner,
// §15.5) — 0.0096 рад/px против 0.0022 у мыши. Сверху пользовательский
// множитель слайдера настроек (0.3×…3.0×, §15.5).
const LOOK_BASE = 0.0096 / 0.0022
// Мёртвая зона стика (~18% радиуса, визуальный хаб): центр — нейтраль (9-е
// состояние), чтобы смена направления на проходе пальца через центр не дёргала
// тело.
const PAD_DEAD = 0.18
// Гистерезис сектора (§15.11): направление меняется, только когда палец ушёл
// на 7° за границу 45°-сектора — иначе на проходе пальца у границы
// диагональ/прямая chatter'ят и направление дрожит.
const PAD_HYST = 0.12
const PAD_STEP = Math.PI / 4
// Сектора по углу atan2(dy,dx) в экранных координатах (0 = вправо, π/2 = вниз):
// индекс → какие из w/a/s/d поднять. 4 глифа-стрелки подсвечиваются по флагам
// клавиш, диагональ = две стрелки сразу (§15.11).
const PAD_DIRS: ReadonlyArray<ReadonlyArray<'w' | 'a' | 's' | 'd'>> = [
  ['d'],           // E
  ['s', 'd'],      // SE
  ['s'],           // S
  ['a', 's'],      // SW
  ['a'],           // W
  ['a', 'w'],      // NW
  ['w'],           // N
  ['w', 'd'],      // NE
]

export class TouchOverlay {
  /** Палец на круге прицела — touch-эквивалент controls.locked для гейта
   *  автоогня (§3.2/§15.1). */
  aiming = false

  /** Мгновенный flush input при смене контрольного состояния (ГДД §15.13):
   *  pointerdown/смена сектора/pointerup/ДЕЙСТВИЕ. Без коллбэка — noop. */
  onActivity: (() => void) | null = null

  /** §13.7: кнопка КАМЕРЫ — тап-эквивалент V (открыть вид камеры / следующая).
   *  §15.35 (ревебр owner): переименована из «КАМ», показывается только когда
   *  есть захваченная камера союзников — setCamVisible вызывается из
   *  snap-хэндлера main.ts. */
  onCam: (() => void) | null = null

  private readonly root: HTMLElement
  private readonly cam: HTMLButtonElement
  private readonly pad: HTMLElement
  private readonly segs: Record<'up' | 'down' | 'left' | 'right', HTMLElement>
  private readonly look: HTMLElement

  private padId: number | null = null
  private lookId: number | null = null
  private lookX = 0
  private lookY = 0
  /** Queue тапов ДЕЙСТВИЕ: consumeInteract() отдаёт 1 ровно на один input-тик
   *  (rising edge как у Space; тап короче тика не должен теряться). */
  private interactQueued = false

  constructor(private controls: Controls) {
    this.root = document.createElement('div')
    this.root.id = 'touchui'
    this.root.addEventListener('contextmenu', (e) => e.preventDefault())

    this.pad = document.createElement('div')
    this.pad.className = 'tc-pad'
    const up = document.createElement('div')
    up.className = 'tc-seg up'
    up.textContent = '\u25B2'
    const down = document.createElement('div')
    down.className = 'tc-seg down'
    down.textContent = '\u25BC'
    const left = document.createElement('div')
    left.className = 'tc-seg left'
    left.textContent = '\u25C0'
    const right = document.createElement('div')
    right.className = 'tc-seg right'
    right.textContent = '\u25B6'
    const hub = document.createElement('div')
    hub.className = 'tc-hub'
    this.segs = { up, down, left, right }
    this.pad.append(up, down, left, right, hub)
    this.pad.addEventListener('pointerdown', this.onPadDown)
    this.pad.addEventListener('pointermove', this.onPadMove)
    this.pad.addEventListener('pointerup', this.onPadUp)
    this.pad.addEventListener('pointercancel', this.onPadUp)

    const act = document.createElement('button')
    act.className = 'tc-act'
    act.textContent = 'ДЕЙСТВИЕ'
    act.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.interactQueued = true
      this.onActivity?.() // edge interact уходит в ближайший же кадр, не со слота (§15.13)
    })

    this.look = document.createElement('div')
    this.look.className = 'tc-look'
    const ring = document.createElement('div')
    ring.className = 'tc-look-ring'
    ring.textContent = 'ПРИЦЕЛ'
    this.look.append(ring)
    this.look.addEventListener('pointerdown', this.onLookDown)
    this.look.addEventListener('pointermove', this.onLookMove)
    this.look.addEventListener('pointerup', this.onLookUp)
    this.look.addEventListener('pointercancel', this.onLookUp)

    // Справа столбик: ДЕЙСТВИЕ над кругом прицела (оба под правый палец).
    const rightCol = document.createElement('div')
    rightCol.className = 'tc-right'
    // §13.7: КАМЕРЫ — тап-эквивалент V: открыть вид камеры / следующая
    // камера. §15.35: скрыта пока нет ни одной захваченной камеры союзников
    // (setCamVisible из main), чтобы не светить мёртвую кнопку.
    this.cam = document.createElement('button')
    this.cam.className = 'tc-cam'
    this.cam.textContent = 'КАМЕРЫ'
    this.cam.style.display = 'none'
    this.cam.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.onCam?.()
    })
    rightCol.append(act, this.cam, this.look)
    this.root.append(this.pad, rightCol)
    document.body.append(this.root)
  }

  /** Сброс при входе/выходе из деки и смерти: скрытый CSS оверлей мог не
   *  получить pointerup — не оставляем «удержание» на крестовине. */
  reset(): void {
    this.padId = null
    this.padSec = -1
    this.lookId = null
    this.aiming = false
    this.look.classList.remove('aiming')
    this.segHot(null)
    const k = this.controls.keys
    k.w = k.a = k.s = k.d = 0
  }

  /** 1 ровно один раз на queued-тап ДЕЙСТВИЕ; вызывать из input-цикла main. */
  consumeInteract(): 0 | 1 {
    if (!this.interactQueued) return 0
    this.interactQueued = false
    return 1
  }

  /** §15.35: видимость кнопки КАМЕРЫ — только при захваченных камерах
   *  союзников (владение приходит снапшотами, main синкает на каждый snap). */
  setCamVisible(on: boolean): void {
    this.cam.style.display = on ? 'flex' : 'none'
  }

  // ── крестина: позиционный хит-тест (палец скользит по кресту, не по кнопкам) ──

  private readonly onPadDown = (e: PointerEvent): void => {
    e.preventDefault()
    if (this.padId !== null) return // второй палец на крестовине — игнор
    this.padId = e.pointerId
    this.pad.setPointerCapture(e.pointerId)
    // padApply сам флешит при смене сектора (§15.13) — здесь отдельный flush
    // не нужен: палец в мёртвой зоне не менял состояние, флешить нечего.
    this.padApply(e)
  }

  private readonly onPadMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.padId) return
    this.padApply(e)
  }

  private readonly onPadUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.padId) return
    this.padId = null
    this.padSec = -1 // следующий тап — холодный старт, без гистерезиса прошлого
    this.segHot(null)
    const k = this.controls.keys
    k.w = k.a = k.s = k.d = 0
    this.onActivity?.() // стоп тоже мгновенно, иначе тело «докатится» до слота
  }

  /** Индекс активного 45°-сектора стика, -1 = нейтраль. Держится между
   *  pointermove ради гистерезиса (§15.11). */
  private padSec = -1

  private padApply(e: PointerEvent): void {
    const r = this.pad.getBoundingClientRect()
    const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2)
    const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2)
    const k = this.controls.keys
    k.w = k.a = k.s = k.d = 0

    const prev = this.padSec
    // Нейтраль — не по Chebyshev, а по радиусу: палец у края по диагонали даёт
    // больший dx,dy, чем у края по прямой, и Chebyshev-порог резал бы углы.
    const rad = Math.hypot(dx, dy)
    if (rad < PAD_DEAD) {
      this.padSec = -1
      this.segHot(null)
      if (prev !== -1) this.onActivity?.() // сектор → нейтраль = смена состояния
      return
    }
    const ang = Math.atan2(dy, dx) // (−π, π]; 0 = вправо, π/2 = вниз
    const raw = ((Math.round(ang / PAD_STEP) % 8) + 8) % 8 // ближайший из 8
    let sec = this.padSec
    if (sec === -1) {
      sec = raw
    } else {
      // Гистерезис: сменить сектор можно, только когда угол ушёл за его
      // границу на PAD_HYST (обмотка угла через ±π учтена). У края стика
      // (rad > 1.5) цепляемся за ближайший сектор напрямую.
      let d = ang - sec * PAD_STEP
      if (d > Math.PI) d -= Math.PI * 2
      else if (d < -Math.PI) d += Math.PI * 2
      if (Math.abs(d) >= PAD_STEP / 2 + PAD_HYST || rad > 1.5) sec = raw
    }
    this.padSec = sec

    for (const key of PAD_DIRS[sec]) k[key] = 1
    this.segHot(k)
    if (sec !== prev) this.onActivity?.() // смена направления — без ожидания слота (§15.13)
  }

  /** Подсветка стрелок по активным флагам клавиш: диагональ жжёт две стрелки
   *  сразу (§15.11), нейтраль — ни одной. */
  private segHot(active: { w: number; a: number; s: number; d: number } | null): void {
    this.segs.up.classList.toggle('hot', active !== null && active.w === 1)
    this.segs.down.classList.toggle('hot', active !== null && active.s === 1)
    this.segs.left.classList.toggle('hot', active !== null && active.a === 1)
    this.segs.right.classList.toggle('hot', active !== null && active.d === 1)
  }

  // ── круг прицела: drag = delta взгляда, удержание = «взгляд активен» ──

  private readonly onLookDown = (e: PointerEvent): void => {
    e.preventDefault()
    if (this.lookId !== null) return
    this.lookId = e.pointerId
    this.lookX = e.clientX
    this.lookY = e.clientY
    this.aiming = true
    this.look.setPointerCapture(e.pointerId)
    this.look.classList.add('aiming')
  }

  private readonly onLookMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.lookId) return
    // Пиксели пальца → «мышинные» пиксели (×LOOK_BASE); пользовательский
    // множитель слайдера применяется один раз в controls.look (§15.5).
    const dx = (e.clientX - this.lookX) * LOOK_BASE
    const dy = (e.clientY - this.lookY) * LOOK_BASE
    this.lookX = e.clientX
    this.lookY = e.clientY
    this.controls.look(dx, dy)
  }

  private readonly onLookUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.lookId) return
    this.lookId = null
    this.aiming = false
    this.look.classList.remove('aiming')
  }
}
