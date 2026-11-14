// Wire protocol per GDD §9.2 (M1) + §12.5 (M2 cyber layer), plus the skeleton
// ping/pong probe. All incoming frames are parsed defensively: the socket may
// briefly talk to an older server (whose "snap" has a different shape, e.g.
// without M2 props) and must not crash — unknown/different frames are dropped
// by the parser.

export type Cls = 'sniper' | 'assault' | 'heavy' | 'hacker'

export interface KeysState {
  w: number
  a: number
  s: number
  d: number
  interact: number
}

export type RunProg = 'portscan' | 'vulnscan' | 'trojan' | 'watcher' | 'firewall' // GDD §12.4, §13.1, §13.5

export type ClientMessage =
  | { t: 'join'; name: string; cls: Cls; team: number } // team: -1 авто | 0 | 1
  | { t: 'input'; seq: number; keys: KeysState; yaw: number; pitch: number }
  | { t: 'fire'; yaw: number; pitch: number }
  | { t: 'respawn'; cls: Cls }
  | { t: 'ping'; c: number }
  // M2 (GDD §12.5). Jack-in rides on input.keys.interact — nothing separate.
  | { t: 'jackout' }
  | { t: 'run'; prog: RunProg; dev?: string }
  | { t: 'ctrl'; dev: string; action: 'toggle' }

export type PropKind = 'terminal' | 'radio' | 'switch' | 'door' | 'cable'

/** Live prop state from snap.props (GDD §12.5); fields are only present when
 *  the server sent them, so an absent "open" means "keep the last
 *  known value" on the consumer side. */
export interface SnapProp {
  id: string
  kind: PropKind
  x?: number
  y?: number
  z?: number
  open?: boolean // door
  radius?: number // radio
}

/** Device discovered by portscan (GDD §12.5 "scan"). */
export interface ScanDevice {
  id: string
  kind: PropKind
  x: number
  y: number
  z: number
  owner: number | null // playerId of the last hacker to trojan it
  links: string[] // ids of adjacent devices
  vulned?: boolean // my vulnscan found an exploit here (omitted when false)
  watched?: boolean // my watcher trigger sits on this device (M3, omitted when false)
  firewalled?: boolean // someone's firewall sits on this device (M3 §13.5, visible to everyone who scanned it)
}

export interface DeckProg {
  id: number
  prog: string
  dev: string | null
  etaMs: number
}

export interface DeckInfo {
  cpu: number
  npu: number
  ram: number // slots
  net: number // Mbps of the jack-in point
}

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
  /** Хакер стоит в деке (M2): тело уязвимо; snap-флаг для самоисцеления десинка. */
  jacked: boolean
}

export interface Snapshot {
  tick: number
  now: number
  players: SnapPlayer[]
  scores: [number, number]
  timeLeft: number
  props: readonly SnapProp[] // M2; empty for pre-M2 servers
}

export type ServerMessage =
  | { t: 'welcome'; id: number; team: number; tick: number }
  | { t: 'team'; team: number } // server rebalanced me to the other team
  | ({ t: 'snap' } & Snapshot)
  | { t: 'shot'; by: number; hit: number; from: Vec3; to: Vec3 }
  | { t: 'death'; by: number; respawnAt: number }
  | { t: 'matchend'; winner: number; scores: [number, number] }
  | { t: 'pong'; c: number; s: number; tick: number }
  // M2 (GDD §12.5)
  | { t: 'jackin'; host: string; deck: DeckInfo }
  | { t: 'deck'; cpuLoad: number; npuLoad: number; ramUsed: number; netLoad: number; progs: DeckProg[] } // ~2 Hz, only while jacked in
  | { t: 'scan'; devices: ScanDevice[] }
  | { t: 'denied'; reason: string }
  // M3 (GDD §13.2): trigger fired for me — src tells watcher (enemy jacked
  // into my watched device) from firewall (enemy jack-in attempt blocked).
  | { t: 'alert'; dev: string; who: number; src?: string }

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
const PROP_KINDS: readonly PropKind[] = ['terminal', 'radio', 'switch', 'door', 'cable']

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
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
    jacked: p.jacked === true,
  }
}

function parseProp(v: unknown): SnapProp | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  const id = str(p.id)
  const kind = PROP_KINDS.includes(p.kind as PropKind) ? (p.kind as PropKind) : null
  if (id === null || kind === null) return null
  const prop: SnapProp = { id, kind }
  const x = num(p.x, Number.NaN)
  const y = num(p.y, Number.NaN)
  const z = num(p.z, Number.NaN)
  if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
    prop.x = x
    prop.y = y
    prop.z = z
  }
  if (typeof p.open === 'boolean') prop.open = p.open
  const radius = num(p.radius, Number.NaN)
  if (Number.isFinite(radius) && radius > 0) prop.radius = radius
  return prop
}

function parseDevice(v: unknown): ScanDevice | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  const id = str(p.id)
  const kind = PROP_KINDS.includes(p.kind as PropKind) ? (p.kind as PropKind) : null
  if (id === null || kind === null) return null
  return {
    id,
    kind,
    x: num(p.x, 0),
    y: num(p.y, 0),
    z: num(p.z, 0),
    owner: typeof p.owner === 'number' && Number.isFinite(p.owner) ? p.owner : null,
    links: Array.isArray(p.links) ? p.links.filter((l): l is string => typeof l === 'string') : [],
    vulned: p.vulned === true,
    watched: p.watched === true,
    firewalled: p.firewalled === true,
  }
}

function parseDeckProg(v: unknown): DeckProg | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  const prog = str(p.prog)
  if (prog === null) return null
  return {
    id: num(p.id, 0),
    prog,
    dev: str(p.dev),
    etaMs: Math.max(0, num(p.etaMs, 0)),
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
      // M2 props are optional: pre-M2 snapshots without them stay valid.
      const props: SnapProp[] = []
      if (Array.isArray(m.props)) {
        for (const p of m.props) {
          const parsed = parseProp(p)
          if (parsed !== null) props.push(parsed)
        }
      }
      return {
        t: 'snap',
        tick: num(m.tick, 0),
        now: num(m.now, Date.now()),
        players,
        scores,
        timeLeft: Math.max(0, num(m.timeLeft, 0)),
        props,
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
    case 'jackin': {
      const host = str(m.host)
      const d = typeof m.deck === 'object' && m.deck !== null ? (m.deck as Record<string, unknown>) : {}
      return {
        t: 'jackin',
        host: host ?? '',
        deck: { cpu: num(d.cpu, 0), npu: num(d.npu, 0), ram: num(d.ram, 0), net: num(d.net, 0) },
      }
    }
    case 'deck': {
      const progs: DeckProg[] = []
      if (Array.isArray(m.progs)) {
        for (const p of m.progs) {
          const parsed = parseDeckProg(p)
          if (parsed !== null) progs.push(parsed)
        }
      }
      return {
        t: 'deck',
        cpuLoad: num(m.cpuLoad, 0),
        npuLoad: num(m.npuLoad, 0),
        ramUsed: num(m.ramUsed, 0),
        netLoad: num(m.netLoad, 0),
        progs,
      }
    }
    case 'scan': {
      if (!Array.isArray(m.devices)) return null
      const devices: ScanDevice[] = []
      for (const d of m.devices) {
        const parsed = parseDevice(d)
        if (parsed !== null) devices.push(parsed)
      }
      return { t: 'scan', devices }
    }
    case 'denied':
      return { t: 'denied', reason: str(m.reason) ?? 'unknown' }
    case 'alert': {
      const dev = str(m.dev)
      if (dev === null) return null
      const src = str(m.src)
      return { t: 'alert', dev, who: num(m.who, -1), src: src === null ? undefined : src }
    }
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

  // M2 cyber-layer intents (GDD §12.5); the server re-validates everything.
  sendJackout(): void {
    this.send({ t: 'jackout' })
  }

  sendRun(prog: RunProg, dev?: string): void {
    this.send(dev !== undefined ? { t: 'run', prog, dev } : { t: 'run', prog })
  }

  sendCtrl(dev: string, action: 'toggle'): void {
    this.send({ t: 'ctrl', dev, action })
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

  /** Outgoing frame (public: the hacker view sends run/ctrl intents). */
  send(msg: ClientMessage): void {
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
