package main

// Кибер-слой M2 «Кибер-базис» (ГДД §12): граф сети из пропсов карты,
// устройства (терминалы/радио/switch/двери), джек-ин/джек-аут, программы
// деки с честными очередями, двери как первые CONTROLLERS, нож/пули режут
// кабели. Всё состояние трогает только горутина комнаты (инвариант 2).

import (
	"log"
	"math"
)

// M2-константы (§12.1–§12.4; менять только через ГДД).
const (
	jackTerminalRadius = 2.0 // м: джек-ин у терминала
	jackRadioRadius    = 8.0 // м: радиус радио-точки по умолчанию

	deckCPU = 1.0 // дека хакера (§12.2)
	deckNPU = 0.5
	deckRAM = 4 // слота программ

	portscanWork  = 2.0 // с работы при полной CPU-доле (§12.4)
	vulnscanWork  = 3.0
	trojanWork    = 2.0
	watcherWork   = 1.0 // §13.1: пассивный слушатель — дешевле vulnscan'а
	firewallWork  = 1.5 // §13.5: активный фильтр — дороже watcher'а, дешевле trojan'а
	antivirusWork = 1.5 // §13.6: активная защита — тот же ярус, что firewall

	camVisionRadius = 12.0 // §13.7: зона видимости камеры, м (радиус + LOS)
	camFeedEvery    = tickRate / 2 // лента камеры 2 Гц (§13.7: 0.5–1 с достаточно)
	camBodyHeight   = 0.9          // центр корпуса игрока от ног (цель LOS-луча)

	deckStatusEvery = tickRate / 2 // статус деки 2 Гц (§12.5)

	// progNetMbps — «поток» одной активной программы для графика netLoad
	// (чисто отображение: 10 Мбит/с × N / канал точки входа).
	progNetMbps = 10.0
)

// deviceStats — железо устройств по kind (§12.2).
var deviceStats = map[string]struct {
	cpu, npu, net float64
	ram           int
}{
	"terminal": {cpu: 0.5, npu: 0, net: 100, ram: 2},
	"radio":    {cpu: 0.1, npu: 0, net: 20, ram: 1},
	"switch":   {cpu: 0.2, npu: 0, net: 100, ram: 1},
	"door":     {cpu: 0.2, npu: 0, net: 100, ram: 1},
	"camera":   {cpu: 0.2, npu: 0, net: 100, ram: 1}, // §13.7: сенсор, как switch
}

// device — кибер-устройство (§12.2). Железо неизменно; динамика — owner
// (последний trojan), vulnedBy и open у дверей.
type device struct {
	id      string
	kind    string // terminal|radio|switch|door|camera
	pos     vec3
	radius  float64 // радио
	cpu     float64
	npu     float64
	ram     int
	netMbps float64
	box     aabb // дверь: AABB-коллайдер (open отключает)

	owner       uint64          // владелец trojan (0 = нейтральное)
	open        bool            // дверь: стартует закрытой
	vulnedBy    map[uint64]bool // хакеры с завершённым vulnscan (M2: навсегда)
	watcherBy   map[uint64]bool // хакеры с установленным watcher-триггером (§13.1)
	firewalled  uint64          // хозяин firewall-фильтра точки входа (§13.5; 0 = нет)
	antivirused uint64          // хозяин antivirus-процесса (§13.6; 0 = нет)
}

// cable — ребро сети (§12.3): полилиния. M2-2: перерубание удалено —
// кабель только визуализирует топологию и всегда цел.
type cable struct {
	id       string
	fromDev  string
	toDev    string
	points   []vec3
	wireless bool // радио-аплинк: на карте рисуется пунктиром
}

// cyberState — граф сети; часть world.
type cyberState struct {
	devices map[string]*device
	order   []string // порядок карты: стабильные снапшоты/сканы
	cables  []*cable
	doors   []*device
	cameras []*device // §13.7: сенсоры наблюдения (лента владельцу)
}

// buildCyber — устройства и кабели из пропсов карты. Радио-точка — точка
// входа БЕЗ кабелей (§12): в графе она изолирована, её NET доступен только
// в радиусе. Рёбра сети задают исключительно cable-пропсы (door.to —
// справочная ссылка на «короткий кабель» для рендера клиента).
func buildCyber(m *gameMap) *cyberState {
	cs := &cyberState{devices: make(map[string]*device)}
	for _, p := range m.props {
		if p.Kind == "cable" {
			continue
		}
		st := deviceStats[p.Kind]
		d := &device{
			id: p.ID, kind: p.Kind,
			pos: vec3(p.Pos), radius: p.Radius,
			cpu: st.cpu, npu: st.npu, ram: st.ram, netMbps: st.net,
			vulnedBy:  make(map[uint64]bool),
			watcherBy: make(map[uint64]bool),
		}
		if d.kind == "radio" && d.radius <= 0 {
			d.radius = jackRadioRadius
		}
		if d.kind == "door" {
			d.box = aabb{
				min: vec3{p.Pos[0] - p.Size[0]/2, p.Pos[1], p.Pos[2] - p.Size[2]/2},
				max: vec3{p.Pos[0] + p.Size[0]/2, p.Pos[1] + p.Size[1], p.Pos[2] + p.Size[2]/2},
			}
			cs.doors = append(cs.doors, d)
		}
		if d.kind == "camera" {
			cs.cameras = append(cs.cameras, d)
		}
		cs.devices[d.id] = d
		cs.order = append(cs.order, d.id)
	}
	for _, p := range m.props {
		if p.Kind != "cable" {
			continue
		}
		c := &cable{id: p.ID, fromDev: p.From, toDev: p.To}
		for _, pt := range p.Points {
			c.points = append(c.points, vec3(pt))
		}
		if len(c.points) < 2 { // без точек — прямой сегмент (мини-карты тестов)
			c.points = []vec3{cs.devices[p.From].pos, cs.devices[p.To].pos}
		}
		cs.cables = append(cs.cables, c)
	}
	// Радио-точка — беспроводной аплинк к ближайшему switch (§12.1,
	// решение владельца 2026-11-14: без аплинка радио мертво — portscan от
	// него не видит сеть). Аплинк не режется физически; NET-бутылочное горло
	// — сама точка (20 Мбит).
	for _, p := range m.props {
		if p.Kind != "radio" {
			continue
		}
		var best *device
		bestD := -1.0
		for _, d := range cs.devices {
			if d.kind != "switch" {
				continue
			}
			if dist := d.pos.sub(vec3(p.Pos)).length(); bestD < 0 || dist < bestD {
				best, bestD = d, dist
			}
		}
		if best == nil {
			continue
		}
		cs.cables = append(cs.cables, &cable{
			id:       p.ID + "-uplink",
			fromDev:  p.ID,
			toDev:    best.id,
			wireless: true,
		})
	}
	return cs
}

// neighbors — соседи устройства по кабелям (M2-2: всегда целым).
func (cs *cyberState) neighbors(id string) []string {
	out := make([]string, 0, 2)
	for _, c := range cs.cables {
		switch {
		case c.fromDev == id:
			out = append(out, c.toDev)
		case c.toDev == id:
			out = append(out, c.fromDev)
		}
	}
	return out
}

// reachable — BFS от устройства по графу кабелей (portscan, §12.4).
// Радио-точка изолирована: BFS от неё находит только её саму.
func (cs *cyberState) reachable(from string) map[string]bool {
	seen := map[string]bool{from: true}
	queue := []string{from}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, n := range cs.neighbors(cur) {
			if !seen[n] {
				seen[n] = true
				queue = append(queue, n)
			}
		}
	}
	return seen
}

// reachableFor — BFS «для конкретного хакера» (§13.5, сегментация): чужой
// firewall на устройстве не пропускает распространение СКВОЗЬ него — само
// устройство остаётся достижимым (интерфейс виден), соседи за ним не
// открываются. Владелец фильтра и его команда проходят свободно.
func (w *world) reachableFor(from string, pl *player) map[string]bool {
	seen := map[string]bool{from: true}
	queue := []string{from}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if w.firewallBlocksThrough(w.cyber.devices[cur], pl) {
			continue // транзитный трафик через чужой firewall не идёт
		}
		for _, n := range w.cyber.neighbors(cur) {
			if !seen[n] {
				seen[n] = true
				queue = append(queue, n)
			}
		}
	}
	return seen
}

// firewallBlocksThrough — режет ли firewall на устройстве транзит для pl:
// фильтр есть, pl не хозяин и не союзник. Хозяин offline (сессия) — режет
// всех чужих: фильтр живёт в сети (§13.5), союзничество проверяется по
// последней известной команде.
func (w *world) firewallBlocksThrough(d *device, pl *player) bool {
	if d == nil || d.firewalled == 0 || d.firewalled == pl.id {
		return false
	}
	owner, ok := w.players[d.firewalled]
	return !ok || owner.team != pl.team
}

// firewallScanHit — первый (в порядке карты) известный хакеру хост, через
// который его portscan не может распространиться из-за чужого firewall, при
// условии, что за фильтром есть ещё неоткрытые соседи — «скан упёрлся».
// nil = упора нет (спамить alert'ами нельзя, §13.5).
func (w *world) firewallScanHit(pl *player, known map[string]bool) *device {
	for _, id := range w.cyber.order {
		d := w.cyber.devices[id]
		if !known[id] || !w.firewallBlocksThrough(d, pl) {
			continue
		}
		for _, n := range w.cyber.neighbors(id) {
			if !known[n] {
				return d
			}
		}
	}
	return nil
}

// jackTarget — ближайшее устройство джек-ина: терминал в 2 м, радио — в
// радиусе (3D-дистанция; LOS по §12.7 не нужен).
func (cs *cyberState) jackTarget(pos vec3) *device {
	var best *device
	bestD := math.Inf(1)
	for _, id := range cs.order {
		d := cs.devices[id]
		if d.kind != "terminal" && d.kind != "radio" {
			continue
		}
		r := jackTerminalRadius
		if d.kind == "radio" {
			r = d.radius
		}
		if dist := d.pos.sub(pos).length(); dist <= r && dist < bestD {
			best, bestD = d, dist
		}
	}
	return best
}

// program — процесс на деке джекнутого хакера (§12.4). Прогресс — секунды
// «работы»; каждый тик растёт на dt/N запущенных (честные очереди: N
// программ = каждая в N раз медленнее).
type program struct {
	id       int
	prog     string // portscan|vulnscan|trojan
	dev      string // цель (пусто у portscan)
	work     float64
	progress float64
}

func progWork(name string) float64 {
	switch name {
	case "portscan":
		return portscanWork
	case "vulnscan":
		return vulnscanWork
	case "trojan":
		return trojanWork
	case "watcher":
		return watcherWork
	case "firewall":
		return firewallWork
	case "antivirus":
		return antivirusWork
	}
	return 0
}

// --- джек-ин / джек-аут ---------------------------------------------------

// interactTick — edge клавиши interact (space): джек-ин хакера у
// терминала/радио (§12.5). Клиент ничего отдельного не шлёт.
func (w *world) interactTick(pl *player) {
	pressed := pl.keys.interact && !pl.prevInteract
	pl.prevInteract = pl.keys.interact
	if !pressed || !pl.alive || pl.jacked || pl.cls != "hacker" {
		return // дека только у хакера; мёртвые и уже джекнутые не входят
	}
	if dev := w.cyber.jackTarget(pl.pos); dev != nil {
		w.jackin(pl, dev)
	}
}

func (w *world) jackin(pl *player, dev *device) {
	// Точка входа — тоже сетевое устройство (§6): захвачена другим хакером —
	// джек-ин закрыт, перехватить точку можно только из другого места сети.
	// NB: firewall джек-ин больше не фильтрует (§13.5, редакция 2026-11-15):
	// защита сегмента, а не входа — замок убран.
	if dev.owner != 0 && dev.owner != pl.id {
		w.denied(pl, "not_owner")
		return
	}
	pl.jacked = true
	pl.jackHost = dev
	pl.progs = nil
	w.sendTo(pl.id, message{
		"t":    "jackin",
		"host": dev.id,
		"deck": message{"cpu": deckCPU, "npu": deckNPU, "ram": deckRAM, "net": dev.netMbps},
	})
	// Накопленные знания переживают jackout (сессия, §12.5): повторный вход
	// сразу показывает карту сети и восстанавливает табы захваченных
	// устройств (плейтест M3). Знания обрезаем по достижимости от новой
	// точки входа ( с учётом firewall-сегментации, §13.5) — scan остаётся
	// живым видом сети, а не архивом.
	if pl.scanned != nil {
		reach := w.reachableFor(dev.id, pl)
		for id := range pl.scanned {
			if !reach[id] {
				delete(pl.scanned, id)
			}
		}
		w.sendScan(pl)
	}
	w.fireWatchers(dev, pl)
}

// fireWatchers — чужой джек-ин в устройство с watcher'ами (§13.1): каждому
// живому хозяину — alert. Мёртвым не шлём (триггеры гаснут, §5.5), но
// watcher не снимается: после респауна сработает без переустановки.
func (w *world) fireWatchers(dev *device, who *player) {
	for ownerID := range dev.watcherBy {
		if ownerID == who.id {
			continue
		}
		owner, ok := w.players[ownerID]
		if !ok || !owner.alive {
			continue
		}
		w.sendTo(ownerID, message{"t": "alert", "dev": dev.id, "who": who.id, "src": "watcher"})
	}
}

// jackout — выход (CTRL/CMD+ALT+DEL) или смерть: процессы деки отменяются,
// trojan'ы и открытия portscan'а остаются — они в сети, не в голове (§5.5).
func (w *world) jackout(pl *player) {
	if !pl.jacked {
		return
	}
	log.Printf("room: player %d jackout", pl.id)
	pl.jacked = false
	pl.jackHost = nil
	pl.progs = nil
}

// --- программы ------------------------------------------------------------

func (w *world) denied(pl *player, reason string) {
	log.Printf("room: player %d denied: %s", pl.id, reason)
	w.sendTo(pl.id, message{"t": "denied", "reason": reason})
}

// handleRun — {"t":"run"} (§12.5): запуск программы на деке. Валидации:
// джекнут, есть слот RAM, цель достижима BFS от точки входа, trojan требует
// завершённый vulnscan.
func (w *world) handleRun(pl *player, msg message) {
	if !pl.alive {
		return
	}
	if !pl.jacked {
		w.denied(pl, "not_jacked")
		return
	}
	prog := str(msg, "prog")
	work := progWork(prog)
	if work == 0 {
		return // неизвестная программа — мусор в протоколе, игнорируем
	}
	if len(pl.progs) >= deckRAM {
		w.denied(pl, "ram_full")
		return
	}
	devID := str(msg, "dev")
	if prog != "portscan" {
		dev, ok := w.cyber.devices[devID]
		// Цель должна быть обнаружена (scanned — туман войны portscan'а) И
		// оставаться достижимой по текущей сети — достижимость per-player:
		// чужой firewall на транзитном устройстве отрезает цель (§13.5).
		if !ok || !pl.scanned[devID] || !w.reachableFor(pl.jackHost.id, pl)[devID] {
			w.denied(pl, "too_far")
			return
		}
		if prog == "trojan" && !dev.vulnedBy[pl.id] {
			w.denied(pl, "not_vulned")
			return
		}
		// §13.5: firewall ставится только на точку входа — фильтровать
		// jack-in у switch/дверей нечего.
		if prog == "firewall" && dev.kind != "terminal" && dev.kind != "radio" {
			w.denied(pl, "bad_target")
			return
		}
	}
	pl.progs = append(pl.progs, &program{id: pl.nextProgID, prog: prog, dev: devID, work: work})
	pl.nextProgID++
	log.Printf("room: player %d run %s %s", pl.id, prog, devID)
}

// handleCtrl — {"t":"ctrl"} (§12.5): toggle двери. Только владелец trojan,
// лично и из hacker view (джекнутый), и пока дверь достижима от точки
// входа — перерубленный кабель отрезает и управление (контр-хакинг §6).
func (w *world) handleCtrl(pl *player, msg message) {
	if !pl.alive {
		return
	}
	if !pl.jacked {
		w.denied(pl, "not_jacked")
		return
	}
	dev, ok := w.cyber.devices[str(msg, "dev")]
	if !ok || dev.kind != "door" || dev.owner != pl.id {
		w.denied(pl, "not_owner")
		return
	}
	if !w.reachableFor(pl.jackHost.id, pl)[dev.id] {
		w.denied(pl, "too_far")
		return
	}
	if str(msg, "action") != "toggle" {
		return
	}
	dev.open = !dev.open // snap.props разнесёт всем (§12.5)
	log.Printf("room: player %d ctrl %s -> open=%v", pl.id, dev.id, dev.open)
}

// cyberTick — честные очереди (§12.4): доля каждой программы = 1/N,
// завершённые выполняют эффект и покидают деку.
func (w *world) cyberTick(pl *player, dt float64) {
	if !pl.jacked || len(pl.progs) == 0 {
		return
	}
	share := dt / float64(len(pl.progs))
	var finished []*program
	for _, p := range pl.progs {
		p.progress += share
		if p.progress >= p.work {
			finished = append(finished, p)
		}
	}
	for _, p := range finished {
		for i, q := range pl.progs {
			if q == p {
				pl.progs = append(pl.progs[:i], pl.progs[i+1:]...)
				break
			}
		}
		w.completeProgram(pl, p)
	}
}

func (w *world) completeProgram(pl *player, p *program) {
	switch p.prog {
	case "portscan":
		// Прогрессивное открытие (решение владельца): один portscan добавляет
		// ровно один хоп от уже известных устройств, а не всю сеть сразу.
		// Прогрессивное открытие (решение владельца): один portscan добавляет
		// один хоп от известного, а карта — ЖИВОЙ вид сети: устройства за
		// перерубленными кабелями исчезают со скана (§12.7).
		if pl.scanned == nil {
			pl.scanned = map[string]bool{pl.jackHost.id: true}
		}
		pl.scanned[pl.jackHost.id] = true // точка входа известна всегда
		// Достижимость per-player (§13.5): чужой firewall не пропускает
		// распространение сквозь себя — соседи за фильтром не открываются,
		// ранее открытое гаснет (живой вид сети).
		reach := w.reachableFor(pl.jackHost.id, pl)
		frontier := make([]string, 0, len(pl.scanned))
		for id := range pl.scanned {
			frontier = append(frontier, id)
		}
		for _, id := range frontier {
			for _, n := range w.cyber.neighbors(id) {
				if reach[n] {
					pl.scanned[n] = true
				}
			}
		}
		for id := range pl.scanned {
			if !reach[id] {
				delete(pl.scanned, id)
			}
		}
		// Скан упёрся в чужой firewall (за фильтром есть неоткрытые соседи) —
		// один alert хозяину на запуск (§13.5, без спама; живому — §5.5).
		if hit := w.firewallScanHit(pl, pl.scanned); hit != nil {
			if owner, ok := w.players[hit.firewalled]; ok && owner.alive {
				w.sendTo(hit.firewalled, message{"t": "alert", "dev": hit.id, "who": pl.id, "src": "firewall"})
			}
		}
		w.sendScan(pl)
	case "vulnscan":
		if dev := w.cyber.devices[p.dev]; dev != nil {
			dev.vulnedBy[pl.id] = true // M2: навсегда (§12.4)
			w.sendScan(pl)             // обновить карту: узел помечается «уязвимо»
		}
	case "trojan":
		if dev := w.cyber.devices[p.dev]; dev != nil {
			// §13.6: чужой antivirus отбивает установку trojan (denied +
			// alert хозяину) и изнашивается — гонка версий: повторная попытка
			// проходит, если защитник не переустановил. Свой/союзный
			// antivirus trojan не встречает.
			if av := dev.antivirused; av != 0 && av != pl.id {
				if owner, ok := w.players[av]; !ok || owner.team != pl.team {
					if ok && owner.alive {
						w.sendTo(av, message{"t": "alert", "dev": dev.id, "who": pl.id, "src": "antivirus"})
					}
					dev.antivirused = 0 // сигнатуры пробиты — фильтр изношен
					w.denied(pl, "antivirus")
					w.resendScanFor(p.dev) // ореол antivirused исчез с карты
					return
				}
			}
			dev.owner = pl.id // userland; двери дают владельцу toggle
			// §13.5: новый trojan выкуривает чужой firewall — обход без
			// тупика (взломщик получает и владение, и открытый вход).
			if dev.firewalled != 0 && dev.firewalled != pl.id {
				dev.firewalled = 0
			}
			w.resendScanFor(p.dev)
		}
	case "watcher":
		// §13.1: триггер живёт на устройстве (как trojan), слот RAM освобождён.
		if dev := w.cyber.devices[p.dev]; dev != nil {
			dev.watcherBy[pl.id] = true
			w.resendScanFor(p.dev) // на карте появится отметка watched
		}
	case "firewall":
		// §13.5: фильтр живёт на устройстве (как trojan), слот RAM освобождён.
		// Повторная установка тем же хакером — no-op (один firewall на девайс).
		if dev := w.cyber.devices[p.dev]; dev != nil {
			dev.firewalled = pl.id
			// Сегмент за D закрылся для чужих: их кибер-карта — живой вид
			// сети. Обрезаем знания всех джекнутых по их достижимости и
			// пересылаем scan (гаснет «за D», появляется бейдж firewalled).
			for _, p2 := range w.players {
				if !p2.jacked || p2.jackHost == nil || p2.scanned == nil {
					continue
				}
				reach := w.reachableFor(p2.jackHost.id, p2)
				changed := false
				for id := range p2.scanned {
					if !reach[id] {
						delete(p2.scanned, id)
						changed = true
					}
				}
				if changed || p2.scanned[dev.id] {
					w.sendScan(p2)
				}
			}
		}
	case "antivirus":
		// §13.6: резидентный процесс живёт на устройстве (как trojan), слот
		// RAM освобождён. Один antivirus на устройство: чужая установка
		// перезаписывает хозяина (переустановка после износа — гонка версий).
		if dev := w.cyber.devices[p.dev]; dev != nil {
			dev.antivirused = pl.id
			w.resendScanFor(p.dev) // на карте появится ореол antivirused
		}
	}
}

// resendScanFor — устройство сменило владельца: кибер-карту обновляем всем
// джекнутым, кто это устройство открыл (§12.5: scan после изменений).
func (w *world) resendScanFor(devID string) {
	for _, p := range w.players {
		if p.jacked && p.scanned != nil && p.scanned[devID] {
			w.sendScan(p)
		}
	}
}

// --- сообщения деки -------------------------------------------------------

type scanDevice struct {
	ID    string   `json:"id"`
	Kind  string   `json:"kind"`
	X     float64  `json:"x"`
	Y     float64  `json:"y"`
	Z     float64  `json:"z"`
	Owner any      `json:"owner"` // null = нейтральное
	Links []string `json:"links"`
	// Vulned — уязвимость, найденная МОИМ vulnscan'ом (для этого хакера);
	// omitempty: поле появляется только когда true (§12.5, доп. 2026-11-14).
	Vulned bool `json:"vulned,omitempty"`
	// Watched — на устройстве стоит МОЙ watcher-триггер (§13.2), omitempty.
	Watched bool `json:"watched,omitempty"`
	// Firewalled — на устройстве стоит чей-то firewall (§13.5), omitempty.
	// Наблюдаемый сетевой фильтр — виден всем, кто открыл устройство
	// (в отличие от личных vulned/watched).
	Firewalled bool `json:"firewalled,omitempty"`
	// FirewalledBy — хозяин фильтра (§13.5: чей — для бейджа «свой/союзный/
	// чужой» на кибер-карте; приходит вместе с Firewalled).
	FirewalledBy uint64 `json:"firewalledBy,omitempty"`
	// Antivirused — на устройстве стоит чей-то antivirus (§13.6), omitempty.
	// Резидентный процесс наблюдаем из сети — виден всем, кто открыл
	// устройство (как firewalled).
	Antivirused bool `json:"antivirused,omitempty"`
}

// sendScan — кибер-карта хакера: только открытые его portscan'ом устройства
// (туман войны), с текущим владельцем и связями (§12.5).
func (w *world) sendScan(pl *player) {
	devs := make([]scanDevice, 0, len(pl.scanned))
	for _, id := range w.cyber.order {
		if !pl.scanned[id] {
			continue
		}
		d := w.cyber.devices[id]
		sd := scanDevice{
			ID: d.id, Kind: d.kind,
			X: round3(d.pos[0]), Y: round3(d.pos[1]), Z: round3(d.pos[2]),
			Links: w.cyber.neighbors(id),
		}
		if d.owner != 0 {
			sd.Owner = d.owner
		}
		if d.vulnedBy[pl.id] {
			sd.Vulned = true
		}
		if d.watcherBy[pl.id] {
			sd.Watched = true
		}
		if d.firewalled != 0 {
			sd.Firewalled = true
			sd.FirewalledBy = d.firewalled
		}
		if d.antivirused != 0 {
			sd.Antivirused = true
		}
		devs = append(devs, sd)
	}
	w.sendTo(pl.id, message{"t": "scan", "devices": devs})
}

type deckProg struct {
	ID    int    `json:"id"`
	Prog  string `json:"prog"`
	Dev   string `json:"dev"`
	EtaMs int64  `json:"etaMs"`
}

// deckStatusTick — статус деки 2 Гц джекнутым (§12.5). Загрузки: cpuLoad =
// N слотов из 4 (каждая программа — четверть деки, при N=4 каждая идёт в
// 1/4 скорости); netLoad — доля канала точки входа (радио 20 Мбит
// насыщается быстрее терминала 100).
func (w *world) deckStatusTick() {
	if w.tick%deckStatusEvery != 0 {
		return
	}
	for _, p := range w.players {
		if !p.jacked || p.jackHost == nil {
			continue
		}
		n := len(p.progs)
		progs := make([]deckProg, 0, n)
		for _, pr := range p.progs {
			remain := (pr.work - pr.progress) * float64(n) // ETA при текущей доле
			if remain < 0 {
				remain = 0
			}
			progs = append(progs, deckProg{ID: pr.id, Prog: pr.prog, Dev: pr.dev, EtaMs: int64(remain * 1000)})
		}
		w.sendTo(p.id, message{
			"t":       "deck",
			"cpuLoad": round3(math.Min(1, float64(n)/deckRAM)),
			"npuLoad": 0.0, // NPU-программ в M2 нет
			"ramUsed": n,
			"netLoad": round3(math.Min(1, float64(n)*progNetMbps/p.jackHost.netMbps)),
			"progs":   progs,
		})
	}
}

// camSeen — один «кадр» ленты камеры (§13.7): живой игрок в зоне видимости.
type camSeen struct {
	ID   uint64  `json:"id"`
	Name string  `json:"name"`
	Team int     `json:"team"`
	Cls  string  `json:"cls"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
	Z    float64 `json:"z"`
}

// camFeedTick — лента камер 2 Гц (§13.7): каждой камерой с владельцем —
// «кто в зоне видимости» (радиус 12 м + LOS: статика и закрытые двери, как
// у пуль). Получает только живой владелец trojan (джекнут или нет — как
// alert'ы, §5.5); пустой кадр тоже шлётся, чтобы UI чистил ленту.
func (w *world) camFeedTick() {
	if w.tick%camFeedEvery != 0 {
		return
	}
	for _, cam := range w.cyber.cameras {
		owner, ok := w.players[cam.owner]
		if cam.owner == 0 || !ok || !owner.alive {
			continue
		}
		seen := make([]camSeen, 0, 4)
		for _, pl := range w.players {
			if !pl.alive {
				continue
			}
			center := pl.pos.add(vec3{0, camBodyHeight, 0})
			if cam.pos.sub(center).length() > camVisionRadius {
				continue
			}
			if w.segmentBlockedAll(cam.pos, center) {
				continue // камера за стеной/дверью не «рентгенит» (§13.7)
			}
			p := pl.pos.round2()
			seen = append(seen, camSeen{
				ID: pl.id, Name: pl.name, Team: pl.team, Cls: pl.cls,
				X: p[0], Y: p[1], Z: p[2],
			})
		}
		w.sendTo(owner.id, message{"t": "cam", "dev": cam.id, "seen": seen})
	}
}

// snapProps — динамическое состояние пропсов для снапа (§12.5), всем.
func (cs *cyberState) snapProps() []any {
	props := make([]any, 0, len(cs.order)+len(cs.cables))
	for _, id := range cs.order {
		d := cs.devices[id]
		m := message{
			"id": d.id, "kind": d.kind,
			"x": round3(d.pos[0]), "y": round3(d.pos[1]), "z": round3(d.pos[2]),
		}
		switch d.kind {
		case "door":
			m["open"] = d.open
		case "radio":
			m["radius"] = d.radius
		case "camera":
			// §13.7: LED-индикатор владения в 3D (нейтральная/своя/чужая).
			if d.owner != 0 {
				m["owner"] = d.owner
			}
		}
		props = append(props, m)
	}
	return props
}

// --- движение с дверями ---------------------------------------------------

// doorBlocker — статика + закрытые двери. Дверь, внутри AABB которой игрок
// уже стоит (захлопнулась на нём), не блокирует — можно выйти.
func (w *world) doorBlocker(pl *player) blockFn {
	return func(b aabb) bool {
		if w.m.overlapsAny(b) {
			return true
		}
		for _, d := range w.cyber.doors {
			if d.open || !boxesOverlap(b, d.box) {
				continue
			}
			if boxesOverlap(playerBoxAt(pl.pos), d.box) {
				continue
			}
			return true
		}
		return false
	}
}

// movePlayer — движение в мире: джекнутый стоит у терминала (§12.1),
// остальные — по статике с учётом закрытых дверей.
func (w *world) movePlayer(pl *player, dt float64) {
	if pl.jacked {
		return
	}
	w.m.movePlayerBlocked(pl, dt, w.doorBlocker(pl))
}

// --- двери как препятствия для огня (плейтест M2-2) -----------------------

// segmentBlockedAll — статика карты + ЗАКРЫТЫЕ двери: пули/нож/LOS не
// проходят сквозь них. Открытая дверь — не препятствие.
func (w *world) segmentBlockedAll(origin, target vec3) bool {
	if w.m.segmentBlocked(origin, target) {
		return true
	}
	d := target.sub(origin)
	l := d.length()
	if l < 1e-9 {
		return false
	}
	dir := d.scaled(1 / l)
	for _, door := range w.cyber.doors {
		if door.open {
			continue
		}
		if t := rayBoxT(origin, dir, door.box); t >= 0 && t <= l {
			return true
		}
	}
	return false
}

// raycastAll — ближайшая точка остановки луча: статика или закрытая дверь.
func (w *world) raycastAll(origin, dir vec3) (vec3, bool) {
	end, ok := w.m.raycast(origin, dir)
	best := math.Inf(1)
	if ok {
		best = end.sub(origin).length()
	}
	for _, door := range w.cyber.doors {
		if door.open {
			continue
		}
		if t := rayBoxT(origin, dir, door.box); t >= 0 && t < best {
			best = t
			end = origin.add(dir.scaled(t))
			ok = true
		}
	}
	return end, ok
}

// --- нож и кабели ---------------------------------------------------------
