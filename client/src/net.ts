// Minimal same-origin WebSocket client with reconnect + latency probe.
// Protocol (JSON): server -> {t:"hello"|"snap"|"pong"}, client -> {t:"ping"}.

export type ServerMessage =
  | { t: 'hello'; id: number; tick: number }
  | { t: 'snap'; tick: number; players: number; now: number }
  | { t: 'pong'; c: number; s: number; tick: number }

export interface NetStats {
  status: 'connecting' | 'open' | 'closed'
  clientId: number | null
  tick: number
  players: number
  rttMs: number | null
  snapsPerSec: number
}

export class GameSocket {
  private ws: WebSocket | null = null
  private reconnectDelayMs = 500
  private pingTimer: number | null = null
  private statsTimer: number | null = null
  private snapCount = 0
  private stats: NetStats = {
    status: 'connecting',
    clientId: null,
    tick: 0,
    players: 0,
    rttMs: null,
    snapsPerSec: 0,
  }

  constructor(private onUpdate: (stats: NetStats) => void) {}

  connect(): void {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    this.ws = new WebSocket(url)
    this.ws.onopen = () => {
      this.reconnectDelayMs = 500
      this.stats.status = 'open'
      this.ping() // first RTT sample right away
      this.pingTimer = window.setInterval(() => this.ping(), 5000)
      this.emit()
    }
    this.ws.onmessage = (ev: MessageEvent) => this.handle(JSON.parse(ev.data as string))
    this.ws.onclose = () => {
      this.stopTimers()
      this.stats.status = 'closed'
      this.stats.snapsPerSec = 0
      this.emit()
      // Backoff and retry: through a flaky tunnel (zrok) this is what keeps
      // the HUD alive instead of a dead page.
      window.setTimeout(() => this.reconnect(), this.reconnectDelayMs)
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 8000)
    }
  }

  private reconnect(): void {
    this.stats.status = 'connecting'
    this.emit()
    this.connect()
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'hello':
        this.stats.clientId = msg.id
        this.stats.tick = msg.tick
        break
      case 'snap':
        this.stats.tick = msg.tick
        this.stats.players = msg.players
        this.snapCount++
        break
      case 'pong':
        this.stats.rttMs = Math.round(performance.now() - msg.c)
        break
    }
    this.emit()
  }

  private ping(): void {
    this.send({ t: 'ping', c: performance.now() })
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
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
    this.onUpdate({ ...this.stats })
  }

  start(): void {
    // Snapshot-rate window: how many server ticks actually arrive per second.
    this.statsTimer = window.setInterval(() => {
      this.stats.snapsPerSec = this.snapCount
      this.snapCount = 0
      this.emit()
    }, 1000)
    this.connect()
  }
}
