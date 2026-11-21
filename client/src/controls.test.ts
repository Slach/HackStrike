// Юнит-тесты Controls (ГДД §15.40): pointer-lock grace.Firefox на Wayland
// (Ubuntu) мигает pointer lock'ом; прежний мгновенный resetKeys на потерю
// lock превращал фликер в «отпустило WASD» — движение дёргается, идти +
// крутить мышь не выходит (репорт owner 2026-11-21). Инварианты:
//   1) возврат lock в окне grace — клавиши НЕ сбрасываются;
//   2)Esc-выход без возврата — по истечении grace клавиши чисто обнулены;
//   3) blur (уход с вкладки) — сброс мгновенный, grace не при чём.
// Прогон: npm test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Controls } from './controls'

let lockTarget: HTMLElement | null = null

function setLock(el: HTMLElement | null): void {
  lockTarget = el
  document.dispatchEvent(new Event('pointerlockchange'))
}

function press(canvas: HTMLElement, code: string): void {
  canvas.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }))
  window.dispatchEvent(new KeyboardEvent('keydown', { code }))
}

describe('Controls pointer-lock grace (§15.40)', () => {
  let canvas: HTMLCanvasElement
  let ctl: Controls

  beforeEach(() => {
    vi.useFakeTimers()
    lockTarget = null
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => lockTarget,
    })
    canvas = document.createElement('canvas')
    document.body.append(canvas)
    ctl = new Controls(canvas)
  })

  afterEach(() => {
    ctl.dispose()
    canvas.remove()
    vi.useRealTimers()
  })

  it('краткий фликер lock не сбрасывает удерживаемые клавиши', () => {
    setLock(canvas)
    press(canvas, 'KeyW')
    expect(ctl.keys.w).toBe(1)
    setLock(null) // Wayland-мигание: lock потерян…
    vi.advanceTimersByTime(60) // …вернулся раньше grace
    setLock(canvas)
    vi.advanceTimersByTime(1000)
    expect(ctl.keys.w).toBe(1)
  })

  it('Esc-выход (lock не вернулся) обнуляет клавиши по истечении grace', () => {
    setLock(canvas)
    press(canvas, 'KeyW')
    expect(ctl.keys.w).toBe(1)
    setLock(null)
    vi.advanceTimersByTime(50) // в окне grace — ещё держим
    expect(ctl.keys.w).toBe(1)
    vi.advanceTimersByTime(200) // grace истёк — честный сброс
    expect(ctl.keys.w).toBe(0)
  })

  it('blur сбрасывает клавиши мгновенно, grace не удерживает', () => {
    setLock(canvas)
    press(canvas, 'KeyS')
    expect(ctl.keys.s).toBe(1)
    window.dispatchEvent(new Event('blur'))
    expect(ctl.keys.s).toBe(0)
  })
})
