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

export type RunProg = 'portscan' | 'vulnscan' | 'trojan' | 'watcher' | 'firewall' | 'antivirus' // GDD §12.4, §13.1, §13.5, §13.6

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

// 'fire' — урон-ландшафт (ГДД §14.6.1, ревизия v1): приезжает только из
// /api/map props, никогда из snap.props и из scan (не сетевое устройство).
// 'valve' — водяной клапан: сетевой кибер-контроллер огня (по образцу газа).
export type PropKind = 'terminal' | 'radio' | 'switch' | 'door' | 'camera' | 'cable' | 'gas' | 'fire' | 'valve'

/** Сетевые устройства — всё, что бывает в scan/деке. Fire вычтен по построению:
 *  он не сканируется и не взламывается (§14.6.1) — управляют огнём через valve. */
export type CyberKind = Exclude<PropKind, 'fire'>

/** Live prop state from snap.props (GDD §12.5); fields are only present when
 *  the server sent them, so an absent "open" means "keep the last
 *  known value" on the consumer side. */
export interface SnapProp {
  id: string
  kind: PropKind
  x?: number
  y?: number
  z?: number
  open?: boolean // door / gas valve (M4 §14.3) / water valve (§14.6.1)
  radius?: number // radio
  owner?: number // camera (M3 §13.7): LED-индикатор владения; отсутствует = нейтральная
}

/** Device discovered by portscan (GDD §12.5 "scan"). */
export interface ScanDevice {
  id: string
  kind: CyberKind // fire здесь быть не может: не сетевое устройство (§14.6.1)
  x: number
  y: number
  z: number
  owner: number | null // playerId of the last hacker to trojan it
  links: string[] // ids of adjacent devices
  vulned?: boolean // my vulnscan found an exploit here (omitted when false)
  watched?: boolean // my watcher trigger sits on this device (M3, omitted when false)
  log?: LogEntry[] // watcher event journal (M3 §13.1 №1; only for MY watched devices)
  firewalled?: boolean // someone's firewall sits on this device (M3 §13.5, visible to everyone who scanned it)
  firewalledBy?: number // firewall owner id (M3 §13.5: whose filter — for the own/ally/enemy badge; sent together with firewalled)
  antivirused?: boolean // someone's antivirus sits on this device (M3 §13.6, visible to everyone who scanned it)
}

/** Запись журнала событий watcher'а (M3 §13.1 №1): тик + что + кто + программа. */
export interface LogEntry {
  tick: number
  ev: string // jackin | install | owner | scanhit
  who: number
  prog?: string // для install/owner: какая программа
}

/** Один «кадр» ленты камеры (M3 §13.7): живой игрок в зоне видимости. */
export interface CamSeen {
  id: number
  name: string
  team: number
  cls: string
  x: number
  y: number
  z: number
}

/** Один джекнутый хакер в радар-срезе watcher'а (M3 §13.1 №3): кто + точка входа. */
export interface RadarWho {
  id: number
  name: string
  team: number
  cls: string
  host: string
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
  | { t: 'envkill'; victim: number; owner: number } // M4 (GDD §14.3): broadcast; owner — trojan-владелец ловушки (0 = нейтрали)
  | { t: 'matchend'; winner: number; scores: [number, number] }
  | { t: 'pong'; c: number; s: number; tick: number }
  // M2 (GDD §12.5)
  | { t: 'jackin'; host: string; deck: DeckInfo }
  | { t: 'deck'; cpuLoad: number; npuLoad: number; ramUsed: number; netLoad: number; progs: DeckProg[] } // ~2 Hz, only while jacked in
  | { t: 'scan'; devices: ScanDevice[] }
  | { t: 'denied'; reason: string }
  // M3 (GDD §13.2): trigger fired for me — src tells watcher (enemy jacked
  // into my watched device) from firewall (enemy portscan hit my filter,
  // one alert per scan run) or antivirus (enemy trojan repelled).
  // ev/prog — контекст события watcher'а (§13.1 №2); relay — дубль союзнику (§13.1 №4).
  | { t: 'alert'; dev: string; who: number; src?: string; ev?: string; prog?: string; relay?: boolean }
  // M3 (GDD §13.7): camera feed — 2 Hz, only to the living trojan owner.
  | { t: 'cam'; dev: string; seen: CamSeen[] }
  // M3 (GDD §13.1 №3): radar sweep — 1 Hz, only to the living watcher owner.
  | { t: 'radar'; dev: string; who: RadarWho[] }

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
// Полный whitelist: map props парсятся через parseMapProps (props.ts);
// fire в snap.props/scan по построению не появляется — parseProp просто
// принимает kind, собственного состояния у него нет (ГДД §14.6.1).
const PROP_KINDS: readonly PropKind[] = ['terminal', 'radio', 'switch', 'door', 'camera', 'cable', 'gas', 'fire', 'valve']

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
  // gas (M4 §14.3) arrives as open:0|1, door as open:true/false — accept both.
  if (typeof p.open === 'boolean') prop.open = p.open
  else if (p.open === 0 || p.open === 1) prop.open = p.open === 1
  const radius = num(p.radius, Number.NaN)
  if (Number.isFinite(radius) && radius > 0) prop.radius = radius
  const owner = num(p.owner, Number.NaN)
  if (Number.isFinite(owner) && owner > 0) prop.owner = owner
  return prop
}

function parseDevice(v: unknown): ScanDevice | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  const id = str(p.id)
  // Fire не сканируется (§14.6.1): урон-ландшафт отсечён и типом, и здесь —
  // scan-протокол его никогда не несёт; valve — обычное устройство.
  const pk = PROP_KINDS.includes(p.kind as PropKind) ? (p.kind as PropKind) : null
  const kind = pk !== null && pk !== 'fire' ? pk : null
  if (id === null || kind === null) return null
  const dev: ScanDevice = {
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
    firewalledBy: typeof p.firewalledBy === 'number' && Number.isFinite(p.firewalledBy) ? p.firewalledBy : undefined,
    antivirused: p.antivirused === true,
  }
  // Журнал событий watcher'а (§13.1 №1): только у watched-устройств, но парсим
  // защитно — пустой/битый массив просто не даём.
  if (Array.isArray(p.log) && p.log.length > 0) {
    const log: LogEntry[] = []
    for (const e of p.log) {
      if (typeof e !== 'object' || e === null) continue
      const r = e as Record<string, unknown>
      const ev = str(r.ev)
      if (ev === null) continue
      const who = num(r.who, Number.NaN)
      if (!Number.isFinite(who)) continue
      const entry: LogEntry = { tick: Math.max(0, num(r.tick, 0)), ev, who }
      const prog = str(r.prog)
      if (prog !== null) entry.prog = prog
      log.push(entry)
    }
    if (log.length > 0) dev.log = log
  }
  return dev
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
    case 'envkill': {
      const victim = num(m.victim, -1)
      if (victim < 0) return null
      return { t: 'envkill', victim, owner: num(m.owner, 0) }
    }
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
      const ev = str(m.ev)
      const prog = str(m.prog)
      return {
        t: 'alert',
        dev,
        who: num(m.who, -1),
        src: src === null ? undefined : src,
        ev: ev === null ? undefined : ev,
        prog: prog === null ? undefined : prog,
        relay: m.relay === true ? true : undefined,
      }
    }
    case 'cam': {
      const dev = str(m.dev)
      if (dev === null) return null
      const seen: CamSeen[] = []
      if (Array.isArray(m.seen)) {
        for (const s of m.seen) {
          if (typeof s !== 'object' || s === null) continue
          const r = s as Record<string, unknown>
          const id = num(r.id, Number.NaN)
          if (!Number.isFinite(id)) continue
          seen.push({
            id,
            name: typeof r.name === 'string' && r.name.length > 0 ? r.name : `p${id}`,
            team: num(r.team, 0) === 1 ? 1 : 0,
            cls: str(r.cls) ?? 'assault',
            x: num(r.x, 0),
            y: num(r.y, 0),
            z: num(r.z, 0),
          })
        }
      }
      return { t: 'cam', dev, seen }
    }
    case 'radar': {
      const dev = str(m.dev)
      if (dev === null) return null
      const who: RadarWho[] = []
      if (Array.isArray(m.who)) {
        for (const s of m.who) {
          if (typeof s !== 'object' || s === null) continue
          const r = s as Record<string, unknown>
          const id = num(r.id, Number.NaN)
          if (!Number.isFinite(id)) continue
          who.push({
            id,
            name: typeof r.name === 'string' && r.name.length > 0 ? r.name : `p${id}`,
            team: num(r.team, 0) === 1 ? 1 : 0,
            cls: str(r.cls) ?? 'hacker',
            host: str(r.host) ?? '',
          })
        }
      }
      return { t: 'radar', dev, who }
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
