// First-person input: pointer lock + mouse look (yaw/pitch, pitch clamped to
// ±89°) + WASD/Space key state. Owns only the *view*; movement itself is
// server-authoritative — keys are shipped to the server ~30/s by main.ts.

import type { KeysState } from './net'

const SENS_RAD_PER_PX = 0.0022
const PITCH_LIMIT = (89 * Math.PI) / 180
const TAU = Math.PI * 2

export class Controls {
  yaw = 0
  pitch = 0
  locked = false
  readonly keys: KeysState = { w: 0, a: 0, s: 0, d: 0, interact: 0 }

  constructor(private canvas: HTMLCanvasElement) {
    document.addEventListener('mousemove', this.onMouseMove)
    document.addEventListener('pointerlockchange', this.onPointerLockChange)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.resetKeys)
  }

  requestLock(): void {
    if (this.locked) return
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
    if (!this.locked) return
    this.yaw += e.movementX * SENS_RAD_PER_PX
    if (this.yaw > Math.PI) this.yaw -= TAU
    else if (this.yaw < -Math.PI) this.yaw += TAU
    // Wire pitch is positive-up (GDD §9.2) and movementY is positive when the
    // mouse moves DOWN — subtract, or every shot sent to the server aims at a
    // vertically mirrored direction while the local camera still feels fine.
    this.pitch = Math.max(
      -PITCH_LIMIT,
      Math.min(PITCH_LIMIT, this.pitch - e.movementY * SENS_RAD_PER_PX),
    )
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

  private readonly resetKeys = (): void => {
    this.keys.w = 0
    this.keys.a = 0
    this.keys.s = 0
    this.keys.d = 0
    this.keys.interact = 0
  }

  private setKey(code: string, v: 0 | 1): boolean {
    switch (code) {
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
