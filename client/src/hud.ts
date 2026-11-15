// DOM-overlay HUD (no Babylon GUI): join screen, vitals, topbar, killfeed,
// crosshair, respawn overlay, match-end overlay, minimap shell, debug corner.
// Cyberpunk terminal look: monospace, dark panels, cyan/magenta accents.

import { CLASSES } from './classes'
import type { Cls, NetStats, SnapPlayer } from './net'
import { IS_TOUCH } from './mobile'
import QRCode from 'qrcode'

const TEAM_LABEL = ['ЦИАНОВЫЕ', 'МАДЖЕНТОВЫЕ'] as const
const KILLFEED_ROWS = 5
const KILLFEED_FADE_MS = 4000
const END_RESTART_MS = 10000

/** Текст приглашения (§15.5): три лозунга владельца — каркас текста
 *  (заголовок → разворот → финал), между ними — только реальные механики.
 *  Один «скопировать» даёт готовое сообщение для мессенджера. */
function inviteText(url: string): string {
  return [
    '⚔ HACKSTRIKE // ХАКНИ ИЛИ УМРИ',
    '',
    'Командный кибер-FPS в браузере. BLACKHAT VS WHITEHAT.',
    '',
    'Хакер коннектится через терминалы и радио-эфир и работает из кибер-деки:',
    'открывает чужие двери, ворует камеры, перетыкает кабели, оставляет',
    'ловушки в сети. Пока он в деке — тело стоит у терминала и беззащитно.',
    '',
    'УБЕЙ ХАКЕРА ИЛИ УМРИ.',
    '',
    'Снайпер ваншотит, автоматчик поливает свинцом, heavy не останавливается.',
    'Жизнь здесь слишком коротка, но интересна — всего 5 секунд до респавна.',
    'Матч на счёт, авторестарт.',
    '',
    'Ничего устанавливать не нужно: открыл ссылку — играешь.',
    `▸ ${url}`,
  ].join('\n')
}

function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id)
  if (e === null) throw new Error(`hud: missing #${id}`)
  return e as T
}

function buildCards(container: HTMLElement, initial: Cls, onPick: (cls: Cls) => void): void {
  for (const def of CLASSES) {
    const card = document.createElement('div')
    card.className = 'card' + (def.key === initial ? ' selected' : '')
    card.dataset.cls = def.key // предвыбор на death-оверлее (§15.5)
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
  onJoin: (name: string, cls: Cls, team: number) => void = () => {}
  onRespawn: (cls: Cls) => void = () => {}
  /** Пользовательский масштаб чувствительности взгляда (§15.5); main вешает
   *  на controls.sensScale. Вызывается при инициализации и на каждый input. */
  onSensScale: (k: number) => void = () => {}

  private joinCls: Cls = 'assault'
  private joinTeam = -1 // -1 = авто-баланс; выбор хранится в localStorage
  private deathCls: Cls = 'assault'
  private mapReady = false
  /** Экран загрузки жив до первого «карта построена» (§15.5). */
  private loadVisible = true
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
    lookSens: byId<HTMLInputElement>('lookSens'),
    lookSensVal: byId('lookSensVal'),
    settingsBtn: byId('settingsBtn'),
    settings: byId('joinSettings'),
    settingsClose: byId('settingsClose'),
    deploy: byId<HTMLButtonElement>('deployBtn'),
    joinStatus: byId('joinStatus'),
    joinCards: byId('joinCards'),
    loading: byId('loadingScreen'),
    loadFill: byId('loadFill'),
    loadStatus: byId('loadStatus'),
    inviteBtn: byId('inviteBtn'),
    invite: byId('joinInvite'),
    inviteQr: byId<HTMLCanvasElement>('inviteQr'),
    inviteUrl: byId('inviteUrl'),
    inviteCopy: byId<HTMLButtonElement>('inviteCopy'),
    inviteClose: byId('inviteClose'),
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
    propLabel: byId('propLabel'),
    weaponTag: byId('weaponTag'),
    roster0: byId('roster0'),
    roster1: byId('roster1'),
    teamSeg: byId('teamSeg'),
    killfeed: byId('killfeed'),
    crosshair: byId('crosshair'),
    scope: byId('scope'),
    hitmarker: byId('hitmarker'),
    dmg: byId('dmg'),
    status: byId('status'),
    tick: byId('tick'),
    players: byId('players'),
    rtt: byId('rtt'),
    snaps: byId('snaps'),
    jackinHint: byId('jackinHint'),
  }

  /** Vertical mouse inversion, persisted across sessions (client-side only). */
  get invertYOn(): boolean {
    return this.el.invertY.checked
  }

  /** Множитель чувствительности взгляда (0.3..4.0, слайдер §15.5). */
  get lookScale(): number {
    return Math.min(4, Math.max(0.3, Number(this.el.lookSens.value) / 100))
  }

  /** Персист + live-применение слайдера (§15.5). В конструкторе колбэк
   *  main.ts ещё не назначен (он ниже по файлу) и sensScale бы молча
   *  остался 1 при загруженной из localStorage сенсе — отсюда повторный
   *  вызов из main после wiring и из deploy() на каждом заходе. */
  reapplySens(): void {
    const saved = Number(localStorage.getItem('hs.lookSens'))
    if (Number.isFinite(saved) && saved >= 30 && saved <= 400) {
      this.el.lookSens.value = String(saved)
    }
    localStorage.setItem('hs.lookSens', this.el.lookSens.value)
    this.el.lookSensVal.textContent = `${this.lookScale.toFixed(1)}×`
    this.onSensScale(this.lookScale)
  }

  constructor() {
    buildCards(this.el.joinCards, this.joinCls, (c) => (this.joinCls = c))
    buildCards(this.el.deathCards, this.deathCls, (c) => (this.deathCls = c))
    this.el.invertY.checked = localStorage.getItem('hs.invertY') === '1'
    this.reapplySens()
    this.el.lookSens.addEventListener('input', () => this.reapplySens())
    // Единый экран настроек (§15.5): кнопка под ДЕПЛОЕМ → модалка; клик по
    // затемнению и ESC закрывают. Одна механика на desktop и touch.
    this.el.settingsBtn.addEventListener('click', () => this.el.settings.classList.remove('hidden'))
    this.el.settingsClose.addEventListener('click', () => this.el.settings.classList.add('hidden'))
    this.el.settings.addEventListener('click', (e) => {
      if (e.target === this.el.settings) this.el.settings.classList.add('hidden')
    })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.el.settings.classList.add('hidden')
        this.el.invite.classList.add('hidden')
      }
    })
    // Приглашение (§15.5): QR + ссылка на текущий origin. URL считаем на
    // момент открытия — стенд может переехать между открытиями (zrok и т.п.).
    this.el.inviteBtn.addEventListener('click', () => {
      const url = `${window.location.origin}${window.location.pathname}`
      this.el.inviteUrl.textContent = url
      QRCode.toCanvas(this.el.inviteQr, url, { width: 180, margin: 1 }).catch((err) => {
        console.warn('hud: qr render failed', err)
      })
      this.el.invite.classList.remove('hidden')
    })
    this.el.inviteClose.addEventListener('click', () => this.el.invite.classList.add('hidden'))
    this.el.invite.addEventListener('click', (e) => {
      if (e.target === this.el.invite) this.el.invite.classList.add('hidden')
    })
    this.el.inviteCopy.addEventListener('click', () => {
      const done = (): void => {
        this.el.inviteCopy.textContent = 'СКОПИРОВАНО ✓'
        window.setTimeout(() => {
          this.el.inviteCopy.textContent = 'СКОПИРОВАТЬ'
        }, 1500)
      }
      const url = this.el.inviteUrl.textContent
      navigator.clipboard
        .writeText(inviteText(url))
        .then(done)
        .catch(() => {
          // Fallback (clipboard API запрещён на http-стендах): выделение —
          // копирование вручную через контекстное меню.
          const range = document.createRange()
          range.selectNodeContents(this.el.inviteUrl)
          const sel = window.getSelection()
          sel?.removeAllRanges()
          sel?.addRange(range)
        })
    })
    for (const btn of this.el.teamSeg.querySelectorAll<HTMLButtonElement>('.segBtn')) {
      if (Number(btn.dataset.team) === Number(localStorage.getItem('hs.team'))) {
        this.joinTeam = Number(btn.dataset.team)
      }
      btn.addEventListener('click', () => {
        this.joinTeam = Number(btn.dataset.team)
        localStorage.setItem('hs.team', String(this.joinTeam))
        for (const b of this.el.teamSeg.querySelectorAll('.segBtn')) b.classList.toggle('on', b === btn)
      })
    }
    this.el.teamSeg
      .querySelectorAll('.segBtn')
      .forEach((b) => b.classList.toggle('on', Number((b as HTMLButtonElement).dataset.team) === this.joinTeam))
    this.el.invertY.addEventListener('change', () => {
      localStorage.setItem('hs.invertY', this.el.invertY.checked ? '1' : '0')
    })
    this.el.name.addEventListener('input', () => this.refreshDeploy())
    this.el.name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.deploy()
    })
    this.el.deploy.addEventListener('click', () => this.deploy())
    // На touch [SPACE]-подсказка в лейбле — шум: кнопка и так тапается (§15.5)
    if (IS_TOUCH) this.el.respawn.textContent = 'РЕСПАУН'
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
    this.reapplySens() // гарантии нет, что wiring уже отработал — применяем на входе (§15.5)
    const name = this.el.name.value.trim() || 'hack'
    localStorage.setItem('hs.name', name) // не генерировать заново при каждом заходе
    this.onJoin(name, this.joinCls, this.joinTeam)
  }

  private refreshDeploy(): void {
    this.el.deploy.disabled = !this.mapReady || this.el.name.value.trim().length === 0
  }

  showJoin(): void {
    this.el.join.classList.remove('hidden')
    if (this.el.name.value === '') {
      // Saved name first (persisted on deploy); fresh hack_XXX only once.
      const saved = localStorage.getItem('hs.name')
      this.el.name.value = saved && saved.trim() ? saved : `hack_${Math.floor(100 + Math.random() * 900)}`
    }
    this.refreshDeploy()
  }

  hideJoin(): void {
    this.el.join.classList.add('hidden')
  }

  /** Стадия загрузки (§15.5): pct 0..100, пока экран не погашен — иначе noop. */
  setLoading(pct: number, text?: string): void {
    if (!this.loadVisible) return
    this.el.loadFill.style.width = `${Math.max(0, Math.min(100, pct))}%`
    if (text !== undefined) this.el.loadStatus.textContent = text
  }

  /** Карта построена, мир готов — гасим загрузку, join уже собран под ней. */
  hideLoading(): void {
    if (!this.loadVisible) return
    this.loadVisible = false
    this.el.loadFill.style.width = '100%'
    this.el.loadStatus.textContent = 'ГОТОВО'
    window.setTimeout(() => this.el.loading.classList.add('gone'), 250)
  }

  setMapStatus(text: string | null): void {
    this.el.joinStatus.textContent = text ?? ''
    this.mapReady = text === null
    // Пока виден экран загрузки, статусы карты дублируем в его прогресс:
    // пользователь смотрит именно туда (§15.5).
    if (this.loadVisible) this.setLoading(text === null ? 80 : 60, text ?? 'ЗАГРУЗКА КАРТЫ…')
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

  private hintText: string | null = null

  /** «SPACE — ДЖЕК-ИН» над прицелом, когда хакер у терминала/радио (M2). */
  jackinHint(text: string | null): void {
    if (this.hintText === text) return // called every frame — dedupe
    this.hintText = text
    if (text === null) {
      this.el.jackinHint.classList.add('hidden')
    } else {
      this.el.jackinHint.textContent = text
      this.el.jackinHint.classList.remove('hidden')
    }
  }

  /** Текущее оружие (хакер: пистолет) — рядом с HP. */
  setWeapon(text: string | null): void {
    const el = this.el.weaponTag
    if (el === null) return
    el.textContent = text ?? ''
  }

  /** Метка пропса под прицелом («SWITCH S1», «ДВЕРЬ D1 — ЗАКРЫТА»). */
  propLabel(text: string | null): void {
    this.el.propLabel.textContent = text ?? ''
  }

  /** Sniper scope overlay (auto-zoom engaged). */
  scope(on: boolean): void {
    this.el.scope.classList.toggle('hidden', !on)
  }

  /** Own team's frags get a solid team-color chip: white on green/magenta. */
  setTeam(team: number): void {
    this.el.score0.classList.toggle('mine', team === 0)
    this.el.score1.classList.toggle('mine', team === 1)
  }

  private rosterSig = ''

  /** Team rosters under each score: names in team colors; own name bold. */
  setRoster(players: readonly SnapPlayer[], myId: number | null): void {
    const sig = players.map((p) => `${p.team}:${p.name}:${p.alive ? 1 : 0}`).join('|')
    if (sig === this.rosterSig) return
    this.rosterSig = sig
    const cols = [this.el.roster0, this.el.roster1]
    for (const col of cols) col.textContent = ''
    for (const team of [0, 1] as const) {
      for (const p of players) {
        if (p.team !== team) continue
        const s = document.createElement('span')
        if (p.id === myId) {
          s.className = 'me'
          s.textContent = `▸ ${p.name}`
        } else {
          s.textContent = p.name
          if (!p.alive) s.classList.add('dead')
        }
        cols[team].append(s)
      }
    }
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
    this.pushKillfeedRow('kf', `t${killerTeam}`, killer, victim, victimTeam)
  }

  /** Смерть от ловушки/среды (M4 §14.2): «ЛОВУШКА» вместо имени — убийства
   *  нет (FF ON, счёт не двигается), строка ядовито-зелёная, жертва — своим. */
  killfeedEnv(victim: string, victimTeam: number): void {
    this.pushKillfeedRow('kf env', 'env', 'ЛОВУШКА', victim, victimTeam, '#7dff50')
  }

  private pushKillfeedRow(
    rowCls: string,
    killerCls: string,
    killer: string,
    victim: string,
    victimTeam: number,
    killerColor?: string,
  ): void {
    const row = document.createElement('div')
    row.className = rowCls
    const k = document.createElement('span')
    k.className = killerCls
    if (killerColor !== undefined) {
      // inline: таблица стилей живёт в index.html (вне src/), а газ без
      // акцентного цвета сливался бы с обычным киллфидом
      k.style.color = killerColor
      k.style.textShadow = '0 0 8px rgba(125, 255, 80, 0.6)'
    }
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

  /** Сработал watcher (M3 §13.3): янтарная строка в киллфиде — хакер не в деке. */
  alert(text: string): void {
    const row = document.createElement('div')
    row.className = 'kf watcher'
    row.textContent = text
    this.el.killfeed.prepend(row)
    while (this.el.killfeed.children.length > KILLFEED_ROWS) {
      this.el.killfeed.lastElementChild?.remove()
    }
    window.setTimeout(() => {
      row.classList.add('fade')
      window.setTimeout(() => row.remove(), 700)
    }, KILLFEED_FADE_MS)
  }

  showDeath(killer: string, respawnAtMs: number, lastCls?: Cls): void {
    // На touch карточки смерти листать некогда (и непонятно, что они решают):
    // предвыбираем текущий класс, иначе молча возрождаешься assault'ом и
    // джек-ин «пропадает» (§15.5). Десктопное поведение не меняем.
    if (IS_TOUCH && lastCls !== undefined) {
      this.deathCls = lastCls
      for (const c of this.el.deathCards.querySelectorAll<HTMLElement>('.card')) {
        c.classList.toggle('selected', c.dataset.cls === lastCls)
      }
    }
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
