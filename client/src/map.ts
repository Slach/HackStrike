// Map loading and static geometry. The map is data from the server
// (GET /api/map, GDD §9.2) — the client never hardcodes level geometry.
// Rendering: solid AABB colliders merged into a handful of meshes (floors /
// walls / stairs), a single line-system for the neon grid on walkable tops,
// edge rendering for highlighted wall rims. Cheap materials, ~4 draw calls.

import '@babylonjs/core/Rendering/edgesRenderer'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Scene } from '@babylonjs/core/scene'

export type ColliderKind = 'floor' | 'wall' | 'stair'

export interface Collider {
  min: [number, number, number]
  max: [number, number, number]
  kind: ColliderKind
}

export interface GameMap {
  name: string
  bounds: [number, number, number]
  colliders: Collider[]
  spawns: Record<string, [number, number, number][]>
  props: unknown[]
}

// Top-down rectangle of a collider for the minimap.
export interface WallRect {
  x0: number
  z0: number
  x1: number
  z1: number
  stair: boolean
  /** Нижняя граница по y — миникарта фильтрует по этажу игрока (§13.8). */
  y0: number
}

function tuple3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const ok = v.every((n) => typeof n === 'number' && Number.isFinite(n))
  return ok ? [v[0] as number, v[1] as number, v[2] as number] : null
}

const KINDS: readonly ColliderKind[] = ['floor', 'wall', 'stair']

function validateMap(data: unknown): GameMap {
  if (typeof data !== 'object' || data === null) throw new Error('map: not an object')
  const m = data as Record<string, unknown>
  const colliders: Collider[] = []
  if (Array.isArray(m.colliders)) {
    for (const c of m.colliders) {
      if (typeof c !== 'object' || c === null) continue
      const rec = c as Record<string, unknown>
      const min = tuple3(rec.min)
      const max = tuple3(rec.max)
      if (min === null || max === null) continue
      const kind = KINDS.includes(rec.kind as ColliderKind) ? (rec.kind as ColliderKind) : 'wall'
      colliders.push({ min, max, kind })
    }
  }
  if (colliders.length === 0) throw new Error('map: no valid colliders')
  const spawns: GameMap['spawns'] = {}
  if (typeof m.spawns === 'object' && m.spawns !== null) {
    for (const [team, pts] of Object.entries(m.spawns as Record<string, unknown>)) {
      if (!Array.isArray(pts)) continue
      spawns[team] = pts.flatMap((p): [number, number, number][] => {
        const t = tuple3(p)
        return t !== null ? [t] : []
      })
    }
  }
  return {
    name: typeof m.name === 'string' && m.name.length > 0 ? m.name : 'unknown',
    bounds: tuple3(m.bounds) ?? [64, 16, 64],
    colliders,
    spawns,
    props: Array.isArray(m.props) ? m.props : [],
  }
}

async function fetchOnce(): Promise<GameMap> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch('/api/map', { signal: ctrl.signal })
    if (!res.ok) throw new Error(`map: HTTP ${res.status}`)
    return validateMap(await res.json())
  } finally {
    window.clearTimeout(timer)
  }
}

// Retries forever with a pause: the M1 server (and its /api/map endpoint)
// may not be up yet when the page loads.
export async function fetchMap(onRetry: (attempt: number) => void): Promise<GameMap> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchOnce()
    } catch {
      onRetry(attempt)
      await new Promise((resolve) => window.setTimeout(resolve, 2500))
    }
  }
}

export class MapWorld {
  readonly bounds: [number, number, number]
  readonly colliders: readonly Collider[]
  readonly wallRects: readonly WallRect[]
  /** Центры зон сдачи (§16.6): средняя точка спавнов команды — цель
   *  целеуказателя у несущего PHYSAFE. */
  readonly bases: readonly { x: number; z: number }[]

  private constructor(
    bounds: [number, number, number],
    colliders: readonly Collider[],
    wallRects: readonly WallRect[],
    bases: readonly { x: number; z: number }[],
  ) {
    this.bounds = bounds
    this.colliders = colliders
    this.wallRects = wallRects
    this.bases = bases
  }

  /** Зона сдачи команды (0/1) — центр спавнов; null — спавнов нет. */
  baseOf(team: number): { x: number; z: number } | null {
    return this.bases[team] ?? null
  }

  static build(scene: Scene, map: GameMap): MapWorld {
    const floors: Mesh[] = []
    const stairs: Mesh[] = []
    const walls: Mesh[] = []
    const grid: Vector3[][] = []

    for (const c of map.colliders) {
      const sx = c.max[0] - c.min[0]
      const sy = c.max[1] - c.min[1]
      const sz = c.max[2] - c.min[2]
      if (sx <= 0 || sy <= 0 || sz <= 0) continue
      const box = MeshBuilder.CreateBox('col', { width: sx, height: sy, depth: sz }, scene)
      box.position.set(c.min[0] + sx / 2, c.min[1] + sy / 2, c.min[2] + sz / 2)
      box.isPickable = false
      if (c.kind === 'wall') {
        walls.push(box)
        continue
      }
      if (c.kind === 'stair') stairs.push(box)
      else floors.push(box)

      // Neon grid over every walkable top (floors and stairs alike).
      const y = c.max[1] + 0.02
      const x0 = c.min[0]
      const x1 = c.max[0]
      const z0 = c.min[2]
      const z1 = c.max[2]
      grid.push(
        [new Vector3(x0, y, z0), new Vector3(x1, y, z0)],
        [new Vector3(x0, y, z1), new Vector3(x1, y, z1)],
        [new Vector3(x0, y, z0), new Vector3(x0, y, z1)],
        [new Vector3(x1, y, z0), new Vector3(x1, y, z1)],
      )
      for (let gx = Math.floor(x0) + 1; gx < x1; gx++) {
        grid.push([new Vector3(gx, y, z0), new Vector3(gx, y, z1)])
      }
      for (let gz = Math.floor(z0) + 1; gz < z1; gz++) {
        grid.push([new Vector3(x0, y, gz), new Vector3(x1, y, gz)])
      }
    }

    const solid = (
      list: Mesh[],
      name: string,
      diffuse: [number, number, number],
      emissive: [number, number, number],
      edgesWidth: number,
      edgesAlpha: number,
    ): void => {
      if (list.length === 0) return
      const merged = Mesh.MergeMeshes(list, true, true, undefined, false, false)
      if (merged === null) return
      merged.name = name
      merged.isPickable = false
      merged.freezeWorldMatrix()
      const material = new StandardMaterial(`mat.${name}`, scene)
      material.diffuseColor = new Color3(...diffuse)
      material.emissiveColor = new Color3(...emissive)
      material.specularColor = Color3.Black()
      material.freeze()
      merged.material = material
      if (edgesWidth > 0) {
        merged.enableEdgesRendering(0.95)
        merged.edgesWidth = edgesWidth
        merged.edgesColor = new Color4(0.22, 1.0, 0.6, edgesAlpha)
      }
    }

    solid(floors, 'floors', [0.012, 0.028, 0.02], [0.004, 0.014, 0.009], 0, 0)
    solid(stairs, 'stairs', [0.03, 0.05, 0.038], [0.008, 0.02, 0.014], 1.4, 0.35)
    solid(walls, 'walls', [0.016, 0.032, 0.026], [0.002, 0.007, 0.005], 2.4, 0.6)

    if (grid.length > 0) {
      const lines = MeshBuilder.CreateLineSystem('map.grid', { lines: grid }, scene)
      lines.color = new Color3(0.12, 0.95, 0.5)
      lines.alpha = 0.55
      lines.isPickable = false
    }

    const wallRects: WallRect[] = []
    for (const c of map.colliders) {
      if (c.kind === 'floor') continue
      wallRects.push({
        x0: c.min[0],
        z0: c.min[2],
        x1: c.max[0],
        z1: c.max[2],
        stair: c.kind === 'stair',
        y0: c.min[1],
      })
    }
    const bases: { x: number; z: number }[] = []
    for (const key of ['0', '1']) {
      const pts = map.spawns[key] ?? []
      if (pts.length === 0) {
        bases.push({ x: 0, z: 0 })
        continue
      }
      let bx = 0
      let bz = 0
      for (const p of pts) {
        bx += p[0]
        bz += p[2]
      }
      bases.push({ x: bx / pts.length, z: bz / pts.length })
    }
    return new MapWorld(map.bounds, map.colliders, wallRects, bases)
  }

  /** Nearest collider hit along the ray, or null if nothing within maxDist. */
  rayHit(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
  ): number | null {
    let best: number | null = null
    for (const c of this.colliders) {
      const t = rayAABB(ox, oy, oz, dx, dy, dz, c.min, c.max)
      if (t !== null && t <= maxDist && (best === null || t < best)) best = t
    }
    return best
  }
}

/** Slab-method ray vs AABB; returns entry distance or null. */
export function rayAABB(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): number | null {
  let tmin = 0
  let tmax = Number.POSITIVE_INFINITY
  const o = [ox, oy, oz]
  const d = [dx, dy, dz]
  for (let i = 0; i < 3; i++) {
    const oi = o[i]
    const di = d[i]
    const lo = min[i]
    const hi = max[i]
    if (Math.abs(di) < 1e-9) {
      if (oi < lo || oi > hi) return null
      continue
    }
    let t1 = (lo - oi) / di
    let t2 = (hi - oi) / di
    if (t1 > t2) {
      const tmp = t1
      t1 = t2
      t2 = tmp
    }
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  return tmin
}
