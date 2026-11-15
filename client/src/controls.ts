// First-person input: pointer lock + mouse look (yaw/pitch, pitch clamped to
// ±89°) + WASD/Space key state. Owns only the *view*; movement itself is
// server-authoritative — keys are shipped to the server ~30/s by main.ts.

import type { KeysState } from './net'
import { IS_TOUCH as TOUCH } from './mobile'

const SENS_RAD_PER_PX = 0.0022
const PITCH_LIMIT = (89 * Math.PI) / 180
const TAU = Math.PI * 2

export class Controls {
  yaw = 0
  pitch = 0
  locked = false
  /** While the hacker view is up the body must not look around (GDD §12.1). */
  frozen = false
  /** Optional inverted vertical look (settings checkbox, GDD §3.2). */
  invertY = false
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
    document.removeEventListener('mousemove', this.onMouseMove)
    document.removeEventListener('pointerlockchange', this.onPointerLockChange)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.resetKeys)
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked || this.frozen) return
    this.look(e.movementX, e.movementY)
  }

  /** Сдвиг взгляда на дельту в «мышинных» пикселях. Общий путь для мыши
   *  (movementX/Y) и touch-круга прицела (mobile.ts, ГДД §15.1). */
  look(dxPx: number, dyPx: number): void {
    if (this.frozen) return
    this.yaw += dxPx * SENS_RAD_PER_PX
    if (this.yaw > Math.PI) this.yaw -= TAU
    else if (this.yaw < -Math.PI) this.yaw += TAU
    // Wire pitch is positive-up (GDD §9.2) and dy is positive DOWN — subtract,
    // or every shot sent to the server aims vertically mirrored while the
    // local camera still feels fine. invertY flips only the local feel; the
    // wire value stays in convention.
    const dy = (this.invertY ? dyPx : -dyPx) * SENS_RAD_PER_PX
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dy))
  }

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas
    if (!this.locked) this.resetKeys()
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.setKey(e.code, 1) && this.locked) e.preventDefault()
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.setKey(e.code, 0)
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
        this.keys.interact = v
        return true
      default:
        return false
    }
  }
}
