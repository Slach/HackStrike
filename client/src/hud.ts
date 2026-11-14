// DOM-overlay HUD (no Babylon GUI): join screen, vitals, topbar, killfeed,
// crosshair, respawn overlay, match-end overlay, minimap shell, debug corner.
// Cyberpunk terminal look: monospace, dark panels, cyan/magenta accents.

import { CLASSES } from './classes'
import type { Cls, NetStats } from './net'

const TEAM_LABEL = ['ЦИАНОВЫЕ', 'МАДЖЕНТОВЫЕ'] as const
const KILLFEED_ROWS = 5
const KILLFEED_FADE_MS = 4000
const END_RESTART_MS = 10000

function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id)
  if (e === null) throw new Error(`hud: missing #${id}`)
  return e as T
}

function buildCards(container: HTMLElement, initial: Cls, onPick: (cls: Cls) => void): void {
  for (const def of CLASSES) {
    const card = document.createElement('div')
    card.className = 'card' + (def.key === initial ? ' selected' : '')
    const name = document.createElement('div')
    name.className = 'card-name'
    name.textContent = def.label
    const weapon = document.createElement('div')
    weapon.className = 'card-weapon'
    weapon.textContent = def.weapon
    const stats = document.createElement('div')
    stats.className = 'card-stats'
    for (const s of [`HP ${def.hp}`, `${def.speed.toFixed(1)} м/с`, `${def.damage} урон`, def.rate]) {
      const span = document.createElement('span')
      span.textContent = s
      stats.append(span)
    }
    const note = document.createElement('div')
    note.className = 'card-note'
    note.textContent = def.note
    card.append(name, weapon, stats, note)
    card.addEventListener('click', () => {
      container.querySelectorAll('.card').forEach((c) => c.classList.remove('selected'))
      card.classList.add('selected')
      onPick(def.key)
    })
    container.append(card)
  }
}

export class Hud {
  onJoin: (name: string, cls: Cls) => void = () => {}
  onRespawn: (cls: Cls) => void = () => {}

  private joinCls: Cls = 'assault'
  private deathCls: Cls = 'assault'
  private mapReady = false
  private respawnAtMs = 0
  private deathActive = false
  private deathReady = false
  private endActive = false
  private endUntilMs = 0
  private onEndDone: (() => void) | null = null

  private readonly el = {
    join: byId('joinScreen'),
    name: byId<HTMLInputElement>('nameInput'),
    invertY: byId<HTMLInputElement>('invertY'),
    deploy: byId<HTMLButtonElement>('deployBtn'),
    joinStatus: byId('joinStatus'),
    joinCards: byId('joinCards'),
    death: byId('deathOverlay'),
    deathTitle: byId('deathTitle'),
    deathCount: byId('deathCount'),
    deathCards: byId('deathCards'),
    respawn: byId<HTMLButtonElement>('respawnBtn'),
    end: byId('endOverlay'),
    endTitle: byId('endTitle'),
    endScore: byId('endScore'),
    endCount: byId('endCount'),
    hpFill: byId('hpfill'),
    hpNum: byId('hpNum'),
    clsLabel: byId('clsLabel'),
    score0: byId('score0'),
    score1: byId('score1'),
    timer: byId('timer'),
    killfeed: byId('killfeed'),
    crosshair: byId('crosshair'),
    hitmarker: byId('hitmarker'),
    dmg: byId('dmg'),
    status: byId('status'),
    tick: byId('tick'),
    players: byId('players'),
    rtt: byId('rtt'),
    snaps: byId('snaps'),
  }

  /** Vertical mouse inversion, persisted across sessions (client-side only). */
  get invertYOn(): boolean {
    return this.el.invertY.checked
  }

  constructor() {
    buildCards(this.el.joinCards, this.joinCls, (c) => (this.joinCls = c))
    buildCards(this.el.deathCards, this.deathCls, (c) => (this.deathCls = c))
    this.el.invertY.checked = localStorage.getItem('hs.invertY') === '1'
    this.el.invertY.addEventListener('change', () => {
      localStorage.setItem('hs.invertY', this.el.invertY.checked ? '1' : '0')
    })
    this.el.name.addEventListener('input', () => this.refreshDeploy())
    this.el.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.deploy()
    })
    this.el.deploy.addEventListener('click', () => this.deploy())
    this.el.respawn.addEventListener('click', () => this.respawnNow())
    // SPACE = respawn hotkey, but only once the countdown is over (and only
    // while the death overlay is up — in-game Space stays the interact key).
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.deathActive && this.deathReady && !this.el.respawn.disabled) {
        e.preventDefault()
        this.respawnNow()
      }
    })
  }

  private respawnNow(): void {
    this.el.respawn.disabled = true // wait for the server to confirm
    this.onRespawn(this.deathCls)
  }

  private deploy(): void {
    const name = this.el.name.value.trim() || 'hack'
    this.onJoin(name, this.joinCls)
  }

  private refreshDeploy(): void {
    this.el.deploy.disabled = !this.mapReady || this.el.name.value.trim().length === 0
  }

  showJoin(): void {
    this.el.join.classList.remove('hidden')
    if (this.el.name.value === '') {
      this.el.name.value = `hack_${Math.floor(100 + Math.random() * 900)}`
    }
    this.refreshDeploy()
  }

  hideJoin(): void {
    this.el.join.classList.add('hidden')
  }

  setMapStatus(text: string | null): void {
    this.el.joinStatus.textContent = text ?? ''
    this.mapReady = text === null
    this.refreshDeploy()
  }

  setVitals(hp: number, maxHp: number, clsLabel: string): void {
    const pct = Math.max(0, Math.min(100, (hp / Math.max(1, maxHp)) * 100))
    this.el.hpFill.style.width = `${pct}%`
    this.el.hpFill.classList.toggle('low', hp <= 30)
    this.el.hpNum.textContent = String(Math.max(0, Math.round(hp)))
    this.el.clsLabel.textContent = clsLabel
  }

  setScores(scores: readonly [number, number], timeLeftSec: number): void {
    this.el.score0.textContent = String(scores[0])
    this.el.score1.textContent = String(scores[1])
    const m = Math.floor(timeLeftSec / 60)
    const s = Math.floor(timeLeftSec % 60)
    this.el.timer.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  crosshairLocked(on: boolean): void {
    this.el.crosshair.classList.toggle('locked', on)
  }

  /** White X burst around the crosshair: my shot landed (from shot events). */
  hitmarker(): void {
    this.el.hitmarker.classList.remove('on')
    void this.el.hitmarker.offsetWidth // restart the CSS animation
    this.el.hitmarker.classList.add('on')
  }

  /** Red vignette: the local player just lost HP (hp dropped in a snapshot). */
  damageFlash(): void {
    this.el.dmg.classList.remove('on')
    void this.el.dmg.offsetWidth
    this.el.dmg.classList.add('on')
  }

  killfeed(killer: string, killerTeam: number, victim: string, victimTeam: number): void {
    const row = document.createElement('div')
    row.className = 'kf'
    const k = document.createElement('span')
    k.className = `t${killerTeam}`
    k.textContent = killer
    const arrow = document.createElement('span')
    arrow.className = 'arrow'
    arrow.textContent = ' ▸ '
    const v = document.createElement('span')
    v.className = `t${victimTeam}`
    v.textContent = victim
    row.append(k, arrow, v)
    this.el.killfeed.prepend(row)
    while (this.el.killfeed.children.length > KILLFEED_ROWS) {
      this.el.killfeed.lastElementChild?.remove()
    }
    window.setTimeout(() => {
      row.classList.add('fade')
      window.setTimeout(() => row.remove(), 700)
    }, KILLFEED_FADE_MS)
  }

  showDeath(killer: string, respawnAtMs: number): void {
    this.deathActive = true
    this.deathReady = false
    this.respawnAtMs = respawnAtMs
    this.el.deathTitle.textContent = `УБИТ ▸ ${killer}`
    this.el.deathCount.textContent = '5'
    this.el.deathCards.classList.add('hidden')
    this.el.respawn.classList.add('hidden')
    this.el.respawn.disabled = false
    this.el.death.classList.remove('hidden')
  }

  hideDeath(): void {
    if (!this.deathActive) return
    this.deathActive = false
    this.el.death.classList.add('hidden')
  }

  showEnd(winner: number, scores: readonly [number, number], onDone: () => void): void {
    this.endActive = true
    this.onEndDone = onDone
    this.endUntilMs = Date.now() + END_RESTART_MS
    this.el.endTitle.textContent =
      winner === 0 || winner === 1 ? `ПОБЕДА — ${TEAM_LABEL[winner]}` : 'НИЧЬЯ'
    this.el.endTitle.className =
      winner === 0 || winner === 1 ? `end-title t${winner}` : 'end-title'
    this.el.endScore.innerHTML = `<span class="t0">${scores[0]}</span> : <span class="t1">${scores[1]}</span>`
    this.el.endCount.textContent = String(END_RESTART_MS / 1000)
    this.el.end.classList.remove('hidden')
  }

  hideEnd(): void {
    if (!this.endActive) return
    this.endActive = false
    this.el.end.classList.add('hidden')
    const done = this.onEndDone
    this.onEndDone = null
    done?.()
  }

  stats(s: NetStats): void {
    const label = { connecting: 'CONNECTING…', open: 'ONLINE', closed: 'OFFLINE' }[s.status]
    this.el.status.textContent = label
    this.el.status.className = `status-${s.status}`
    this.el.tick.textContent = s.tick > 0 ? String(s.tick) : '—'
    this.el.players.textContent = s.players > 0 ? String(s.players) : '—'
    this.el.rtt.textContent = s.rttMs !== null ? `${s.rttMs} ms` : '—'
    this.el.snaps.textContent = s.snapsPerSec > 0 ? String(s.snapsPerSec) : '—'
  }

  /** Per-frame countdowns (death timer on the server clock, end timer local). */
  tick(serverNowMs: number): void {
    if (this.deathActive && !this.deathReady) {
      const remain = Math.max(0, this.respawnAtMs - serverNowMs)
      if (remain > 0) {
        this.el.deathCount.textContent = String(Math.ceil(remain / 1000))
      } else {
        this.deathReady = true
        this.el.deathCount.textContent = 'ГОТОВ'
        this.el.deathCards.classList.remove('hidden')
        this.el.respawn.classList.remove('hidden')
      }
    }
    if (this.endActive) {
      const remain = Math.max(0, this.endUntilMs - Date.now())
      this.el.endCount.textContent = String(Math.ceil(remain / 1000))
      if (remain <= 0) this.hideEnd()
    }
  }
}
