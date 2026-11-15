// Мобильная адаптация (ГДД §15): определение touch-устройства на стороне JS и
// оверлей meatview — крестина движения слева («под большой палец»:
// верх/низ/лево/право = w/s/a/d) + круг прицела справа (перетаскивание пальцем,
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
// Мёртвая зона крестовины (~18% радиуса): центр — нейтраль, чтобы смена
// направления на проходе пальца через центр не дёргала тело.
const PAD_DEAD = 0.18

export class TouchOverlay {
  /** Палец на круге прицела — touch-эквивалент controls.locked для гейта
   *  автоогня (§3.2/§15.1). */
  aiming = false

  private readonly root: HTMLElement
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
    rightCol.append(act, this.look)
    this.root.append(this.pad, rightCol)
    document.body.append(this.root)
  }

  /** Сброс при входе/выходе из деки и смерти: скрытый CSS оверлей мог не
   *  получить pointerup — не оставляем «удержание» на крестовине. */
  reset(): void {
    this.padId = null
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

  // ── крестина: позиционный хит-тест (палец скользит по кресту, не по кнопкам) ──

  private readonly onPadDown = (e: PointerEvent): void => {
    e.preventDefault()
    if (this.padId !== null) return // второй палец на крестовине — игнор
    this.padId = e.pointerId
    this.pad.setPointerCapture(e.pointerId)
    this.padApply(e)
  }

  private readonly onPadMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.padId) return
    this.padApply(e)
  }

  private readonly onPadUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.padId) return
    this.padId = null
    this.segHot(null)
    const k = this.controls.keys
    k.w = k.a = k.s = k.d = 0
  }

  private padApply(e: PointerEvent): void {
    const r = this.pad.getBoundingClientRect()
    const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2)
    const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2)
    const k = this.controls.keys
    k.w = k.a = k.s = k.d = 0
    let dir: keyof TouchOverlay['segs'] | null = null
    if (Math.max(Math.abs(dx), Math.abs(dy)) >= PAD_DEAD) {
      if (Math.abs(dx) > Math.abs(dy)) {
        if (dx > 0) {
          k.d = 1
          dir = 'right'
        } else {
          k.a = 1
          dir = 'left'
        }
      } else if (dy > 0) {
        k.s = 1
        dir = 'down'
      } else {
        k.w = 1
        dir = 'up'
      }
    }
    this.segHot(dir)
  }

  private segHot(dir: keyof TouchOverlay['segs'] | null): void {
    for (const [k, el] of Object.entries(this.segs)) el.classList.toggle('hot', k === dir)
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
