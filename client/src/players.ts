// Snapshot buffering, interpolation and remote-player rendering.
// No client prediction (GDD §9.1): everyone, including the local player, is
// rendered from server snapshots interpolated ~100 ms in the past.

import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import type { Scene } from '@babylonjs/core/scene'
import { CLASS_BY_KEY } from './classes'
import type { SnapPlayer, Snapshot } from './net'

export const EYE_HEIGHT = 1.6
export const PLAYER_HALF_WIDTH = 0.35 // client-side aim gate, slightly forgiving
export const PLAYER_HEIGHT = 1.8
export const TEAM_CSS: readonly [string, string] = ['#37ff9b', '#ff4dd2']

const TAU = Math.PI * 2

export function teamCss(team: number): string {
  return team === 1 ? TEAM_CSS[1] : TEAM_CSS[0]
}

export function teamColor3(team: number): Color3 {
  return team === 1 ? new Color3(1.0, 0.3, 0.82) : new Color3(0.22, 1.0, 0.61)
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TAU
  if (d > Math.PI) d -= TAU
  else if (d < -Math.PI) d += TAU
  return a + d * t
}

export interface InterpPlayer {
  id: number
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  meta: SnapPlayer // freshest known state (team/name/cls/hp/alive)
}

export class SnapshotBuffer {
  private snaps: Snapshot[] = []
  private offsetMs = 0 // server "now" minus client wall clock

  clear(): void {
    this.snaps.length = 0
  }

  push(snap: Snapshot): void {
    const last = this.snaps[this.snaps.length - 1]
    if (last !== undefined && snap.now < last.now) return // out of order
    if (last !== undefined && snap.now === last.now) this.snaps[this.snaps.length - 1] = snap
    else this.snaps.push(snap)
    if (this.snaps.length > 40) this.snaps.shift()
    const sample = snap.now - Date.now()
    this.offsetMs = this.offsetMs === 0 ? sample : this.offsetMs * 0.9 + sample * 0.1
  }

  serverNow(): number {
    return Date.now() + this.offsetMs
  }

  /** Player states interpolated to the given server timestamp. */
  playersAt(timeMs: number): Map<number, InterpPlayer> {
    const out = new Map<number, InterpPlayer>()
    const n = this.snaps.length
    if (n === 0) return out
    let a = this.snaps[0]
    let b = this.snaps[n - 1]
    let t = 1
    if (n >= 2) {
      if (timeMs <= a.now) {
        b = this.snaps[1]
        t = 0
      } else if (timeMs < b.now) {
        for (let i = n - 2; i >= 0; i--) {
          const s = this.snaps[i]
          if (s.now <= timeMs) {
            a = s
            b = this.snaps[i + 1]
            t = (timeMs - s.now) / Math.max(1, b.now - s.now)
            break
          }
        }
      } else {
        a = this.snaps[n - 2]
      }
    }
    for (const p of b.players) {
      const q = a === b ? p : a.players.find((x) => x.id === p.id)
      if (q === undefined) {
        out.set(p.id, { id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, meta: p })
        continue
      }
      out.set(p.id, {
        id: p.id,
        x: q.x + (p.x - q.x) * t,
        y: q.y + (p.y - q.y) * t,
        z: q.z + (p.z - q.z) * t,
        yaw: lerpAngle(q.yaw, p.yaw, t),
        pitch: q.pitch + (p.pitch - q.pitch) * t,
        meta: p,
      })
    }
    return out
  }
}

interface PlayerView {
  body: Mesh
  plate: Mesh
  plateMat: StandardMaterial
  plateTex: DynamicTexture
  lastName: string
  lastTeam: number
  lastHp: number
}

export class PlayerViews {
  private views = new Map<number, PlayerView>()
  private bodyMats: readonly [StandardMaterial, StandardMaterial]

  constructor(private scene: Scene) {
    const make = (name: string, color: Color3): StandardMaterial => {
      const m = new StandardMaterial(name, scene)
      m.diffuseColor = color.scale(0.08)
      m.emissiveColor = color.scale(0.75)
      m.specularColor = Color3.Black()
      return m
    }
    this.bodyMats = [make('mat.team0', teamColor3(0)), make('mat.team1', teamColor3(1))]
  }

  clear(): void {
    for (const [id, view] of this.views) this.disposeView(id, view)
  }

  sync(states: Map<number, InterpPlayer>, myId: number | null): void {
    for (const [id, view] of this.views) {
      if (!states.has(id) || id === myId) this.disposeView(id, view)
    }
    for (const p of states.values()) {
      if (p.id === myId) continue // never render the local player's body
      let v = this.views.get(p.id)
      if (v === undefined) v = this.create(p.id, p.meta)
      v.body.position.set(p.x, p.y + PLAYER_HEIGHT / 2, p.z)
      v.body.rotation.y = p.yaw
      v.body.setEnabled(p.meta.alive)
      v.plate.setEnabled(p.meta.alive)
      v.body.material = this.bodyMats[p.meta.team === 1 ? 1 : 0]
      if (v.lastName !== p.meta.name || v.lastTeam !== p.meta.team || v.lastHp !== p.meta.hp) {
        this.drawPlate(v, p.meta)
      }
    }
  }

  // Name plate: name + HP bar, redrawn only when something changed — hits on
  // a remote player are visible as the bar draining.
  private drawPlate(v: PlayerView, meta: SnapPlayer): void {
    v.lastName = meta.name
    v.lastTeam = meta.team
    v.lastHp = meta.hp
    const maxHp = CLASS_BY_KEY[meta.cls].hp
    const ctx = v.plateTex.getContext() as unknown as CanvasRenderingContext2D
    ctx.clearRect(0, 0, 256, 64)
    ctx.fillStyle = 'rgba(2,12,7,0.72)'
    ctx.fillRect(0, 0, 256, 64)
    ctx.font = 'bold 30px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = teamCss(meta.team)
    ctx.fillText(meta.name, 128, 32)
    const frac = Math.max(0, Math.min(1, meta.hp / maxHp))
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(38, 44, 180, 12)
    ctx.fillStyle = frac > 0.5 ? '#37ff9b' : frac > 0.25 ? '#ffd237' : '#ff4d5e'
    ctx.fillRect(38, 44, 180 * frac, 12)
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.strokeRect(38.5, 44.5, 179, 11)
    v.plateTex.update()
  }

  private create(id: number, meta: SnapPlayer): PlayerView {
    const body = MeshBuilder.CreateBox(
      `p${id}`,
      { width: PLAYER_HALF_WIDTH * 2, height: PLAYER_HEIGHT, depth: PLAYER_HALF_WIDTH * 2 },
      this.scene,
    )
    body.material = this.bodyMats[meta.team === 1 ? 1 : 0]
    body.isPickable = false

    const plate = MeshBuilder.CreatePlane(`p${id}.plate`, { width: 1.8, height: 0.45 }, this.scene)
    plate.parent = body
    plate.position.y = 1.35 // just above the head
    plate.billboardMode = Mesh.BILLBOARDMODE_ALL
    plate.isPickable = false

    const plateTex = new DynamicTexture(`p${id}.tex`, { width: 256, height: 64 }, this.scene)
    plateTex.hasAlpha = true
    const plateMat = new StandardMaterial(`p${id}.mat`, this.scene)
    plateMat.diffuseTexture = plateTex
    plateMat.specularColor = Color3.Black()
    plateMat.useAlphaFromDiffuseTexture = true
    plate.material = plateMat

    const view: PlayerView = { body, plate, plateMat, plateTex, lastName: '', lastTeam: -1, lastHp: -1 }
    this.views.set(id, view)
    return view
  }

  private disposeView(id: number, view: PlayerView): void {
    view.body.dispose() // disposes the parented plate too
    view.plateMat.dispose()
    view.plateTex.dispose()
    this.views.delete(id)
  }
}
