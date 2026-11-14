// M2 cyber props (GDD §12.3 / §12.6): terminals, radio points, switches,
// doors and cables. Geometry is built from the map data (карта — данные),
// live state (door open, cable severed) arrives via snap.props. Collisions
// are server-side — the door swing here is purely cosmetic, and the cables
// are visual only (the knife hitbox lives on the server).

import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Scene } from '@babylonjs/core/scene'
import type { GameMap } from './map'
import type { MiniProp } from './minimap'
import type { PropKind, SnapProp } from './net'

const TERMINAL_RANGE = 2 // м, GDD §12.1
const DEFAULT_RADIO_RANGE = 8
const DOOR_SWING_S = 0.3 // GDD §12.6: ~0.3 с на открытие
const DOOR_DEFAULT_SIZE: readonly [number, number, number] = [1.6, 2.4, 0.16]
const CABLE_SAG = 0.45 // насколько перерубленный кабель провисает (м)

export interface MapProp {
  kind: PropKind
  id: string
  pos: [number, number, number]
  radius: number
  size: [number, number, number]
  axis: 'x' | 'z'
  points: [number, number, number][]
}

const PROP_KINDS: readonly PropKind[] = ['terminal', 'radio', 'switch', 'door', 'cable']

function tuple3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const ok = v.every((n) => typeof n === 'number' && Number.isFinite(n))
  return ok ? [v[0] as number, v[1] as number, v[2] as number] : null
}

/** Tolerant parse of map.props (GDD §12.3); invalid entries are skipped. */
function parseMapProps(raw: readonly unknown[]): MapProp[] {
  const out: MapProp[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : null
    const kind = PROP_KINDS.includes(r.kind as PropKind) ? (r.kind as PropKind) : null
    const pos = tuple3(r.pos)
    if (id === null || kind === null || pos === null) continue
    out.push({
      kind,
      id,
      pos,
      radius: typeof r.radius === 'number' && r.radius > 0 ? r.radius : DEFAULT_RADIO_RANGE,
      size: tuple3(r.size) ?? [...DOOR_DEFAULT_SIZE],
      axis: r.axis === 'z' ? 'z' : 'x',
      points: Array.isArray(r.points)
        ? r.points.flatMap((p): [number, number, number][] => {
            const t = tuple3(p)
            return t !== null ? [t] : []
          })
        : [],
    })
  }
  return out
}

interface SimpleProp {
  id: string
  x: number
  z: number
  radius: number
}

interface DoorView {
  id: string
  pivot: TransformNode
  x: number
  z: number
  axis: 'x' | 'z'
  len: number
  open: boolean
  angle: number // текущий угол поворота (рад)
}

interface CableView {
  id: string
  path: Vector3[]
  mesh: Mesh | null
  severed: boolean
}

/** Перерубленный кабель провисает: просадка параболой, концы на месте. */
function droopPath(points: readonly Vector3[]): Vector3[] {
  if (points.length === 2) {
    const [a, b] = points
    return [
      a.clone(),
      new Vector3((a.x + b.x) / 2, Math.min(a.y, b.y) - CABLE_SAG, (a.z + b.z) / 2),
      b.clone(),
    ]
  }
  return points.map((p, i) => {
    const t = i / (points.length - 1)
    return new Vector3(p.x, p.y - CABLE_SAG * 4 * t * (1 - t), p.z)
  })
}

export class PropsView {
  private readonly terminals = new Map<string, SimpleProp>()
  private readonly radios = new Map<string, SimpleProp>()
  private readonly switches = new Map<string, SimpleProp>()
  private readonly doors = new Map<string, DoorView>()
  private readonly cables = new Map<string, CableView>()
  private readonly mats: Record<string, StandardMaterial>
  private miniCache: MiniProp[] = []

  private constructor(private scene: Scene) {
    const mk = (name: string, diffuse: [number, number, number], emissive: [number, number, number]): StandardMaterial => {
      const m = new StandardMaterial(`mat.prop.${name}`, scene)
      m.diffuseColor = new Color3(...diffuse)
      m.emissiveColor = new Color3(...emissive)
      m.specularColor = Color3.Black()
      return m
    }
    const glow = (name: string, c: [number, number, number]): StandardMaterial => {
      const m = new StandardMaterial(`mat.prop.${name}`, scene)
      m.emissiveColor = new Color3(...c)
      m.disableLighting = true
      return m
    }
    this.mats = {
      body: mk('body', [0.03, 0.05, 0.04], [0.008, 0.02, 0.014]),
      screen: glow('screen', [0.05, 0.8, 0.38]),
      door: mk('door', [0.04, 0.07, 0.055], [0.01, 0.03, 0.02]),
      antenna: glow('antenna', [0.2, 0.9, 0.5]),
      led: glow('led', [0.15, 0.75, 0.42]),
      cable: mk('cable', [0.05, 0.13, 0.09], [0.02, 0.09, 0.05]),
      cableDead: mk('cableDead', [0.07, 0.07, 0.07], [0.012, 0.014, 0.012]),
      sphere: glow('sphere', [0.04, 0.3, 0.16]),
    }
    this.mats.sphere.alpha = 0.06 // тусклая сфера радиуса радио-точки, видна всем
  }

  static build(scene: Scene, map: GameMap): PropsView {
    const view = new PropsView(scene)
    for (const prop of parseMapProps(map.props)) {
      switch (prop.kind) {
        case 'terminal':
          view.buildTerminal(prop.id, prop.pos)
          break
        case 'radio':
          view.buildRadio(prop.id, prop.pos, prop.radius)
          break
        case 'switch':
          view.buildSwitch(prop.id, prop.pos)
          break
        case 'door':
          view.buildDoor(prop.id, prop.pos, prop.axis, prop.size)
          break
        case 'cable':
          view.buildCable(prop.id, prop.points)
          break
      }
    }
    view.rebuildMini()
    return view
  }

  private buildTerminal(id: string, pos: readonly [number, number, number]): void {
    const body = MeshBuilder.CreateBox(`prop.${id}`, { width: 0.55, height: 1.05, depth: 0.42 }, this.scene)
    body.position.set(pos[0], pos[1] + 0.525, pos[2])
    body.material = this.mats.body
    body.isPickable = false
    const screen = MeshBuilder.CreatePlane(
      `prop.${id}.screen`,
      { width: 0.46, height: 0.34, sideOrientation: Mesh.DOUBLESIDE },
      this.scene,
    )
    screen.position.set(pos[0], pos[1] + 1.16, pos[2])
    screen.rotation.x = -0.16
    screen.material = this.mats.screen
    screen.isPickable = false
    this.terminals.set(id, { id, x: pos[0], z: pos[2], radius: 0 })
  }

  private buildRadio(id: string, pos: readonly [number, number, number], radius: number): void {
    const mast = MeshBuilder.CreateCylinder(`prop.${id}.mast`, { diameter: 0.12, height: 1.5 }, this.scene)
    mast.position.set(pos[0], pos[1] + 0.75, pos[2])
    mast.material = this.mats.body
    mast.isPickable = false
    const head = MeshBuilder.CreateBox(`prop.${id}.head`, { width: 0.34, height: 0.22, depth: 0.34 }, this.scene)
    head.position.set(pos[0], pos[1] + 1.56, pos[2])
    head.material = this.mats.body
    head.isPickable = false
    const antenna = MeshBuilder.CreateCylinder(`prop.${id}.ant`, { diameter: 0.035, height: 0.9 }, this.scene)
    antenna.position.set(pos[0], pos[1] + 2.1, pos[2])
    antenna.material = this.mats.antenna
    antenna.isPickable = false
    const sphere = MeshBuilder.CreateSphere(`prop.${id}.sphere`, { diameter: radius * 2, segments: 12 }, this.scene)
    sphere.position.set(pos[0], pos[1] + 1, pos[2])
    sphere.material = this.mats.sphere
    sphere.isPickable = false
    this.radios.set(id, { id, x: pos[0], z: pos[2], radius })
  }

  private buildSwitch(id: string, pos: readonly [number, number, number]): void {
    const cab = MeshBuilder.CreateBox(`prop.${id}`, { width: 0.5, height: 0.85, depth: 0.28 }, this.scene)
    cab.position.set(pos[0], pos[1] + 0.425, pos[2])
    cab.material = this.mats.body
    cab.isPickable = false
    const led = MeshBuilder.CreateBox(`prop.${id}.led`, { width: 0.36, height: 0.05, depth: 0.2 }, this.scene)
    led.position.set(pos[0], pos[1] + 0.88, pos[2])
    led.material = this.mats.led
    led.isPickable = false
    this.switches.set(id, { id, x: pos[0], z: pos[2], radius: 0 })
  }

  private buildDoor(id: string, pos: readonly [number, number, number], axis: 'x' | 'z', size: readonly [number, number, number]): void {
    const [w, h, depth] = size
    const pivot = new TransformNode(`prop.${id}.pivot`, this.scene)
    // Петля — край полотна вдоль оси ширины; pos считаем центром двери.
    if (axis === 'x') pivot.position.set(pos[0] - w / 2, pos[1], pos[2])
    else pivot.position.set(pos[0], pos[1], pos[2] - w / 2)
    const panel = MeshBuilder.CreateBox(
      `prop.${id}`,
      axis === 'x' ? { width: w, height: h, depth } : { width: depth, height: h, depth: w },
      this.scene,
    )
    panel.parent = pivot
    if (axis === 'x') panel.position.set(w / 2, h / 2, 0)
    else panel.position.set(0, h / 2, w / 2)
    panel.material = this.mats.door
    panel.isPickable = false
    panel.enableEdgesRendering(0.95)
    panel.edgesWidth = 2.2
    panel.edgesColor = new Color4(0.22, 1.0, 0.6, 0.7)
    this.doors.set(id, { id, pivot, x: pos[0], z: pos[2], axis, len: w, open: false, angle: 0 })
  }

  private buildCable(id: string, points: readonly [number, number, number][]): void {
    if (points.length < 2) return
    const cable: CableView = { id, path: points.map((p) => new Vector3(...p)), mesh: null, severed: false }
    this.cables.set(id, cable)
    this.rebuildCable(cable)
  }

  private rebuildCable(cable: CableView): void {
    cable.mesh?.dispose()
    const path = cable.severed ? droopPath(cable.path) : cable.path
    cable.mesh = MeshBuilder.CreateTube(`prop.${cable.id}`, { path, radius: 0.045 }, this.scene)
    cable.mesh.material = cable.severed ? this.mats.cableDead : this.mats.cable
    cable.mesh.isPickable = false
  }

  /** Live state from snap.props (id → state); unknown ids with positions are
   *  created on the fly so a server-side map update still shows up. */
  updateFromSnap(props: readonly SnapProp[]): void {
    let dirty = false
    for (const p of props) {
      switch (p.kind) {
        case 'door': {
          const door = this.doors.get(p.id)
          if (door !== undefined) {
            if (p.open !== undefined && door.open !== p.open) {
              door.open = p.open
              dirty = true
            }
          } else if (p.x !== undefined && p.y !== undefined && p.z !== undefined) {
            this.buildDoor(p.id, [p.x, p.y, p.z], 'x', [...DOOR_DEFAULT_SIZE])
            dirty = true
          }
          break
        }
        case 'cable': {
          const cable = this.cables.get(p.id)
          if (cable !== undefined && p.severed !== undefined && cable.severed !== p.severed) {
            cable.severed = p.severed
            this.rebuildCable(cable)
          }
          break
        }
        case 'terminal':
        case 'radio':
        case 'switch': {
          if (p.x === undefined || p.y === undefined || p.z === undefined) break
          if (this.known(p.id)) break
          if (p.kind === 'terminal') this.buildTerminal(p.id, [p.x, p.y, p.z])
          else if (p.kind === 'radio') this.buildRadio(p.id, [p.x, p.y, p.z], p.radius ?? DEFAULT_RADIO_RANGE)
          else this.buildSwitch(p.id, [p.x, p.y, p.z])
          dirty = true
          break
        }
      }
    }
    if (dirty) this.rebuildMini()
  }

  /** Анимация дверей: доворот к целевому углу, ~0.3 с на 90°. */
  tick(dtSec: number): void {
    if (this.doors.size === 0) return
    const step = (Math.PI / 2) * Math.min(1, dtSec / DOOR_SWING_S)
    for (const d of this.doors.values()) {
      const target = d.open ? Math.PI / 2 : 0
      const delta = target - d.angle
      if (Math.abs(delta) <= 1e-4) continue
      d.angle += Math.sign(delta) * Math.min(step, Math.abs(delta))
      d.pivot.rotation.y = d.angle
    }
  }

  /** Ближайшая точка джек-ина для хакера (терминал 2 м / радио 8 м, GDD §12.1). */
  nearestJackIn(x: number, z: number): { id: string; kind: 'terminal' | 'radio' } | null {
    let best: { id: string; kind: 'terminal' | 'radio' } | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const t of this.terminals.values()) {
      const d = Math.hypot(t.x - x, t.z - z)
      const score = d / TERMINAL_RANGE
      if (d <= TERMINAL_RANGE && score < bestScore) {
        bestScore = score
        best = { id: t.id, kind: 'terminal' }
      }
    }
    for (const r of this.radios.values()) {
      const d = Math.hypot(r.x - x, r.z - z)
      const score = d / r.radius
      if (d <= r.radius && score < bestScore) {
        bestScore = score
        best = { id: r.id, kind: 'radio' }
      }
    }
    return best
  }

  hostKind(id: string): PropKind | null {
    if (this.terminals.has(id)) return 'terminal'
    if (this.radios.has(id)) return 'radio'
    if (this.switches.has(id)) return 'switch'
    if (this.doors.has(id)) return 'door'
    return null
  }

  miniProps(): readonly MiniProp[] {
    return this.miniCache
  }

  private known(id: string): boolean {
    return this.terminals.has(id) || this.radios.has(id) || this.switches.has(id) || this.doors.has(id)
  }

  private rebuildMini(): void {
    const out: MiniProp[] = []
    for (const t of this.terminals.values()) out.push({ x: t.x, z: t.z, kind: 'terminal' })
    for (const r of this.radios.values()) out.push({ x: r.x, z: r.z, kind: 'radio' })
    for (const s of this.switches.values()) out.push({ x: s.x, z: s.z, kind: 'switch' })
    for (const d of this.doors.values()) {
      out.push({ x: d.x, z: d.z, kind: 'door', open: d.open, axis: d.axis, len: d.len })
    }
    this.miniCache = out
  }
}
