// First-person input: pointer lock + mouse look (yaw/pitch, pitch clamped to
// ±89°) + WASD/Space key state. Owns only the *view*; movement itself is
// server-authoritative — keys are shipped to the server ~30/s by main.ts.

import type { KeysState } from './net'
import { IS_TOUCH as TOUCH } from './mobile'

const SENS_RAD_PER_PX = 0.0022
const PITCH_LIMIT = (89 * Math.PI) / 180
const TAU = Math.PI * 2
/** Окно «вернётся ли lock» при его потере (см. onPointerLockChange). */
const GRACE_MS = 150

export class Controls {
  yaw = 0
  pitch = 0
  locked = false
  /** While the hacker view is up the body must not look around (GDD §12.1). */
  frozen = false
  /** Optional inverted vertical look (settings checkbox, GDD §3.2). */
  invertY = false
  /** Пользовательский множитель чувствительности взгляда, 0.3..3.0
   *  (экран настроек §15.5): и мышью, и тач-прицелом — look() общий путь. */
  sensScale = 1
  readonly keys: KeysState = { w: 0, a: 0, s: 0, d: 0, interact: 0 }

  constructor(private canvas: HTMLCanvasElement) {
    document.addEventListener('mousemove', this.onMouseMove)
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.resetKeys)
  }

  requestLock(): void {
    if (this.locked || TOUCH) return // на touch lock недостижим: палец на круге прицела (§15.1)
    // Older browsers return undefined, newer a promise — handle both.
    const res = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined
    res?.catch(() => undefined)
  }

  dispose(): void {
    this.cancelGrace()
    document.removeEventListener('mousemove', this.onMouseMove)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.resetKeys)
  }

  /** Перехват дельты взгляда (ГДД §13.7 V-режим): возвращает true, если
   *  съедено. Мышь и touch-круг идут через одну точку, чтобы камера в V
   *  крутилась тем же mlook, но медленно. */
  lookOverride: ((dxPx: number, dyPx: number) => boolean) | null = null

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return
    if (this.lookOverride?.(e.movementX, e.movementY) === true) return
    if (this.frozen) return
    this.look(e.movementX, e.movementY)
  }

  /** Сдвиг взгляда на дельту в «мышинных» пикселях. Общий путь для мыши
   *  (movementX/Y) и touch-круга прицела (mobile.ts, ГДД §15.1). */
  look(dxPx: number, dyPx: number): void {
    if (this.lookOverride?.(dxPx, dyPx) === true) return
    if (this.frozen) return
    const sens = SENS_RAD_PER_PX * this.sensScale
    this.yaw += dxPx * sens
    if (this.yaw > Math.PI) this.yaw -= TAU
    else if (this.yaw < -Math.PI) this.yaw += TAU
    // Wire pitch is positive-up (GDD §9.2) and dy is positive DOWN — subtract,
    // or every shot sent to the server aims vertically mirrored while the
    // local camera still feels fine. invertY flips only the local feel; the
    // wire value stays in convention.
    const dy = (this.invertY ? dyPx : -dyPx) * sens
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dy))
  }

  private readonly onPointerLockChange = (): void => {
    const nowLocked = document.pointerLockElement === this.canvas
    if (nowLocked) this.cancelGrace() // lock вернулся до истечения grace — клавиши целы
    this.locked = nowLocked
    // Сброс откладывается (плейтест owner 2026-11-21, Firefox 159/160 Ubuntu):
    // на Wayland/GTK указатель под lock мигает: lock кратковременно теряется
    // и тут же возвращается. Мгновенный resetKeys превращал фликер в «отпустило WASD
    // посреди бега»: движение дёргается, идти + крутить мышь не выходит.
    // Esc-выход при этом не ломается: без возврата lock'а grace сработает, а
    // tryRelock на следующем keydown всё равно пересграбит курсор.
    if (!this.locked) this.scheduleGrace()
  }

  private graceTimer = 0
  private scheduleGrace(): void {
    if (this.graceTimer !== 0) return
    this.graceTimer = window.setTimeout(() => {
      this.graceTimer = 0
      if (!this.locked) this.resetKeys()
    }, GRACE_MS)
  }
  private cancelGrace(): void {
    if (this.graceTimer !== 0) {
      clearTimeout(this.graceTimer)
      this.graceTimer = 0
    }
  }

  /** Мгновенный flush input при смене контрольного состояния (ГДД §15.13):
   *  main вешает sendInputNow; без коллбэка (тесты) — тихий noop. */
  onActivity: (() => void) | null = null
  /** Перехват «ДЕЙСТВИЯ» до отправки на сервер (§16.7: space у клавиатуры
   *  замка открывает пад кода, а не джек-ин). true = обработано, interact
   *  не выставляется и на сервер не уходит. */
  interactInterceptor: (() => boolean) | null = null

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.setKey(e.code, 1) && this.locked) e.preventDefault()
    // autorepeat (e.repeat) не флешим — состояние не менялось, слот 30 Гц
    // и так его передаёт; flush только на rising edge клавиши.
    if (!e.repeat) this.onActivity?.()
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.setKey(e.code, 0)
    this.onActivity?.()
  }

  /** Public: main.ts clears stale keys when entering/leaving the hacker view. */
  readonly resetKeys = (): void => {
    this.keys.w = 0
    this.keys.a = 0
    this.keys.s = 0
    this.keys.d = 0
    this.keys.interact = 0
  }

  private setKey(code: string, v: 0 | 1): boolean {    switch (code) {
      case 'KeyW':
        this.keys.w = v
        return true
      case 'KeyA':
        this.keys.a = v
        return true
      case 'KeyS':
        this.keys.s = v
        return true
      case 'KeyD':
        this.keys.d = v
        return true
      case 'Space':
        // rising edge у клавиатуры замка — отдаём UI, сервер джек-ина не видит.
        if (v === 1 && this.interactInterceptor !== null && this.interactInterceptor()) {
          return true
        }
        this.keys.interact = v
        return true
      default:
        return false
    }
  }
}
