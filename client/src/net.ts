// Wire protocol per GDD §9.2 (M1) plus the skeleton ping/pong probe.
// All incoming frames are parsed defensively: the socket may briefly talk to
// an older skeleton server (whose "snap" has a different shape) and must not
// crash — unknown/different frames are dropped by the parser.

export type Cls = 'sniper' | 'assault' | 'heavy' | 'hacker'

export interface KeysState {
  w: number
  a: number
  s: number
  d: number
  interact: number
}

export type ClientMessage =
  | { t: 'join'; name: string; cls: Cls; team: number } // team: -1 авто | 0 | 1
  | { t: 'input'; seq: number; keys: KeysState; yaw: number; pitch: number }
  | { t: 'fire'; yaw: number; pitch: number }
  | { t: 'respawn'; cls: Cls }
  | { t: 'ping'; c: number }

export type Vec3 = [number, number, number]

export interface SnapPlayer {
  id: number
  name: string
  team: number
  cls: Cls
  x: number
  y: number
  z: number
  yaw: number
  pitch: number
  hp: number
  alive: boolean
  safe: boolean
}

export interface Snapshot {
  tick: number
  now: number
  players: SnapPlayer[]
  scores: [number, number]
  timeLeft: number
}

export type ServerMessage =
  | { t: 'welcome'; id: number; team: number; tick: number }
  | { t: 'team'; team: number } // server rebalanced me to the other team
  | ({ t: 'snap' } & Snapshot)
  | { t: 'shot'; by: number; hit: number; from: Vec3; to: Vec3 }
  | { t: 'death'; by: number; respawnAt: number }
  | { t: 'matchend'; winner: number; scores: [number, number] }
  | { t: 'pong'; c: number; s: number; tick: number }

export interface NetStats {
  status: 'connecting' | 'open' | 'closed'
  clientId: number | null
  tick: number
  players: number
  rttMs: number | null
  snapsPerSec: number
}

export interface GameSocketHandlers {
  onStats: (stats: NetStats) => void
  onMessage: (msg: ServerMessage) => void
  onClose: () => void
}

const CLS_KEYS: readonly Cls[] = ['sniper', 'assault', 'heavy', 'hacker']

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

function vec3(v: unknown): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const [a, b, c] = v
  if (typeof a !== 'number' || typeof b !== 'number' || typeof c !== 'number') return null
  return [a, b, c]
}

function scorePair(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const a = num(v[0], Number.NaN)
  const b = num(v[1], Number.NaN)
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null
}

function parsePlayer(v: unknown): SnapPlayer | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  const id = num(p.id, Number.NaN)
  if (!Number.isFinite(id)) return null
  const cls = CLS_KEYS.includes(p.cls as Cls) ? (p.cls as Cls) : 'assault'
  return {
    id,
    name: typeof p.name === 'string' && p.name.length > 0 ? p.name : `p${id}`,
    team: num(p.team, 0) === 1 ? 1 : 0,
    cls,
    x: num(p.x, 0),
    y: num(p.y, 0),
    z: num(p.z, 0),
    yaw: num(p.yaw, 0),
    pitch: num(p.pitch, 0),
    hp: num(p.hp, 0),
    alive: p.alive !== false,
    safe: p.safe === true,
  }
}

export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  switch (m.t) {
    case 'welcome':
      return {
        t: 'welcome',
        id: num(m.id, -1),
        team: num(m.team, 0) === 1 ? 1 : 0,
        tick: num(m.tick, 0),
      }
    case 'team':
      return { t: 'team', team: num(m.team, 0) === 1 ? 1 : 0 }
    case 'snap': {
      // The skeleton server sends "players" as a number — that frame is not
      // an M1 snapshot; ignore it and wait for the real server.
      if (!Array.isArray(m.players)) return null
      const players: SnapPlayer[] = []
      for (const p of m.players) {
        const parsed = parsePlayer(p)
        if (parsed !== null) players.push(parsed)
      }
      const scores = scorePair(m.scores)
      if (scores === null) return null
      return {
        t: 'snap',
        tick: num(m.tick, 0),
        now: num(m.now, Date.now()),
        players,
        scores,
        timeLeft: Math.max(0, num(m.timeLeft, 0)),
      }
    }
    case 'shot': {
      const from = vec3(m.from)
      const to = vec3(m.to)
      if (from === null || to === null) return null
      return { t: 'shot', by: num(m.by, -1), hit: num(m.hit, 0), from, to }
    }
    case 'death':
      return { t: 'death', by: num(m.by, -1), respawnAt: num(m.respawnAt, 0) }
    case 'matchend':
      // Not spelled out in GDD §9.2 yet: accepted minimally, winner -1 = draw.
      return {
        t: 'matchend',
        winner: num(m.winner, -1),
        scores: scorePair(m.scores) ?? [0, 0],
      }
    case 'pong':
      return { t: 'pong', c: num(m.c, 0), s: num(m.s, 0), tick: num(m.tick, 0) }
    default:
      return null
  }
}

export class GameSocket {
  private ws: WebSocket | null = null
  private reconnectDelayMs = 500
  private pingTimer: number | null = null
  private statsTimer: number | null = null
  private snapCount = 0
  private inputSeq = 0
  private joinCreds: { name: string; cls: Cls; team: number } | null = null
  private stats: NetStats = {
    status: 'connecting',
    clientId: null,
    tick: 0,
    players: 0,
    rttMs: null,
    snapsPerSec: 0,
  }

  constructor(private handlers: GameSocketHandlers) {}

  start(): void {
    // Snapshot-rate window: how many server ticks actually arrive per second.
    this.statsTimer = window.setInterval(() => {
      this.stats.snapsPerSec = this.snapCount
      this.snapCount = 0
      this.emit()
    }, 1000)
    this.connect()
  }

  connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    this.ws = new WebSocket(url)
    this.ws.onopen = () => {
      this.reconnectDelayMs = 500
      this.stats.status = 'open'
      this.ping() // first RTT sample right away
      this.pingTimer = window.setInterval(() => this.ping(), 5000)
      // After a reconnect this is a brand-new session on the server side:
      // re-send the stored join so play resumes without the join screen.
      if (this.joinCreds !== null) this.send({ t: 'join', ...this.joinCreds })
      this.emit()
    }
    this.ws.onmessage = (ev: MessageEvent) => {
      let raw: unknown
      try {
        raw = JSON.parse(ev.data as string)
      } catch {
        return // malformed frame: ignore, never crash the loop
      }
      const msg = parseServerMessage(raw)
      if (msg === null) return
      this.trackStats(msg)
      this.handlers.onMessage(msg)
      this.emit()
    }
    this.ws.onclose = () => {
      this.stopTimers()
      this.stats.status = 'closed'
      this.stats.snapsPerSec = 0
      this.emit()
      this.handlers.onClose()
      // Backoff and retry: through a flaky tunnel (zrok) this is what keeps
      // the client alive instead of a dead page.
      window.setTimeout(() => {
        this.stats.status = 'connecting'
        this.emit()
        this.connect()
      }, this.reconnectDelayMs)
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 8000)
    }
  }

  join(name: string, cls: Cls, team: number): void {
    this.joinCreds = { name, cls, team }
    this.inputSeq = 0
    this.send({ t: 'join', name, cls, team })
  }

  sendInput(keys: KeysState, yaw: number, pitch: number): void {
    this.inputSeq++
    this.send({ t: 'input', seq: this.inputSeq, keys, yaw, pitch })
  }

  sendFire(yaw: number, pitch: number): void {
    this.send({ t: 'fire', yaw, pitch })
  }

  sendRespawn(cls: Cls): void {
    this.send({ t: 'respawn', cls })
  }

  private trackStats(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.stats.clientId = msg.id
        this.stats.tick = msg.tick
        break
      case 'snap':
        this.stats.tick = msg.tick
        this.stats.players = msg.players.length
        this.snapCount++
        break
      case 'pong':
        this.stats.rttMs = Math.round(performance.now() - msg.c)
        break
      default:
        break
    }
  }

  private ping(): void {
    this.send({ t: 'ping', c: performance.now() })
  }

  private send(msg: ClientMessage): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private stopTimers(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer)
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer)
    this.pingTimer = null
    this.statsTimer = null
  }

  private emit(): void {
    this.handlers.onStats({ ...this.stats })
  }
}
