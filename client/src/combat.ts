// Auto-fire (GDD §3.2, variant B) and shot visuals.
//
// Every frame a ray from the camera is tested against enemy AABBs (only
// enemies in M1); if one is hit with clear LOS, a "fire" intent is sent —
// paced by the client-side weapon tempo (sniper 1.2s, AR 0.125s, minigun
// 0.083s with 0.5s spin-up, pistol 0.33s). The server re-validates tempo
// and applies its own ~2° bullet magnetism; the client never decides hits.

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Scene } from '@babylonjs/core/scene'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh'
import { CLASS_BY_KEY } from './classes'
import type { Cls } from './net'
import { rayAABB, type MapWorld } from './map'
import { teamColor3 } from './players'

export interface TargetBox {
  min: [number, number, number]
  max: [number, number, number]
}

const MINIGUN_SPINUP = 0.5 // GDD §3.1: first 0.5s of aiming, no shots
const MINIGUN_HOLD = 1.0 // spin-up holds for 1s after losing the target

// Sniper auto-scope (GDD §3.3): zoom x1.5 snaps on the moment an enemy is
// in direct view; the shot is only allowed after the scope has been held
// for 0.1s; zoom drops 1s after the last enemy leaves the view.
const SNIPER_FIRE_DELAY_MS = 100
const SNIPER_HOLD_MS = 1000
const SNIPER_ZOOM = 1.5

export class Scope {
  engaged = false
  /** engaged AND held long enough to allow a shot. */
  armed = false
  private engagedSinceMs = 0
  private lastSeenMs = 0

  constructor(private baseFov: number, private camera: { fov: number }) {}

  reset(): void {
    this.engaged = false
    this.armed = false
    this.engagedSinceMs = 0
    this.lastSeenMs = 0
    this.camera.fov = this.baseFov
  }

  update(nowMs: number, cls: Cls, enemyInFov: boolean): void {
    if (cls !== 'sniper') {
      if (this.engaged || this.camera.fov !== this.baseFov) this.reset()
      return
    }
    if (enemyInFov) this.lastSeenMs = nowMs
    const wasEngaged = this.engaged
    this.engaged = nowMs - this.lastSeenMs <= SNIPER_HOLD_MS
    if (this.engaged && !wasEngaged) this.engagedSinceMs = nowMs
    this.armed = this.engaged && nowMs - this.engagedSinceMs >= SNIPER_FIRE_DELAY_MS
    this.camera.fov = this.engaged ? this.baseFov / SNIPER_ZOOM : this.baseFov
  }
}

export class AutoFire {
  lockedOn = false
  private lastShotAt = Number.NEGATIVE_INFINITY
  private aimStart = 0
  private lastTargetAt = Number.NEGATIVE_INFINITY

  reset(): void {
    this.lockedOn = false
    this.lastShotAt = Number.NEGATIVE_INFINITY
    this.aimStart = 0
    this.lastTargetAt = Number.NEGATIVE_INFINITY
  }

  /** Returns true when a "fire" intent should be sent right now. */
  update(
    now: number,
    cls: Cls,
    origin: Vector3,
    dir: Vector3,
    enemies: readonly TargetBox[],
    world: MapWorld,
    blockers: readonly TargetBox[] = [],
  ): boolean {
    let bestT = Number.POSITIVE_INFINITY
    for (const e of enemies) {
      const t = rayAABB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, e.min, e.max)
      if (t === null || t >= bestT) continue
      // LOS: any collider strictly closer than the enemy blocks the shot.
      if (world.rayHit(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, t - 0.02) !== null) {
        continue
      }
      // Закрытая дверь перед целью — не стреляем (сервер тоже отклонит).
      let doorBlocked = false
      for (const b of blockers) {
        const bt = rayAABB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, b.min, b.max)
        if (bt !== null && bt < t - 0.02) {
          doorBlocked = true
          break
        }
      }
      if (doorBlocked) continue
      bestT = t
    }
    if (!Number.isFinite(bestT)) {
      this.lockedOn = false
      return false
    }
    this.lockedOn = true
    // Track aim continuity: re-acquired after >1s without a target → re-spin.
    if (now - this.lastTargetAt > MINIGUN_HOLD) this.aimStart = now
    this.lastTargetAt = now
    if (cls === 'heavy' && now - this.aimStart < MINIGUN_SPINUP) return false
    if (now - this.lastShotAt < CLASS_BY_KEY[cls].fireInterval) return false
    this.lastShotAt = now
    return true
  }
}

const TRACER_TTL = 0.12
const FLASH_TTL = 0.26

interface TracerFx {
  mesh: LinesMesh
  until: number
  baseAlpha: number
}

interface FlashFx {
  mesh: Mesh
  until: number
}

export class Effects {
  private tracers: TracerFx[] = []
  private flashes: FlashFx[] = []
  private flashMats: readonly [StandardMaterial, StandardMaterial]

  constructor(private scene: Scene) {
    const make = (name: string, color: Color3): StandardMaterial => {
      const m = new StandardMaterial(name, scene)
      m.emissiveColor = color
      m.disableLighting = true
      return m
    }
    this.flashMats = [make('mat.flash0', teamColor3(0)), make('mat.flash1', teamColor3(1))]
  }

  tracer(from: Vector3, to: Vector3, team: number, mine: boolean): void {
    const mesh = MeshBuilder.CreateLineSystem(
      'tracer',
      { lines: [[from.clone(), to.clone()]] },
      this.scene,
    )
    mesh.color = mine ? new Color3(0.85, 1.0, 0.92) : teamColor3(team)
    const baseAlpha = mine ? 1.0 : 0.7
    mesh.alpha = baseAlpha
    mesh.isPickable = false
    this.tracers.push({ mesh, until: performance.now() / 1000 + TRACER_TTL, baseAlpha })
  }

  flash(at: Vector3, team: number): void {
    const mesh = MeshBuilder.CreateSphere('flash', { diameter: 0.5, segments: 6 }, this.scene)
    mesh.position.copyFrom(at)
    mesh.material = this.flashMats[team === 1 ? 1 : 0]
    mesh.isPickable = false
    this.flashes.push({ mesh, until: performance.now() / 1000 + FLASH_TTL })
  }

  update(now: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const fx = this.tracers[i]
      const left = fx.until - now
      if (left <= 0) {
        fx.mesh.dispose()
        this.tracers.splice(i, 1)
        continue
      }
      fx.mesh.alpha = fx.baseAlpha * (left / TRACER_TTL)
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const fx = this.flashes[i]
      const left = fx.until - now
      if (left <= 0) {
        fx.mesh.dispose()
        this.flashes.splice(i, 1)
        continue
      }
      const k = 1 - left / FLASH_TTL
      fx.mesh.visibility = 1 - k * 0.7
      fx.mesh.scaling.setAll(1 + k * 2.4)
    }
  }
}
