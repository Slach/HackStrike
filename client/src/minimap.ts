// Top-down minimap (DOM canvas, GDD §4): map walls from /api/map, live
// allies as dots, the local player as a yaw-rotated arrow, cyber props as
// small glyphs (M2: terminal/radio/switch, doors colored by open state).
// Enemies are deliberately never drawn in M1.
// Cyber layer (M3 §13.8): scan-revealed devices with links, ownership and
// M3 status halos over the physical map — hacker only, key C toggles it.

import type { MapWorld, WallRect } from './map'
import { teamCss, teamEdgeCss } from './players'

export interface MiniAlly {
  x: number
  z: number
}

export interface MiniSelf {
  x: number
  z: number
  /** Высота — этаж для фильтра слоёв карты (§13.8, плейтест: карта 1 этажа
   *  показывалась на втором). Необязательна: тесты/старые вызовы — 0. */
  y?: number
  yaw: number
}

export type MiniPropKind = 'terminal' | 'radio' | 'switch' | 'door' | 'camera' | 'gas' | 'fire' | 'valve' | 'srv'

export interface MiniProp {
  x: number
  z: number
  kind: MiniPropKind
  open?: boolean // дверь / газ / водяной клапан (§14.6.1); для fire = «потушен»
  axis?: 'x' | 'z' // ориентация двери
  len?: number
}

/** Раскрытое portscan'ом устройство для кибер-слоя (M3 §13.8). */
export interface MiniCyberDev {
  id: string
  x: number
  z: number
  kind: MiniPropKind
  owner: number | null
  links: readonly string[]
  vulned?: boolean
  watched?: boolean
  firewalled?: boolean
  firewalledBy?: number // хозяин фильтра (§13.5): цвет бейджа свой/союзный/чужой
  antivirused?: boolean
}

/** Кибер-слой миникарты (§13.8): только раскрытое МОИМ portscan'ом. */
export interface MiniCyber {
  myId: number | null
  ownTeam: number
  teamOf: (playerId: number) => number | null
  devices: readonly MiniCyberDev[]
}

// Цвета кибер-слоя — зафиксированы в ГДД §13.8, консистентны с SVG-картой
// сети деки (index.html .svg-*).
const CYBER_WIRE = 'rgba(55,255,155,0.35)' // кабель — сплошная
const CYBER_WIRELESS = 'rgba(255,210,55,0.5)' // радио — пунктир
const CYBER_VISION_FILL = 'rgba(55,255,155,0.08)' // зона видимости своей камеры
const CYBER_VISION_EDGE = 'rgba(55,255,155,0.35)'
const CAM_VISION_RADIUS = 12 // м, ГДД §13.7

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

  draw(
    me: MiniSelf | null,
    allies: readonly MiniAlly[],
    myTeam: number,
    props: readonly MiniProp[] = [],
    cyber: MiniCyber | null = null,
  ): void {
    // Этаж игрока (плейтест: «миникарта показывает первый этаж хотя я уже
    // ушёл на второй»): слой карты выше STAIR_TOP (1 этаж < 8 < 2 этаж).
    const myY = me?.y ?? 0
    const floorLo = myY >= 7.5 ? 7.5 : -1
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(2,10,6,0.92)'
    ctx.fillRect(0, 0, this.w, this.h)
    ctx.lineWidth = 1
    for (const r of this.rects) {
      if (r.stair ? false : r.y0 >= 7.5 && floorLo < 7.5) continue
      if (r.stair ? false : r.y0 < 7.5 && floorLo >= 7.5) continue
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
    if (cyber !== null) this.drawCyberVisionZones(cyber)
    if (cyber !== null) this.drawCyberLinks(cyber)
    this.drawProps(props)
    if (cyber !== null) this.drawCyberStatus(cyber)
    // Союзники — заливка цветом команды + контрастная обводка (BlackHat —
    // чёрный дот с белой обводкой, иначе не виден на тёмной карте).
    ctx.fillStyle = teamCss(myTeam)
    ctx.strokeStyle = teamEdgeCss(myTeam)
    for (const a of allies) {
      ctx.beginPath()
      ctx.arc(this.px(a.x), this.pz(a.z), 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
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
      } else if (p.kind === 'gas') {
        // газ (M4 §14.2): ромб с точкой — форма switch'а, цвет состояния:
        // закрытый клапан тусклый, открытый (газ идёт) яркий ядовито-зелёный
        const open = p.open === true
        ctx.strokeStyle = open ? '#7dff50' : '#2b7a4b'
        ctx.beginPath()
        ctx.moveTo(x, y - 4.5)
        ctx.lineTo(x + 4.5, y)
        ctx.lineTo(x, y + 4.5)
        ctx.lineTo(x - 4.5, y)
        ctx.closePath()
        ctx.stroke()
        ctx.fillStyle = open ? '#7dff50' : '#2b7a4b'
        ctx.beginPath()
        ctx.arc(x, y, 1.2, 0, Math.PI * 2)
        ctx.fill()
      } else if (p.kind === 'fire') {
        // огонь (M4 §14.6.1): короткая полоса — оранжевая пока горит,
        // тёмная когда потушена (вода идёт)
        const out = p.open === true
        ctx.strokeStyle = out ? 'rgba(26,35,42,0.9)' : 'rgba(255,106,46,0.95)'
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.moveTo(x - 4, y)
        ctx.lineTo(x + 4, y)
        ctx.stroke()
      } else if (p.kind === 'valve') {
        // водяной клапан (§14.6.1): кольцо с точкой как камера, голубой —
        // «вода»; ярче, когда вода идёт (полосы потушены)
        const open = p.open === true
        const c = open ? 'rgba(95,215,255,0.95)' : 'rgba(95,215,255,0.45)'
        ctx.strokeStyle = c
        ctx.beginPath()
        ctx.arc(x, y, 4, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = c
        ctx.beginPath()
        ctx.arc(x, y, 1.4, 0, Math.PI * 2)
        ctx.fill()
      } else if (p.kind === 'srv') {
        // SRV (§16.5): двойной квадрат-стойка, голубовато-белый
        ctx.fillStyle = 'rgba(230,245,255,0.25)'
        ctx.strokeStyle = 'rgba(230,245,255,0.95)'
        ctx.fillRect(x - 4, y - 5, 8, 10)
        ctx.strokeRect(x - 4.5, y - 5.5, 9, 11)
        ctx.strokeRect(x - 2, y - 3, 4, 6)
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

  /** Кибер-слой (§13.8): зоны видимости СВОИХ камер — под контентом. */
  private drawCyberVisionZones(cyber: MiniCyber): void {
    const ctx = this.ctx
    for (const d of cyber.devices) {
      if (d.kind !== 'camera' || d.owner === null || d.owner !== cyber.myId) continue
      const r = CAM_VISION_RADIUS * this.scale
      ctx.fillStyle = CYBER_VISION_FILL
      ctx.beginPath()
      ctx.arc(this.px(d.x), this.pz(d.z), r, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = CYBER_VISION_EDGE
      ctx.lineWidth = 1
      ctx.stroke()
    }
  }

  /** Связи раскрытых устройств (дедуп по паре): кабель сплошной, радио пунктир. */
  private drawCyberLinks(cyber: MiniCyber): void {
    const ctx = this.ctx
    const byId = new Map(cyber.devices.map((d): [string, MiniCyberDev] => [d.id, d]))
    const seen = new Set<string>()
    ctx.lineWidth = 1
    for (const d of cyber.devices) {
      for (const l of d.links) {
        const o = byId.get(l)
        if (o === undefined) continue
        const key = d.id < o.id ? `${d.id}|${o.id}` : `${o.id}|${d.id}`
        if (seen.has(key)) continue
        seen.add(key)
        const wireless = d.kind === 'radio' || o.kind === 'radio'
        ctx.strokeStyle = wireless ? CYBER_WIRELESS : CYBER_WIRE
        ctx.setLineDash(wireless ? [2, 4] : [])
        ctx.beginPath()
        ctx.moveTo(this.px(d.x), this.pz(d.z))
        ctx.lineTo(this.px(o.x), this.pz(o.z))
        ctx.stroke()
      }
    }
    ctx.setLineDash([])
  }

  /** Владение (кольцо цвета команды) + статусы M3 (ореолы как в деке). */
  private drawCyberStatus(cyber: MiniCyber): void {
    const ctx = this.ctx
    for (const d of cyber.devices) {
      const x = this.px(d.x)
      const y = this.pz(d.z)
      if (d.owner !== null) {
        ctx.strokeStyle =
          d.owner === cyber.myId || cyber.teamOf(d.owner) === cyber.ownTeam ? '#ffffff' : '#ff4d5e'
        ctx.lineWidth = d.owner === cyber.myId ? 2.5 : 2
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.arc(x, y, 7, 0, Math.PI * 2)
        ctx.stroke()
      }
      const halo = (r: number, color: string, dash: readonly number[]): void => {
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.setLineDash([...dash])
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.stroke()
      }
      if (d.vulned === true) halo(6, '#ffd237', [])
      if (d.watched === true) halo(10, '#ff9f43', [3, 3])
      // firewall (§13.5): ореол + бейдж «FW», цвет по firewalledBy —
      // свой/союзный голубой, чужой маджента.
      if (d.firewalled === true) {
        const by = d.firewalledBy ?? null
        const own =
          by !== null && (by === cyber.myId || (cyber.teamOf(by) !== null && cyber.teamOf(by) === cyber.ownTeam))
        const color = own ? '#5fd7ff' : '#ff4d5e'
        halo(9, color, [2, 4])
        ctx.fillStyle = color
        ctx.font = '6px monospace'
        ctx.textAlign = 'center'
        ctx.fillText('FW', x, y - 13)
      }
      if (d.antivirused === true) halo(11, '#c792ea', [5, 3])
      ctx.setLineDash([])
    }
  }

  private px(x: number): number {
    return this.offX + x * this.scale
  }

  private pz(z: number): number {
    return this.offY + z * this.scale
  }
}
