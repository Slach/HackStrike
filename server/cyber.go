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

	portscanWork = 2.0 // с работы при полной CPU-доле (§12.4)
	vulnscanWork = 3.0
	trojanWork   = 2.0

	deckStatusEvery = tickRate / 2 // статус деки 2 Гц (§12.5)

	cableThickness = 0.15 // сечение кабель-коллайдера (§12.3)
	knifeRange     = 1.8  // м: melee ножа (§12.1)

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
}

// device — кибер-устройство (§12.2). Железо неизменно; динамика — owner
// (последний trojan), vulnedBy и open у дверей.
type device struct {
	id      string
	kind    string // terminal|radio|switch|door
	pos     vec3
	radius  float64 // радио
	cpu     float64
	npu     float64
	ram     int
	netMbps float64
	box     aabb // дверь: AABB-коллайдер (open отключает)

	owner    uint64          // владелец trojan (0 = нейтральное)
	open     bool            // дверь: стартует закрытой
	vulnedBy map[uint64]bool // хакеры с завершённым vulnscan (M2: навсегда)
}

// cable — ребро сети (§12.3): полилиния + тонкие коллайдеры для ножа/пуль.
// Коллайдеры живут отдельно от геометрии карты и движению не мешают.
type cable struct {
	id       string
	fromDev  string
	toDev    string
	points   []vec3
	boxes    []aabb
	severed  bool // перерублен: ребро исчезает из графа (§6)
	wireless bool // радио-аплинк: не режется, на карте рисуется пунктиром
}

// cyberState — граф сети; часть world.
type cyberState struct {
	devices map[string]*device
	order   []string // порядок карты: стабильные снапшоты/сканы
	cables  []*cable
	doors   []*device
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
			vulnedBy: make(map[uint64]bool),
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
		cs.devices[d.id] = d
		cs.order = append(cs.order, d.id)
	}
	half := cableThickness / 2
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
		for i := 0; i+1 < len(c.points); i++ {
			a, b := c.points[i], c.points[i+1]
			var box aabb
			for ax := 0; ax < 3; ax++ {
				lo, hi := math.Min(a[ax], b[ax]), math.Max(a[ax], b[ax])
				if hi-lo < 1e-9 { // поперечные оси — толщина 0.15
					lo -= half
					hi += half
				}
				box.min[ax], box.max[ax] = lo, hi
			}
			c.boxes = append(c.boxes, box)
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

// neighbors — соседи устройства по неперерубленным кабелям.
func (cs *cyberState) neighbors(id string) []string {
	out := make([]string, 0, 2)
	for _, c := range cs.cables {
		if c.severed && !c.wireless {
			continue
		}
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
}

// jackout — выход (CTRL/CMD+ALT+DEL) или смерть: процессы деки отменяются,
// trojan'ы и открытия portscan'а остаются — они в сети, не в голове (§5.5).
func (w *world) jackout(pl *player) {
	if !pl.jacked {
		return
	}
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
		// оставаться достижимой по текущей сети (обрыв кабеля отрезает управление).
		if !ok || !pl.scanned[devID] || !w.cyber.reachable(pl.jackHost.id)[devID] {
			w.denied(pl, "too_far")
			return
		}
		if prog == "trojan" && !dev.vulnedBy[pl.id] {
			w.denied(pl, "not_vulned")
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
	if !w.cyber.reachable(pl.jackHost.id)[dev.id] {
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
		reach := w.cyber.reachable(pl.jackHost.id)
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
		w.sendScan(pl)
	case "vulnscan":
		if dev := w.cyber.devices[p.dev]; dev != nil {
			dev.vulnedBy[pl.id] = true // M2: навсегда (§12.4)
			w.sendScan(pl)             // обновить карту: узел помечается «уязвимо»
		}
	case "trojan":
		if dev := w.cyber.devices[p.dev]; dev != nil {
			dev.owner = pl.id // userland; двери дают владельцу toggle
			w.resendScanFor(p.dev)
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
		}
		props = append(props, m)
	}
	for _, c := range cs.cables {
		props = append(props, message{"id": c.id, "kind": "cable", "severed": c.severed})
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

// cutCableAlong — перерубить кабель (нож/пули, §6): ближайший сегмент на
// луче в пределах maxDist. severed=true уходит всем через snap.props.
func (w *world) cutCableAlong(origin, dir vec3, maxDist float64) *cable {
	var best *cable
	bestT := maxDist
	for _, c := range w.cyber.cables {
		if c.severed {
			continue
		}
		for _, box := range c.boxes {
			if t := rayBoxT(origin, dir, box); t >= 0 && t < bestT {
				best, bestT = c, t
			}
		}
	}
	if best != nil {
		best.severed = true // ребро исчезает из графа (восстановление — потом)
	}
	return best
}

// knife — удар ножом (§12.1): 60 урона, дистанция 1.8 м + LOS; без конуса и
// магнетизма. Кабель режется с одного удара — луч из глаз по сегментам.
func (w *world) knife(pl *player, yaw, pitch float64) {
	pl.yaw, pl.pitch = yaw, pitch
	origin := pl.pos.add(vec3{0, eyeHeight, 0})
	dir := aimDir(yaw, pitch)

	// Закрытая дверь останавливает и нож: резать кабели за ней нельзя.
	doorStop := knifeRange
	if end, ok := w.raycastAll(origin, dir); ok {
		if dl := end.sub(origin).length(); dl < doorStop {
			doorStop = dl
		}
	}
	w.cutCableAlong(origin, dir, doorStop)

	var victim *player
	best := knifeRange
	for _, p := range w.players {
		if p.id == pl.id || !p.alive {
			continue
		}
		center := p.pos.add(vec3{0, playerHeight / 2, 0})
		rel := center.sub(origin)
		dist := rel.length()
		if dist > best || dist < 1e-6 || rel.dot(dir) <= 0 {
			continue // далеко или за спиной — «луч из глаз»
		}
		if w.segmentBlockedAll(origin, center) {
			continue
		}
		victim, best = p, dist
	}

	to := origin.add(dir.scaled(knifeRange))
	var hit any
	if victim != nil {
		to = victim.pos.add(vec3{0, playerHeight / 2, 0})
		hit = victim.id
	}
	killed := false
	if victim != nil {
		killed = w.damage(pl, victim) // 60 урона ножа (weapon.damage)
	}
	w.broadcast(message{"t": "shot", "by": pl.id, "hit": hit, "from": origin.round2(), "to": to.round2()})
	if killed {
		w.sendTo(victim.id, message{"t": "death", "by": pl.id, "respawnAt": victim.respawnAt.UnixMilli()})
	}
}
