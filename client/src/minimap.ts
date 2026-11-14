// Top-down minimap (DOM canvas, GDD §4): map walls from /api/map, live
// allies as dots, the local player as a yaw-rotated arrow. Enemies are
// deliberately never drawn in M1.

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

  draw(me: MiniSelf | null, allies: readonly MiniAlly[], myTeam: number): void {
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

  private px(x: number): number {
    return this.offX + x * this.scale
  }

  private pz(z: number): number {
    return this.offY + z * this.scale
  }
}
