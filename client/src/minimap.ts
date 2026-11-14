// Top-down minimap (DOM canvas, GDD §4): map walls from /api/map, live
// allies as dots, the local player as a yaw-rotated arrow, cyber props as
// small glyphs (M2: terminal/radio/switch, doors colored by open state).
// Enemies are deliberately never drawn in M1.

import type { MapWorld, WallRect } from './map'
import { teamCss } from './players'

export interface MiniAlly {
  x: number
  z: number
}

export interface MiniSelf {
  x: number
  z: number
  yaw: number
}

export type MiniPropKind = 'terminal' | 'radio' | 'switch' | 'door' | 'camera'

export interface MiniProp {
  x: number
  z: number
  kind: MiniPropKind
  open?: boolean // дверь
  axis?: 'x' | 'z' // ориентация двери
  len?: number
}

export class Minimap {
  private ctx: CanvasRenderingContext2D
  private rects: readonly WallRect[]
  private w: number
  private h: number
  private scale: number
  private offX: number
  private offY: number

  constructor(canvas: HTMLCanvasElement, world: MapWorld) {
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('minimap: no 2d context')
    this.ctx = ctx
    this.rects = world.wallRects
    this.w = canvas.width
    this.h = canvas.height
    const pad = 6
    const [bx, , bz] = world.bounds
    this.scale = Math.min(
      (this.w - pad * 2) / Math.max(bx, 1),
      (this.h - pad * 2) / Math.max(bz, 1),
    )
    this.offX = (this.w - bx * this.scale) / 2
    this.offY = (this.h - bz * this.scale) / 2
  }

  draw(me: MiniSelf | null, allies: readonly MiniAlly[], myTeam: number, props: readonly MiniProp[] = []): void {
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(2,10,6,0.92)'
    ctx.fillRect(0, 0, this.w, this.h)
    ctx.lineWidth = 1
    for (const r of this.rects) {
      const x = this.px(r.x0)
      const y = this.pz(r.z0)
      const rw = (r.x1 - r.x0) * this.scale
      const rh = (r.z1 - r.z0) * this.scale
      if (r.stair) {
        ctx.fillStyle = 'rgba(55,255,155,0.06)'
        ctx.fillRect(x, y, rw, rh)
      } else {
        ctx.fillStyle = 'rgba(55,255,155,0.16)'
        ctx.strokeStyle = 'rgba(55,255,155,0.45)'
        ctx.fillRect(x, y, rw, rh)
        ctx.strokeRect(x, y, rw, rh)
      }
    }
    this.drawProps(props)
    ctx.fillStyle = teamCss(myTeam)
    for (const a of allies) {
      ctx.beginPath()
      ctx.arc(this.px(a.x), this.pz(a.z), 3, 0, Math.PI * 2)
      ctx.fill()
    }
    if (me !== null) {
      ctx.save()
      ctx.translate(this.px(me.x), this.pz(me.z))
      ctx.rotate(Math.PI - me.yaw) // yaw 0 = +Z; minimap is north-up (-Z)
      ctx.fillStyle = '#eafff3'
      ctx.strokeStyle = 'rgba(55,255,155,0.9)'
      ctx.beginPath()
      ctx.moveTo(0, -7)
      ctx.lineTo(-5, 5)
      ctx.lineTo(5, 5)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.restore()
    }
  }

  /** Глифы пропсов: T/R/S и дверь линией (цвет = open/closed). */
  private drawProps(props: readonly MiniProp[]): void {
    const ctx = this.ctx
    for (const p of props) {
      const x = this.px(p.x)
      const y = this.pz(p.z)
      if (p.kind === 'door') {
        const open = p.open === true
        const alongZ = p.axis === 'z'
        const len = Math.max(6, (p.len ?? 1.6) * this.scale)
        ctx.strokeStyle = open ? 'rgba(55,255,155,0.95)' : 'rgba(200,208,204,0.8)'
        ctx.lineWidth = 2.5
        ctx.beginPath()
        if (alongZ) {
          ctx.moveTo(x, y - len / 2)
          ctx.lineTo(x, y + len / 2)
        } else {
          ctx.moveTo(x - len / 2, y)
          ctx.lineTo(x + len / 2, y)
        }
        ctx.stroke()
        continue
      }
      ctx.lineWidth = 1
      if (p.kind === 'terminal') {
        ctx.fillStyle = 'rgba(55,255,155,0.28)'
        ctx.strokeStyle = 'rgba(55,255,155,0.95)'
        ctx.fillRect(x - 3, y - 3, 6, 6)
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7)
      } else if (p.kind === 'radio') {
        ctx.strokeStyle = 'rgba(255,77,210,0.9)'
        ctx.beginPath()
        ctx.arc(x, y, 4, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = 'rgba(255,77,210,0.9)'
        ctx.beginPath()
        ctx.arc(x, y, 1.2, 0, Math.PI * 2)
        ctx.fill()
      } else if (p.kind === 'camera') {
        // камера (M3 §13.7): «глаз» — кольцо с точкой; зона видимости на
        // миникарте — объект M6, сейчас только маркер устройства.
        ctx.strokeStyle = 'rgba(120,230,255,0.9)'
        ctx.beginPath()
        ctx.arc(x, y, 4, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = 'rgba(120,230,255,0.9)'
        ctx.beginPath()
        ctx.arc(x, y, 1.4, 0, Math.PI * 2)
        ctx.fill()
      } else {
        // switch: ромб
        ctx.strokeStyle = 'rgba(255,210,55,0.9)'
        ctx.beginPath()
        ctx.moveTo(x, y - 4.5)
        ctx.lineTo(x + 4.5, y)
        ctx.lineTo(x, y + 4.5)
        ctx.lineTo(x - 4.5, y)
        ctx.closePath()
        ctx.stroke()
      }
    }
  }

  private px(x: number): number {
    return this.offX + x * this.scale
  }

  private pz(z: number): number {
    return this.offY + z * this.scale
  }
}
