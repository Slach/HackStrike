package main

// Кибер-слой M2 «Кибер-базис» (ГДД §12): граф сети из пропсов карты,
// устройства (терминалы/радио/switch/двери), джек-ин/джек-аут, программы
// деки с честными очередями, двери как первые CONTROLLERS, нож/пули режут
// кабели. Всё состояние трогает только горутина комнаты (инвариант 2).

import (
	"fmt"
	"log"
	"math"
	"sort"
	"strings"
	"time"
)

// M2-константы (§12.1–§12.4; менять только через ГДД).
const (
	jackTerminalRadius = 2.0 // м: джек-ин у терминала
	jackRadioRadius    = 8.0 // м: радиус радио-точки по умолчанию
	jackChannelWork    = 6.0 // §12.1 «дорогой вход»: установка канала у не-точки входа, с

	deckCPU = 1.0 // дека хакера (§12.2)
	deckNPU = 0.5
	deckRAM = 4   // слота программ
	deckMEM = 256 // §16.1: MEM деки (оба ключа влезают)

	portscanWork  = 2.0 // с работы при полной CPU-доле (§12.4)
	vulnscanWork  = 3.0
	trojanWork    = 2.0
	watcherWork   = 1.0 // §13.1: пассивный слушатель — дешевле vulnscan'а
	firewallWork  = 1.5 // §13.5: активный фильтр — дороже watcher'а, дешевле trojan'а
	antivirusWork = 1.5 // §13.6: активная защита — тот же ярус, что firewall

	camVisionRadius = 12.0         // §13.7: зона видимости камеры, м (радиус + LOS)
	camFeedEvery    = tickRate / 2 // лента камеры 2 Гц (§13.7: 0.5–1 с достаточно)
	camBodyHeight   = 0.9          // центр корпуса игрока от ног (цель LOS-луча)

	watcherLogCap  = 20       // §13.1 №1: ёмкость ring-buffer журнала событий
	radarFeedEvery = tickRate // §13.1 №3: радар-срез 1 Гц (аналог camFeedTick)

	deckStatusEvery = tickRate / 2 // статус деки 2 Гц (§12.5)

	// progNetMbps — «поток» одной активной программы для графика netLoad
	// (чисто отображение: 10 Мбит/с × N / канал точки входа).
	progNetMbps = 10.0

	// M5 итерация 1 «канал сети» (§16.3, ревизия 1): bw-модель в МБ/с по
	// рёбрам графа — входной хоп «дека↔точка входа» не считается.
	cableTrunkBW     = 40.0 // кабель без явного bw в карте (магистраль по умолчанию)
	radioUplinkBW    = 5.0  // беспроводной аплинк радио-точки (§16.3: радио 5)
	defaultBackplane = 60.0 // switch без явного backplane (s1/s2-класс)
	// Спрос сканов: portscan — на каждый линк своего распространения;
	// vulnscan/trojan — на линках пути к цели. Доля линка = bw/N потребителей;
	// если доля < спроса, прогресс масштабируется (доля/спрос).
	scanDemandPortscan = 2.0 // МБ/с на линк
	scanDemandPath     = 4.0 // МБ/с на линк

	// M5 итерация 2 «MEM + cp» (§16.1/§16.2): MEM-ёмкости хостов (МБ) и
	// rm-работа. MEM — второй независимый ресурс (слоты программ §12.2 не
	// трогаем); mem_full/dup — отказы трансфера.
	rmWork           = 0.5  // с: удаление данных с хоста (только владелец)
	dataRespawnDelay = 90.0 // §16.1: возрождение rm-нутых seed-данных на доме, с
	dataRespawnRetry = 1.0  // с: повтор попытки, если MEM дома занят

	// M4 объект 1 «газовая камера» (§14.2, числа v0): DoT внутри AABB газа,
	// пока клапан открыт; телеграф перед первым уроном после взвода.
	gasDPS       = 8.0                     // HP/с
	gasTelegraph = 1500 * time.Millisecond // мигание перед первым уроном

	// M4 объект 2 «пол-лава» → огонь (§14.6.1, ревизия v1): постоянный DoT
	// внутри AABB полосы, без телеграфа; горит пока водяной клапан закрыт.
	lavaDPS = 25.0 // HP/с
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
	"gas":      {cpu: 0.2, npu: 0, net: 100, ram: 1}, // §14.2: клапан — контроллер, как дверь
	"valve":    {cpu: 0.2, npu: 0, net: 100, ram: 1}, // §14.6.1: водяной клапан — контроллер, как газовый
	"camera":   {cpu: 0.2, npu: 0, net: 100, ram: 1}, // §13.7: сенсор, как switch
	"srv":      {cpu: 1.0, npu: 1.0, net: 100, ram: 4}, // §16.5: сервер — CPU+NPU станция
}

// device — кибер-устройство (§12.2). Железо неизменно; динамика — owner
// (последний trojan), vulnedBy и open у дверей.
// dataItem — единица данных в MEM хоста (§16.1): осмысленное имя, объём,
// флаг шифрования; после decrypt enc:false и виден code (перехват = готовый
// код). На wire: {"n","mb","enc","code"}.
type dataItem struct {
	Name string `json:"n"`
	MB   int    `json:"mb"`
	Enc  bool   `json:"enc"`
	Code string `json:"code,omitempty"`
}

// memCapacityByKind — MEM-ёмкость хоста по типу (§16.1, МБ).
func memCapacityByKind(kind string) int {
	switch kind {
	case "terminal", "radio":
		return 64
	case "camera":
		return 32
	case "switch":
		return 16
	case "safe": // NETSAFE (итерация 5)
		return 128
	case "srv": // SRV1–SRV3 (итерация 3)
		return 512
	default: // дверь/клапан/газ
		return 8
	}
}

type device struct {
	id      string
	kind    string // terminal|radio|switch|door|gas|camera
	pos     vec3
	radius  float64 // радио
	cpu     float64
	npu     float64
	ram     int
	netMbps float64
	box     aabb // дверь/газ: AABB объёма пропа

	// mem/items — MEM-хранилище данных (§16.1): ёмкость по типу + лежащие
	// items. memFree считается динамически (items + активные резервации
	// cp в этот хост).
	mem   int
	items []dataItem

	owner       uint64          // владелец trojan (0 = нейтральное)
	open        bool            // дверь/газ (§14.2): стартует закрытой
	gasArmAt    time.Time       // газ (§14.2): момент последнего взвода клапана; нулевой = не взведён
	gasArmCount uint64          // газ: счётчик взводов для ключа накопленного долга (resync-устойчив)
	vulnedBy    map[uint64]bool // хакеры с завершённым vulnscan (M2: навсегда)
	watcherBy   map[uint64]bool // хакеры с установленным watcher-триггером (§13.1)
	firewalled  uint64          // хозяин firewall-фильтра точки входа (§13.5; 0 = нет)
	antivirused uint64          // хозяин antivirus-процесса (§13.6; 0 = нет)

	// backplane — switch: суммарная шина транзита, МБ/с (§16.3). Все
	// трансферы/сканы ЧЕРЕЗ свитч делят её по-честному; слабый свитч = узкое
	// место даже при толстых кабелях.
	backplane float64

	// shield/shieldAt — встроенный щит SRV (§16.5): заряды ×3 и момент
	// последнего отбоя (реген +1/30 с от него, общий таймер).
	shield   int
	shieldAt time.Time

	// log — журнал событий watcher'а (§13.1 №1): ring-buffer последних
	// watcherLogCap записей; пишется пока на устройстве есть хотя бы один
	// watcher, читается хозяевами в scan.devices[].log.
	log []logEntry
}

// logEntry — запись журнала событий watcher'а (§13.1 №1, §13.2): тик + что
// (ev) + кто (who) + опционально программа (prog). ev: jackin|install|owner|
// scanhit.
type logEntry struct {
	Tick uint64 `json:"tick"`
	Ev   string `json:"ev"`
	Who  uint64 `json:"who"`
	Prog string `json:"prog,omitempty"`
}

// cable — ребро сети (§12.3): полилиния. M2-2: перерубание удалено —
// кабель только визуализирует топологию и всегда цел. bw — пропускная
// способность, МБ/с (§16.3): конкуренты за линк делят её по-честному.
type cable struct {
	id       string
	fromDev  string
	toDev    string
	points   []vec3
	wireless bool    // радио-аплинк: на карте рисуется пунктиром
	bw       float64 // МБ/с (магистраль 40 / доступ 20 / ветка 10 / радио 5)
}

// firePool — полоса огня (§14.6.1): НЕ сетевое устройство — ни owner/vuln,
// ни графа. AABB для fireTick + ссылка на водяной клапан: его open тушит
// пул (state виден всем через snap.props клапана).
type firePool struct {
	id    string
	box   aabb
	valve *device
}

// cyberState — граф сети; часть world.
type cyberState struct {
	devices map[string]*device
	order   []string // порядок карты: стабильные снапшоты/сканы
	cables  []*cable
	doors   []*device
	gases   []*device   // §14.2: газовые ловушки (DoT-объёмы)
	cameras []*device   // §13.7: сенсоры наблюдения (лента владельцу)
	fires   []*firePool // §14.6.1: полосы огня — вне графа и сканов; горение = valve.open==false
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
		if p.Kind == "fire" {
			// §14.6.1: огонь — стихия, не устройство: мимо device, cs.order,
			// графа. pos — центр объёма по всем осям (конвенция газа); клапан
			// присоединяется вторым проходом (fire идёт раньше valve в props).
			cs.fires = append(cs.fires, &firePool{
				id: p.ID,
				box: aabb{
					min: vec3{p.Pos[0] - p.Size[0]/2, p.Pos[1] - p.Size[1]/2, p.Pos[2] - p.Size[2]/2},
					max: vec3{p.Pos[0] + p.Size[0]/2, p.Pos[1] + p.Size[1]/2, p.Pos[2] + p.Size[2]/2},
				},
			})
			continue
		}
		st := deviceStats[p.Kind]
		d := &device{
			id: p.ID, kind: p.Kind,
			pos: vec3(p.Pos), radius: p.Radius,
			cpu: st.cpu, npu: st.npu, ram: st.ram, netMbps: st.net,
			backplane: p.Backplane,
			vulnedBy:  make(map[uint64]bool),
			watcherBy: make(map[uint64]bool),
			mem:       memCapacityByKind(p.Kind), // §16.1: MEM-хранилище данных
		}
		if d.kind == "switch" && d.backplane <= 0 {
			d.backplane = defaultBackplane // §16.3: s1/s2-класс
		}
		if d.kind == "radio" && d.radius <= 0 {
			d.radius = jackRadioRadius
		}
		if d.kind == "srv" {
			// §16.5: встроенный щит ×3 — свойство железа, не программа
			d.shield = shieldMax
		}
		if d.kind == "door" {
			d.box = aabb{
				min: vec3{p.Pos[0] - p.Size[0]/2, p.Pos[1], p.Pos[2] - p.Size[2]/2},
				max: vec3{p.Pos[0] + p.Size[0]/2, p.Pos[1] + p.Size[1], p.Pos[2] + p.Size[2]/2},
			}
			cs.doors = append(cs.doors, d)
		}
		if d.kind == "gas" {
			// §14.2: pos — центр объёма по всем осям (в отличие от двери, у
			// которой pos — низ панели): gas pos y=1.5, size y=3 → 0..3.
			d.box = aabb{
				min: vec3{p.Pos[0] - p.Size[0]/2, p.Pos[1] - p.Size[1]/2, p.Pos[2] - p.Size[2]/2},
				max: vec3{p.Pos[0] + p.Size[0]/2, p.Pos[1] + p.Size[1]/2, p.Pos[2] + p.Size[2]/2},
			}
			cs.gases = append(cs.gases, d)
		}
		if d.kind == "camera" {
			cs.cameras = append(cs.cameras, d)
		}
		cs.devices[d.id] = d
		cs.order = append(cs.order, d.id)
	}
	// Второй проход: огонь ссылается на свой клапан (§14.6.1) — клапаны уже
	// в cs.devices (валидация карты гарантирует существование).
	for _, p := range m.props {
		if p.Kind != "fire" {
			continue
		}
		for _, f := range cs.fires {
			if f.id == p.ID {
				f.valve = cs.devices[p.To]
			}
		}
	}
	for _, p := range m.props {
		if p.Kind != "cable" {
			continue
		}
		c := &cable{id: p.ID, fromDev: p.From, toDev: p.To, bw: p.BW}
		if c.bw <= 0 {
			c.bw = cableTrunkBW // §16.3: разметка не обязательна — магистраль
		}
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
			bw:       radioUplinkBW, // §16.3: радио 5 — бутылочное горло самой точки
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

// cableBetween — кабель-ребро между двумя устройствами (в любом направлении).
func (cs *cyberState) cableBetween(a, b string) *cable {
	for _, c := range cs.cables {
		if (c.fromDev == a && c.toDev == b) || (c.fromDev == b && c.toDev == a) {
			return c
		}
	}
	return nil
}

// widestPath — маршрут с максимальным «узким местом» (§16.2, widest-path):
// бутылочка пути = min(bw кабелей пути, backplane транзитных свитчей);
// максимизируем её, при равенстве — меньше хопов. Распространение из узла,
// заблокированного чужим firewall, запрещено — то же правило, что у
// reachableFor (§13.5), поэтому путь согласован с достижимостью. Возвращает
// цепочку устройств from..to (nil, если не достичь).
func (cs *cyberState) widestPath(from, to string, blocked func(string) bool) []string {
	if from == to {
		return []string{from}
	}
	// Dijkstra на бутылочку: best[v] — лучший bottleneck к v, prev — цепочка.
	type node struct {
		bw   float64
		hops int
		prev string
		done bool
	}
	best := map[string]*node{from: {bw: math.Inf(1)}}
	for {
		// непосещённый узел с максимальной бутылочкой (при равенстве — меньше хопов)
		cur := ""
		for id, n := range best {
			if n.done {
				continue
			}
			if cur == "" {
				cur = id
				continue
			}
			c := best[cur]
			if n.bw > c.bw || (n.bw == c.bw && n.hops < c.hops) {
				cur = id
			}
		}
		if cur == "" {
			return nil // to не достигнут
		}
		if cur == to {
			var path []string
			for at := to; ; {
				path = append([]string{at}, path...)
				if at == from {
					break
				}
				at = best[at].prev
			}
			return path
		}
		n := best[cur]
		n.done = true
		if blocked(cur) {
			continue // транзит сквозь чужой firewall не идёт (§13.5)
		}
		for _, nb := range cs.neighbors(cur) {
			if old, ok := best[nb]; ok && old.done {
				continue
			}
			lw := math.Inf(1)
			if c := cs.cableBetween(cur, nb); c != nil {
				lw = c.bw
			}
			if d := cs.devices[nb]; d != nil && d.kind == "switch" && d.backplane > 0 {
				lw = math.Min(lw, d.backplane) // транзит через свитч ест его шину
			}
			bw := math.Min(n.bw, lw)
			hops := n.hops + 1
			old, ok := best[nb]
			if !ok || bw > old.bw || (bw == old.bw && hops < old.hops) {
				if !ok {
					best[nb] = &node{}
				}
				best[nb].bw = bw
				best[nb].hops = hops
				best[nb].prev = cur
			}
		}
	}
}

// jackTarget — устройство джек-ина (§12.1 «дорогой вход»): ЛЮБОЕ сетевое
// устройство, чей порт в радиусе (точка входа — терминал 2 м / радио свой;
// прочие — 2 м, горизонтальная дистанция: камеры висят на кронштейнах).
// При конкуренции (камера над дверным проёмом) побеждает та, НА КОТОРУЮ
// СМОТРИМ — конус ~25° вокруг взгляда (плейтест 2026-11-17: «стоял у D1,
// а джекнулся в CAM3 над проёмом»); вне конуса — ближайшая.
func (w *world) jackTarget(pl *player) *device {
	eye := pl.pos.add(vec3{0, eyeHeight, 0})
	var best *device  // ближайший в радиусе
	var aimed *device // лучший в конусе взгляда
	bestD := math.Inf(1)
	bestDot := math.Cos(25 * math.Pi / 180)
	for _, id := range w.cyber.order {
		d := w.cyber.devices[id]
		r := jackTerminalRadius
		if d.kind == "radio" {
			r = d.radius
		}
		dp := d.pos.sub(pl.pos)
		dp[1] = 0
		dist := dp.length()
		if dist > r {
			continue
		}
		// Тот же этаж (§12.1, плейтест 2026-11-17 «в комнате только D1/D2,
		// а джек — D3»): устройство на другом этаже с теми же x/z не цель —
		// вертикальный гейт по глазам (±2.6 м).
		if d.pos[1] > pl.pos[1]+eyeHeight+2.6 || d.pos[1] < pl.pos[1]-2.6 {
			continue
		}
		if dist < bestD {
			best, bestD = d, dist
		}
		// Взгляд игрока (yaw/pitch → направление, как в combat).
		to := d.pos.sub(eye)
		if to.length() < 0.001 {
			continue
		}
		dot := to.dot(aimDir(pl.yaw, pl.pitch)) / to.length()
		if dot > bestDot {
			bestDot, aimed = dot, d
		}
	}
	if aimed != nil {
		return aimed
	}
	return best
}

// jackEntry — точка входа (мгновенный джек-ин, contested enemy_team):
// терминал/радио. Прочие устройства — «дорогой вход» (§12.1).
func jackEntry(d *device) bool { return d.kind == "terminal" || d.kind == "radio" }

// deckNet — NET канала деки игрока (§12.1): у точки входа — паспортный
// netMbps (100/20), у «дорогого входа» — худший кабель устройства.
func (w *world) deckNet(pl *player) float64 {
	if pl.jackHost == nil {
		return 1
	}
	if !jackEntry(pl.jackHost) {
		return w.cyber.worstCableBW(pl.jackHost)
	}
	return pl.jackHost.netMbps
}

// worstCableBW — худший из кабелей устройства (§12.1: NET деки при «дорогом
// входе»); у бесшовных входов не вызывается. Запас 20 — устройство без
// кабелей в графе не бывает (кроме радио, а она точка входа).
func (cs *cyberState) worstCableBW(d *device) float64 {
	worst := 20.0
	first := true
	for _, n := range cs.neighbors(d.id) {
		if c := cs.cableBetween(d.id, n); c != nil && (first || c.bw < worst) {
			worst, first = c.bw, false
		}
	}
	return worst
}

// program — процесс на деке джекнутого хакера (§12.4). Прогресс — секунды
// «работы»; каждый тик растёт на dt/N запущенных (честные очереди: N
// программ = каждая в N раз медленнее) × сетевой фактор (§16.3: конкуренция
// за bw линков пути). path — цепочка устройств widest-path до цели
// (vulnscan/trojan, фиксируется на старте); portscan ест линки фронтира.
type program struct {
	id       int
	prog     string // portscan|vulnscan|trojan|watcher|firewall|antivirus|cp|rm
	dev      string // цель (пусто у portscan; у cp — ИСТОЧНИК, может быть "deck")
	work     float64
	progress float64
	path     []string
	// cp (§16.2): dst — приёмник ("deck" или id устройства), data — имя
	// item, mb — объём (резервация), mbps — номинальная бутылочка маршрута
	// (спрос на линках пути; доля ниже — фактор замедления).
	dst  string
	data string
	mb   int
	mbps float64
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

// interactTick — edge клавиши interact (space): джек-ин хакера у устройства
// (§12.5). Точка входа — мгновенно; прочие устройства — «дорогой вход»:
// канал ставится 6 с (jackChannelTick). Клиент ничего отдельного не шлёт.
func (w *world) interactTick(pl *player) {
	pressed := pl.keys.interact && !pl.prevInteract
	pl.prevInteract = pl.keys.interact
	if !pressed || !pl.alive || pl.jacked || pl.cls != "hacker" {
		return // дека только у хакера; мёртвые и уже джекнутые не входят
	}
	dev := w.jackTarget(pl)
	if dev == nil || jackEntry(dev) {
		if dev != nil {
			w.jackin(pl, dev)
		}
		return
	}
	// §12.1 «дорогой вход»: старт установки канала. Первый jackprog — сразу
	// (иначе клиент полсекунды без прогресса).
	pl.jacking = dev
	pl.jackT = 0
	w.sendTo(pl.id, message{"t": "jackprog", "dev": dev.id, "s": jackChannelWork})
}

// jackChannelTick — установка канала «дорогого входа» (§12.1): 6 с стояния
// рядом; смерть/отход из радиуса прерывают (прогресс не персистит), урон —
// нет. Прогресс — клиенту 2 Гц (jackprog). Отход — по горизонтали: порт
// может быть выше игрока (камера/клапан, см. jackTarget).
func (w *world) jackChannelTick(pl *player, dt float64) {
	if pl.jacking == nil {
		return
	}
	dev := pl.jacking
	dp := dev.pos.sub(pl.pos)
	dp[1] = 0
	if !pl.alive || pl.jacked || dp.length() > jackTerminalRadius+0.5 {
		pl.jacking = nil
		return
	}
	prevHalf := int(pl.jackT * 2)
	pl.jackT += dt
	if int(pl.jackT*2) != prevHalf && pl.jackT < jackChannelWork {
		w.sendTo(pl.id, message{"t": "jackprog", "dev": dev.id,
			"s": math.Round((jackChannelWork-pl.jackT)*10) / 10})
	}
	if pl.jackT >= jackChannelWork {
		pl.jacking = nil
		w.jackin(pl, dev)
	}
}

func (w *world) jackin(pl *player, dev *device) {
	// Точка входа — тоже сетевое устройство (§6): захвачена хакером ЧУЖОЙ
	// команды — джек-ин закрыт (contested, §12.5); терминал союзника открыт
	// (решение 2026-11-17: владение per-player, доступ — по команде, иначе
	// второй хакер команды заперт, плейтест 2026-11-16). Хозяин вне players
	// (сессия истекла) — считаем вражеским, безопаснее.
	// §12.1 «дорогой вход»: contested проверяем ТОЛЬКО у точек входа —
	// физический порт чужого устройства законом не закрыт, влез и ты внутри.
	// NB: firewall джек-ин не фильтрует (§13.5, редакция 2026-11-15):
	// защита сегмента, а не входа — замок убран.
	if jackEntry(dev) && dev.owner != 0 && dev.owner != pl.id {
		owner, ok := w.players[dev.owner]
		if !ok || owner.team != pl.team {
			w.denied(pl, "enemy_team", dev.id)
			return
		}
	}
	pl.jacked = true
	pl.jackHost = dev
	pl.jacking = nil
	pl.progs = nil
	net := dev.netMbps
	if !jackEntry(dev) {
		// §12.1 «дорогой вход»: NET деки = худший кабель устройства,
		// а не паспортные 100.
		net = w.cyber.worstCableBW(dev)
	}
	w.sendTo(pl.id, message{
		"t":    "jackin",
		"host": dev.id,
		"deck": message{"cpu": deckCPU, "npu": deckNPU, "ram": deckRAM, "net": net},
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
	w.fireWatchers(dev, pl, "jackin", "")
}

// fireWatchers — кибер-событие на устройстве с watcher'ами (§13.1): пишем
// запись в журнал (если watcher'ы есть), каждому живому хозяину — alert с
// контекстом ev/prog, плюс ретрансляция живым союзникам хозяина (№4). Мёртвым
// не шлём (триггеры гаснут, §5.5), но watcher не снимается: после респауна
// сработает без переустановки. Свои действия (who == хозяин) не триггерят.
func (w *world) fireWatchers(dev *device, who *player, ev, prog string) {
	if len(dev.watcherBy) == 0 {
		return
	}
	// Журнал — история устройства, пишется независимо от живости хозяев
	// (в т.ч. собственные события, §13.1).
	w.logWatcherEvent(dev, ev, who, prog)
	for ownerID := range dev.watcherBy {
		if ownerID == who.id {
			continue
		}
		owner, ok := w.players[ownerID]
		if !ok || !owner.alive {
			continue
		}
		w.sendWatcherAlert(owner, dev, who, ev, prog, false)
		w.relayWatcherAllies(owner, dev, who, ev, prog)
	}
}

// logWatcherEvent — запись в ring-buffer журнала устройства (§13.1 №1).
// Пишется только пока на устройстве есть хотя бы один watcher.
func (w *world) logWatcherEvent(dev *device, ev string, who *player, prog string) {
	if len(dev.watcherBy) == 0 {
		return
	}
	dev.log = append(dev.log, logEntry{Tick: w.tick, Ev: ev, Who: who.id, Prog: prog})
	if len(dev.log) > watcherLogCap {
		dev.log = dev.log[len(dev.log)-watcherLogCap:]
	}
}

// sendWatcherAlert — alert хозяину watcher'а (relay=false) или союзнику
// (relay=true). ev/prog — контекст события; prog omitempty.
func (w *world) sendWatcherAlert(to *player, dev *device, who *player, ev, prog string, relay bool) {
	m := message{"t": "alert", "dev": dev.id, "who": who.id, "src": "watcher", "ev": ev}
	if prog != "" {
		m["prog"] = prog
	}
	if relay {
		m["relay"] = true
	}
	w.sendTo(to.id, m)
}

// relayWatcherAllies — дубль alert'а живым СОЮЗНИКАМ хозяина watcher'а
// (§13.1 №4): та же команда, кроме самого хозяина и актора события. Мёртвым
// не шлём.
func (w *world) relayWatcherAllies(owner *player, dev *device, who *player, ev, prog string) {
	for _, ally := range w.players {
		if ally.id == owner.id || ally.id == who.id || !ally.alive || ally.team != owner.team {
			continue
		}
		w.sendWatcherAlert(ally, dev, who, ev, prog, true)
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

func (w *world) denied(pl *player, reason string, detail ...string) {
	// detail — только для лога (какая программа/цель отказана); на wire
	// не влияет (§9.2: denied = reason + optional dev).
	if len(detail) > 0 {
		log.Printf("room: player %d denied: %s (%s)", pl.id, reason, strings.Join(detail, " "))
	} else {
		log.Printf("room: player %d denied: %s", pl.id, reason)
	}
	w.sendTo(pl.id, message{"t": "denied", "reason": reason})
}

// dataDenied — отказ data-операции (cp/mv/rm, §16.2): на wire уходят prog и
// data, чтобы клиент мог показать отказ КОНКРЕТНОЙ карточкой (красный
// мигающий бар), а не безличным тостом. detail — как у denied, для лога.
func (w *world) dataDenied(pl *player, reason, prog, data string) {
	log.Printf("room: player %d denied: %s (%s %s)", pl.id, reason, prog, data)
	w.sendTo(pl.id, message{"t": "denied", "reason": reason, "prog": prog, "data": data})
}

// --- M5 данные: MEM-учёт и трансферы (§16.1/§16.2) ------------------------

// deckItemsUsed — занятый MEM деки: лежащие items + активные резервации
// cp В деку (программы джекнутого живы ровно пока трансфер, резервация
// освобождается вместе с программой — утечек нет по построению).
func (w *world) deckItemsUsed(pl *player) int {
	used := 0
	for _, it := range pl.items {
		used += it.MB
	}
	for _, q := range pl.progs {
		if (q.prog == "cp" || q.prog == "mv") && q.dst == "deck" {
			used += q.mb
		}
	}
	return used
}

// deckInventory — копия инвентаря деки для deck-сообщения (§16.1: data[]).
// Копия — marshal уходит в горутину записи, мутацию src.items в это время
// никто не трогает, но скан-путь делает так же (единый стиль, без гонок).
func deckInventory(pl *player) []dataItem {
	if len(pl.items) == 0 {
		return nil
	}
	return append([]dataItem(nil), pl.items...)
}

// hostMemFree — свободный MEM устройства (§16.2): ёмкость минус items минус
// резервации активных cp всех игроков в этот хост.
func (w *world) hostMemFree(dev *device) int {
	free := dev.mem
	for _, it := range dev.items {
		free -= it.MB
	}
	for _, pl := range w.players {
		for _, q := range pl.progs {
			if (q.prog == "cp" || q.prog == "mv") && q.dst == dev.id {
				free -= q.mb
			}
		}
	}
	return free
}

// hostHasItem / deckHasItem — для запрета дубликатов (denied dup).
func hostHasItem(dev *device, name string) bool {
	for _, it := range dev.items {
		if it.Name == name {
			return true
		}
	}
	return false
}

func deckHasItem(pl *player, name string) bool {
	for _, it := range pl.items {
		if it.Name == name {
			return true
		}
	}
	return false
}

// cpNominal — номинальная бутылочка маршрута (МБ/с): min по bw кабелей
// пути и backplane транзитных свитчей (§16.2; входной хоп дека↔хост не
// считается — как в bw-модели §16.3).
func (w *world) cpNominal(path []string) float64 {
	nominal := 0.0
	for i := 0; i+1 < len(path); i++ {
		a, b := path[i], path[i+1]
		if c := w.cyber.cableBetween(a, b); c != nil {
			if nominal == 0 || c.bw < nominal {
				nominal = c.bw
			}
		}
		if i > 0 {
			if sw := w.cyber.devices[a]; sw.kind == "switch" && sw.backplane > 0 {
				if nominal == 0 || sw.backplane < nominal {
					nominal = sw.backplane
				}
			}
		}
	}
	if nominal <= 0 {
		nominal = 1 // вырожденный путь — чтобы не делить на ноль
	}
	return nominal
}

// seedData — стартовые данные матча (итерация 2). door_key — ДВЕ копии,
// t1 и t2 (решение владельца 2026-11-17: rm честно удаляет навсегда,
// матч-киллер исключён второй копией; альтернативный путь без ключа —
// физический перебор d3 с подсказками §16.7). enc:true — код не читаем,
// decrypt придёт в итерации 4. Дом-door_key SRV1 появится в итерации 3.
// shieldMax — зарядов встроенного щита SRV (§16.5).
const shieldMax = 3

// shieldRegen — +1 заряд за 30 с от последнего отбоя (общий таймер на SRV,
// решение владельца «ну давай 30с»): прожжённое отрастает, долбить надо одним
// рывком.
const shieldRegen = 30 * time.Second

// shieldTick — реген щита SRV: от shieldAt, не больше shieldMax.
func (w *world) shieldRegenTick() {
	for _, d := range w.cyber.devices {
		if d.kind != "srv" || d.shield >= shieldMax || d.shieldAt.IsZero() {
			continue
		}
		now := w.now()
		n := int(now.Sub(d.shieldAt) / shieldRegen)
		if n <= 0 {
			continue
		}
		step := time.Duration(n) * shieldRegen
		d.shield = min(d.shield+n, shieldMax)
		d.shieldAt = d.shieldAt.Add(step)
		if d.shield >= shieldMax {
			d.shieldAt = time.Time{}
		}
	}
}

// hitShield — щит SRV отбивает попытку (vulnscan/trojan/софт): −1 заряд,
// таймер регена от последнего отбоя. true — отбито (нет зарядов = не отбито).
func (w *world) hitShield(pl *player, d *device, prog string) bool {
	if d.kind != "srv" || d.shield <= 0 || d.owner == pl.id {
		return false
	}
	if d.owner != 0 && w.sameTeam(w.players[d.owner], pl) {
		return false // §16.5: владелец и союзники щита не встречают
	}
	d.shield--
	d.shieldAt = w.now()
	w.dataDenied(pl, "shield", prog, "")
	log.Printf("room: SRV %s shield repelled %s by player %d (%d left)", d.id, prog, pl.id, d.shield)
	// watcher на SRV видит гринд (§16.5): ev shield — «гринд начался».
	w.fireWatchers(d, pl, "shield", prog)
	return true
}

// sameTeam — союзники ли (чистая проверка для щита).
func (w *world) sameTeam(a, b *player) bool {
	return a != nil && b != nil && a.team == b.team
}

// doorKeyName — имя поколения ключа (§16.5, ревизия 2026-11-18): данные —
// лут на время, старые поколения — мусор (контрится rm).
func doorKeyName(t time.Time) string {
	return "door_key" + t.Format("200601021504")
}

// doorKeyGen — ротация ключа на SRV1 (T=120 с по времени мира, детерминизм):
// новое поколение → на SRV1 кладётся свежий ключ; старые НЕ удаляются сами
// (они мусор: код мёртв, MEM занят, чистится rm — choke-стратегия).
const doorKeyRot = 120 * time.Second

// doorKeyCodeOf — 4-значный код d3 от имени поколения (детерминированно,
// FNV-1a: тесты и рестарты сервера дают тот же код для того же имени).
func doorKeyCodeOf(name string) string {
	hsh := uint32(2166136261)
	for i := 0; i < len(name); i++ {
		hsh ^= uint32(name[i])
		hsh *= 16777619
	}
	return fmt.Sprintf("%04d", int(hsh%10000))
}

func (w *world) doorKeyTick() {
	if w.matchStart.IsZero() || w.now().Sub(w.matchStart) < doorKeyRot {
		return
	}
	// generation index по миру: раз в doorKeyRot
	gen := int(w.now().Sub(w.matchStart) / doorKeyRot)
	if w.doorKeyGen == gen {
		return
	}
	w.doorKeyGen = gen
	srv := w.cyber.devices[w.doorKeyHost]
	if srv == nil {
		return
	}
	name := doorKeyName(w.now())
	for _, it := range srv.items {
		if it.Name == name {
			return // такое поколение уже лежит (минута та же)
		}
	}
	srv.items = append(srv.items, dataItem{Name: name, MB: 60, Enc: true})
	// грейс: предыдущее поколение валидно ещё одну ротацию (§16.7)
	w.doorKeyPrevCode = w.doorKeyCode
	w.doorKeyCode = doorKeyCodeOf(name)
	w.doorKeyName = name
	log.Printf("room: door_key rotated -> %s on %s", name, srv.id)
}

// doorKeyValidCodes — код d3 валиден для текущего и предыдущего поколения
// (грейс одна ротация, §16.7): ротация за 2 с до ввода — не плевок в лицо.
func (w *world) doorKeyValid(pl *player, code string) bool {
	if code == w.doorKeyCode {
		return true
	}
	return w.doorKeyPrevCode != "" && code == w.doorKeyPrevCode
}

// seedData — стартовые данные матча (§16.1): одно поколение door_key на SRV1.
// Код d3 генерится здесь же (doorKeyCode), предыдущий пуст.
func (w *world) seedData() {
	if w.doorKeyHost == "" {
		w.doorKeyHost = "srv1"
	}
	srv := w.cyber.devices[w.doorKeyHost]
	if srv == nil {
		return
	}
	w.matchStart = w.now()
	w.doorKeyGen = 0
	w.doorKeyName = doorKeyName(w.now())
	w.doorKeyCode = doorKeyCodeOf(w.doorKeyName)
	// идемпотентно: повторный seed (рестарт матча) не плодит копию поколения
	for _, it := range srv.items {
		if it.Name == w.doorKeyName {
			return
		}
	}
	srv.items = append(srv.items, dataItem{Name: w.doorKeyName, MB: 60, Enc: true})
}

// cpCancelled — трансфер умер (§16.2 «отмена»): сменился владелец
// src/dst, или чужой firewall встал на линке зафиксированного маршрута.
func (w *world) cpCancelled(pl *player, p *program) bool {
	// src: p.dev — устройство или "deck".
	if p.dev != "deck" {
		src, ok := w.cyber.devices[p.dev]
		if !ok || src.owner != pl.id {
			return true
		}
	}
	if p.dst != "deck" {
		dst, ok := w.cyber.devices[p.dst]
		if !ok || dst.owner != pl.id {
			return true
		}
	}
	// Чужой firewall на любом устройстве зафиксированного маршрута —
	// тот же предикат, что и у widestPath на старте (согласованность §16.2).
	for i := range p.path {
		if dev := w.cyber.devices[p.path[i]]; dev != nil && w.firewallBlocksThrough(dev, pl) {
			return true
		}
	}
	return false
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
	// §16.2: cp/mv/rm — данные-программы со своей семантикой (MEM, владельцы,
	// маршрут). Валидируются отдельно и уходят со своими полями. Ревизия 3:
	// cp — копия (источник хранит экземпляр), mv — перенос.
	if prog == "cp" || prog == "mv" {
		w.handleCp(pl, str(msg, "dev"), str(msg, "dst"), str(msg, "data"), prog)
		return
	}
	if prog == "rm" {
		w.handleRm(pl, str(msg, "dev"), str(msg, "data"))
		return
	}
	work := progWork(prog)
	if work == 0 {
		return // неизвестная программа — мусор в протоколе, игнорируем
	}
	devID := str(msg, "dev")
	if len(pl.progs) >= deckRAM {
		w.denied(pl, "ram_full", prog, devID)
		return
	}
	if prog != "portscan" {
		dev, ok := w.cyber.devices[devID]
		// Цель должна быть обнаружена (scanned — туман войны portscan'а) И
		// оставаться достижимой по текущей сети — достижимость per-player:
		// чужой firewall на транзитном устройстве отрезает цель (§13.5).
		if !ok || !pl.scanned[devID] || !w.reachableFor(pl.jackHost.id, pl)[devID] {
			w.denied(pl, "too_far", prog, devID)
			return
		}
		if prog == "trojan" && !dev.vulnedBy[pl.id] {
			w.denied(pl, "not_vulned", prog, devID)
			return
		}
		// §16.5: встроенный щит SRV отбивает попытки взлома (−1 заряд). Стоит
		// ПОСЛЕ not_vulned: сначала отмычка, потом щит.
		if w.hitShield(pl, dev, prog) {
			return
		}
		// Решение владельца (c) 2026-11-16 «vulnscan = отмычка»: утилиты
		// (watcher/firewall/antivirus) на ЧУЖИХ/НЕЙТРАЛЬНЫХ устройствах тоже
		// требуют найденной уязвимости — установка софта на не-своё это тот же
		// взлом. На своих (трояновых) — свободно: админишь без отмычки.
		if (prog == "watcher" || prog == "firewall" || prog == "antivirus") &&
			dev.owner != pl.id && !dev.vulnedBy[pl.id] {
			w.denied(pl, "not_vulned", prog, devID)
			return
		}
		// NB: firewall ставится на любое сетевое устройство (§13.5, ред.
		// плейтеста M3 2026-11-15): switch режет транзитные линки, конечные
		// устройства — чужой доступ через них. kind-ограничения нет.
	}
	// §16.2/§16.3: путь widest-path к цели фиксируется на старте (чужие
	// firewall'ы исключают транзит; бутылочка = bw кабелей + backplane
	// транзитных свитчей). Сегментация в пути согласована с reachableFor —
	// цель уже прошла проверку достижимости выше.
	var path []string
	if prog != "portscan" {
		blocked := func(id string) bool {
			return w.firewallBlocksThrough(w.cyber.devices[id], pl)
		}
		path = w.cyber.widestPath(pl.jackHost.id, devID, blocked)
	}
	pl.progs = append(pl.progs, &program{id: pl.nextProgID, prog: prog, dev: devID, work: work, path: path})
	pl.nextProgID++
	log.Printf("room: player %d run %s %s", pl.id, prog, devID)
}

// handleCp — §16.2: {"t":"run","prog":"cp|mv","dev":src,"dst":deck|id}.
// Контроль src/dst (трояновый хост или дека), не-дубликат, MEM приёмника с
// резервацией (denied mem_full), маршрут widest-path, скорость = бутылочка.
// prog различает судьбу источника на финише: mv уносит item, cp оставляет.
func (w *world) handleCp(pl *player, srcID, dstID, dataName, prog string) {
	if srcID == "" || dstID == "" {
		w.denied(pl, "too_far", prog, srcID)
		return
	}
	// Источник: своя дека или трояновый хост (перехват чужих данных §16.1).
	var srcDev *device
	var it dataItem
	if srcID == "deck" {
		if dataName == "" || !deckHasItem(pl, dataName) {
			w.dataDenied(pl, "too_far", prog, dataName)
			return
		}
		for _, x := range pl.items {
			if x.Name == dataName {
				it = x
			}
		}
	} else {
		d, ok := w.cyber.devices[srcID]
		if !ok || !pl.scanned[srcID] || d.owner != pl.id {
			w.dataDenied(pl, "not_owner", prog, dataName)
			return
		}
		if dataName == "" {
			if len(d.items) == 0 {
				w.dataDenied(pl, "too_far", prog, dataName)
				return
			}
			it = d.items[0] // один item по умолчанию (данные с осмысленными именами)
		} else {
			found := false
			for _, x := range d.items {
				if x.Name == dataName {
					it, found = x, true
				}
			}
			if !found {
				w.dataDenied(pl, "too_far", prog, dataName)
				return
			}
		}
		srcDev = d
	}
	// Приёмник: дека или свой хост.
	dstDeck := dstID == "deck"
	var dstDev *device
	if !dstDeck {
		d, ok := w.cyber.devices[dstID]
		if !ok || !pl.scanned[dstID] || d.owner != pl.id {
			w.dataDenied(pl, "not_owner", prog, dataName)
			return
		}
		dstDev = d
	}
	// Дубликаты запрещены (denied dup, §16.2). Ревизия 3 (cp=копия):
	// точный повтор (тот же src+dst+data) — всегда dup; два mv одного item
	// с одного источника — dup (второй на финише нашёл бы источник пустым);
	// cp того же item на другой приёмник легальна — копии множатся.
	for _, q := range pl.progs {
		if (q.prog == "cp" || q.prog == "mv") && q.dev == srcID && q.data == it.Name {
			if q.dst == dstID || (prog == "mv" && q.prog == "mv") {
				w.dataDenied(pl, "dup", prog, it.Name)
				return
			}
		}
	}
	if dstDeck && deckHasItem(pl, it.Name) {
		w.dataDenied(pl, "dup", prog, it.Name)
		return
	}
	if !dstDeck && hostHasItem(dstDev, it.Name) {
		w.dataDenied(pl, "dup", prog, it.Name)
		return
	}
	// Маршрут: src→jackHost (слив в деку) или src→dst; входной хоп дека↔хост
	// не считается (§16.3) — route от src к точке входа деки.
	routeDst := dstID
	if dstDeck {
		routeDst = pl.jackHost.id
	}
	blocked := func(x string) bool { return w.firewallBlocksThrough(w.cyber.devices[x], pl) }
	var path []string
	mbps := 0.0
	if routeDst == srcID || (srcDev == nil && routeDst == pl.jackHost.id) {
		// Локальный трансфер (источник/приёмник совпадает с точкой входа
		// деки): сеть не участвует, полоса = входной канал хоста (§16.3:
		// входной хоп дека↔точка входа не в модели).
		mbps = w.cyber.worstCableBW(pl.jackHost)
	} else {
		from := srcID
		if srcDev == nil { // deck: маршрут начинается от точки входа (§16.3)
			from = pl.jackHost.id
		}
		path = w.cyber.widestPath(from, routeDst, blocked)
		if len(path) == 0 {
			w.dataDenied(pl, "too_far", prog, dataName)
			return
		}
		mbps = w.cpNominal(path)
	}
	// MEM приёмника с резервацией: mem_free падает сразу (два трансфера не
	// проталкиваются в один объём), отказ mem_full до старта.
	if dstDeck {
		if w.deckItemsUsed(pl)+it.MB > deckMEM {
			w.dataDenied(pl, "mem_full", prog, dataName)
			return
		}
	} else if w.hostMemFree(dstDev) < it.MB {
		w.dataDenied(pl, "mem_full", prog, dataName)
		return
	}
	p := &program{
		id: pl.nextProgID, prog: prog,
		dev: srcID, dst: dstID, data: it.Name, mb: it.MB,
		work: float64(it.MB) / mbps, // прогресс в секундах чистой полосы
		path: path, mbps: mbps,
	}
	pl.progs = append(pl.progs, p)
	pl.nextProgID++
	log.Printf("room: player %d run %s %s->%s %s (%dMB @%vMBps)", pl.id, prog, srcID, dstID, it.Name, it.MB, mbps)
	// Watcher-событие job (старт трансфера на устройстве, §16.9).
	if srcDev != nil {
		w.fireWatchers(srcDev, pl, "job", prog)
	}
}

// handleRm — §16.2: удаление данных с хоста/деки, 0.5 с, только владелец
// (trojan) или своя дека. chaff-игра: слить → rm → слить снова.
func (w *world) handleRm(pl *player, devID, dataName string) {
	if dataName == "" {
		return
	}
	if devID == "deck" {
		if !deckHasItem(pl, dataName) {
			w.dataDenied(pl, "too_far", "rm", dataName)
			return
		}
		p := &program{id: pl.nextProgID, prog: "rm", dev: devID, data: dataName, work: rmWork}
		pl.progs = append(pl.progs, p)
		pl.nextProgID++
		log.Printf("room: player %d run rm deck %s", pl.id, dataName)
		return
	}
	dev, ok := w.cyber.devices[devID]
	if !ok || !pl.scanned[devID] || dev.owner != pl.id || !hostHasItem(dev, dataName) {
		w.dataDenied(pl, "not_owner", "rm", dataName)
		return
	}
	p := &program{id: pl.nextProgID, prog: "rm", dev: devID, data: dataName, work: rmWork}
	pl.progs = append(pl.progs, p)
	pl.nextProgID++
	log.Printf("room: player %d run rm %s %s", pl.id, devID, dataName)
}

// handleCtrl — {"t":"ctrl"} (§12.5): toggle двери; §14.2 — тот же контроллер
// у газа (вентиль). Только владелец trojan, лично и из hacker view
// (джекнутый), и пока устройство достижимо от точки входа — перерубленный
// кабель отрезает и управление (контр-хакинг §6).
func (w *world) handleCtrl(pl *player, msg message) {
	if !pl.alive {
		return
	}
	if !pl.jacked {
		w.denied(pl, "not_jacked")
		return
	}
	dev, ok := w.cyber.devices[str(msg, "dev")]
	if !ok || (dev.kind != "door" && dev.kind != "gas" && dev.kind != "valve") || dev.owner != pl.id {
		w.denied(pl, "not_owner", str(msg, "action"), str(msg, "dev"))
		return
	}
	if !w.reachableFor(pl.jackHost.id, pl)[dev.id] {
		w.denied(pl, "too_far", str(msg, "action"), dev.id)
		return
	}
	if str(msg, "action") != "toggle" {
		return
	}
	dev.open = !dev.open // snap.props разнесёт всем (§12.5)
	if dev.kind == "gas" {
		// §14.2: взвод ставит телеграф-таймер и обнуляет накопленный долг
		// (close→open рестартит телеграф); снятие гасит мгновенно.
		if dev.open {
			dev.gasArmAt = w.now()
			dev.gasArmCount++
		} else {
			dev.gasArmAt = time.Time{}
		}
	}
	log.Printf("room: player %d ctrl %s -> open=%v", pl.id, dev.id, dev.open)
}

// computeNetFactors — сетевой фактор прогресса каждой активной программы на
// тик (§16.3, ревизия 1: честные очереди НА ЛИНКАХ — сетевой аналог
// планировщика CPU §5.1). Каждый скан заявляет спрос: portscan 2 МБ/с на
// каждый линк фронтира распространения, vulnscan/trojan 4 МБ/с на линках
// зафиксированного widest-path (кабели + backplane транзитных свитчей).
// Доля линка = bw/N потребителей; если доля < спроса — прогресс
// масштабируется (доля/спрос), иначе полная скорость. Тяжёлый слив (M5
// итерация 2) станет ещё одним потребителем — chaff-контрига из §16.3.
func (w *world) computeNetFactors() map[*program]float64 {
	type netLink struct {
		bw      float64
		demands map[*program]float64
	}
	links := map[string]*netLink{}
	addUse := func(p *program, key string, bw, demand float64) {
		l, ok := links[key]
		if !ok {
			l = &netLink{bw: bw, demands: map[*program]float64{}}
			links[key] = l
		}
		if _, seen := l.demands[p]; !seen {
			l.demands[p] = demand
		}
	}
	for _, pl := range w.players {
		if !pl.jacked || pl.jackHost == nil {
			continue
		}
		for _, p := range pl.progs {
			switch p.prog {
			case "portscan":
				// Фронтир распространения: рёбра от известных устройств к
				// достижимым соседям (per-player, §13.5) + шины свитчей.
				reach := w.reachableFor(pl.jackHost.id, pl)
				for id := range pl.scanned {
					if !reach[id] {
						continue
					}
					if sw := w.cyber.devices[id]; sw.kind == "switch" && sw.backplane > 0 {
						addUse(p, "b:"+id, sw.backplane, scanDemandPortscan)
					}
					for _, n := range w.cyber.neighbors(id) {
						if !reach[n] {
							continue
						}
						if c := w.cyber.cableBetween(id, n); c != nil {
							addUse(p, "c:"+c.id, c.bw, scanDemandPortscan)
						}
					}
				}
			case "vulnscan", "trojan":
				for i := 0; i+1 < len(p.path); i++ {
					a, b := p.path[i], p.path[i+1]
					if c := w.cyber.cableBetween(a, b); c != nil {
						addUse(p, "c:"+c.id, c.bw, scanDemandPath)
					}
					if i > 0 {
						if sw := w.cyber.devices[a]; sw.kind == "switch" && sw.backplane > 0 {
							addUse(p, "b:"+a, sw.backplane, scanDemandPath)
						}
					}
				}
			case "cp", "mv":
				// §16.2: трансфер ест свои МБ/с на линках маршрута — тот же
				// честный пул, что и сканы (chaff-контрига §16.3).
				for i := 0; i+1 < len(p.path); i++ {
					a, b := p.path[i], p.path[i+1]
					if c := w.cyber.cableBetween(a, b); c != nil {
						addUse(p, "c:"+c.id, c.bw, p.mbps)
					}
					if i > 0 {
						if sw := w.cyber.devices[a]; sw.kind == "switch" && sw.backplane > 0 {
							addUse(p, "b:"+a, sw.backplane, p.mbps)
						}
					}
				}
			}
		}
	}
	factors := make(map[*program]float64)
	for _, pl := range w.players {
		for _, p := range pl.progs {
			factors[p] = 1
		}
	}
	for _, l := range links {
		n := len(l.demands)
		alloc := l.bw / float64(n) // честная доля каждого потребителя линка
		for p, demand := range l.demands {
			if demand > 0 && alloc < demand {
				factors[p] = math.Min(factors[p], alloc/demand)
			}
		}
	}
	return factors
}

// cyberTick — честные очереди (§12.4): доля каждой программы = 1/N ×
// сетевой фактор линков (§16.3); завершённые выполняют эффект и покидают
// деку.
func (w *world) cyberTick(pl *player, dt float64) {
	if !pl.jacked || len(pl.progs) == 0 {
		return
	}
	share := dt / float64(len(pl.progs))
	var finished []*program
	var cancelled []*program
	for _, p := range pl.progs {
		// §16.2 «отмена трансфера»: сменился владелец src/dst, чужой firewall
		// на маршруте — прогресс теряется («либо прошло, либо нет»).
		if (p.prog == "cp" || p.prog == "mv") && w.cpCancelled(pl, p) {
			cancelled = append(cancelled, p)
			continue
		}
		f := w.netF[p]
		if f <= 0 {
			f = 1
		}
		p.progress += share * f
		if p.progress >= p.work {
			finished = append(finished, p)
		}
	}
	for _, p := range cancelled {
		for i, q := range pl.progs {
			if q == p {
				pl.progs = append(pl.progs[:i], pl.progs[i+1:]...)
				break
			}
		}
		log.Printf("room: cp %s->%s cancelled (owner/firewall changed)", p.dev, p.dst)
		w.sendTo(pl.id, message{"t": "denied", "reason": "cp_cancel", "dev": p.dev})
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
			// Сканер тоже не молчит (плейтест M4): уведомление об усечении
			// скана — скан при этом не отменяется (открытое остаётся открытым).
			w.sendTo(pl.id, message{"t": "denied", "reason": "firewall_scan", "dev": hit.id})
			if owner, ok := w.players[hit.firewalled]; ok && owner.alive {
				w.sendTo(hit.firewalled, message{"t": "alert", "dev": hit.id, "who": pl.id, "src": "firewall"})
			}
			// §13.1 №1: упор скана в firewall — запись журнала устройства
			// (если на нём есть watcher). Alert watcher'а НЕ шлём: это
			// событие firewall, а не watcher-триггер.
			w.logWatcherEvent(hit, "scanhit", pl, "")
		}
		w.sendScan(pl)
	case "vulnscan":
		if dev := w.cyber.devices[p.dev]; dev != nil {
			dev.vulnedBy[pl.id] = true // M2: навсегда (§12.4)
			w.sendScan(pl)             // обновить карту: узел помечается «уязвимо»
		}
	case "cp", "mv":
		// §16.2 ревизия 3: mv — item переезжает в MEM приёмника (уходит из
		// источника), cp — копируется (источник хранит экземпляр, MEM занят
		// на обеих сторонах). Резервация освобождается вместе с программой.
		// Отмена невозможна здесь — cyberTick отменил бы раньше финиша.
		// Гард на финиш: два cp одного item с РАЗНЫХ источников в один
		// приёмник могли пройти стартовые dup (друг друга в полёте не видели)
		// — дубль не кладём, denied dup (для mv — item остаётся в источнике).
		dstHas := false
		if p.dst == "deck" {
			dstHas = deckHasItem(pl, p.data)
		} else if dst := w.cyber.devices[p.dst]; dst != nil {
			dstHas = hostHasItem(dst, p.data)
		}
		if dstHas {
			w.dataDenied(pl, "dup", p.prog, p.data)
			break
		}
		if p.dst == "deck" {
			if src := w.cyber.devices[p.dev]; src != nil {
				for i, it := range src.items {
					if it.Name == p.data {
						pl.items = append(pl.items, it)
						if p.prog == "mv" {
							src.items = append(src.items[:i], src.items[i+1:]...)
						}
						break
					}
				}
			}
		} else if dst := w.cyber.devices[p.dst]; dst != nil {
			// deck→host (chaff) и host→host.
			if p.dev == "deck" {
				for i, it := range pl.items {
					if it.Name == p.data {
						dst.items = append(dst.items, it)
						if p.prog == "mv" {
							pl.items = append(pl.items[:i], pl.items[i+1:]...)
						}
						break
					}
				}
			} else if src := w.cyber.devices[p.dev]; src != nil {
				for i, it := range src.items {
					if it.Name == p.data {
						dst.items = append(dst.items, it)
						if p.prog == "mv" {
							src.items = append(src.items[:i], src.items[i+1:]...)
						}
						break
					}
				}
			}
		}
		w.sendScan(pl) // листинг/память приёмника-источника обновить
		if src := w.cyber.devices[p.dev]; src != nil {
			w.fireWatchers(src, pl, "job", p.prog)
		}
	case "rm":
		// §16.2: item удаляется (chaff: слить → rm → слить снова).
		if p.dev == "deck" {
			for i, it := range pl.items {
				if it.Name == p.data {
					pl.items = append(pl.items[:i], pl.items[i+1:]...)
					break
				}
			}
		} else if dev := w.cyber.devices[p.dev]; dev != nil {
			for i, it := range dev.items {
				if it.Name == p.data {
					dev.items = append(dev.items[:i], dev.items[i+1:]...)
					break
				}
			}
			w.resendScanFor(p.dev)
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
			// §13.1 №2: один alert на событие. Завершённый чужой trojan —
			// это «смена владельца» (ev=owner) либо «установка» (ev=install),
			// если владелец не изменился (повторный trojan на своё).
			ownerChanged := dev.owner != pl.id
			dev.owner = pl.id // userland; двери дают владельцу toggle
			// §13.5: новый trojan выкуривает чужой firewall — обход без
			// тупика (взломщик получает и владение, и открытый вход).
			if dev.firewalled != 0 && dev.firewalled != pl.id {
				dev.firewalled = 0
			}
			// Кибер-событие для watcher'ов. Пишем до resendScanFor, чтобы
			// журнал уехал в scan одним сообщением.
			if ownerChanged {
				w.fireWatchers(dev, pl, "owner", "trojan")
			} else {
				w.fireWatchers(dev, pl, "install", "trojan")
			}
			w.resendScanFor(p.dev)
		}
	case "watcher":
		// §13.1: триггер живёт на устройстве (как trojan), слот RAM освобождён.
		if dev := w.cyber.devices[p.dev]; dev != nil {
			dev.watcherBy[pl.id] = true
			// §13.1 №2: чужой watcher на устройстве с моим — событие install
			// (пишем до resendScanFor; свой watcher себя не триггерит).
			w.fireWatchers(dev, pl, "install", "watcher")
			w.resendScanFor(p.dev) // на карте появится отметка watched
		}
	case "firewall":
		// §13.5: фильтр живёт на устройстве (как trojan), слот RAM освобождён.
		// Повторная установка тем же хакером — no-op (один firewall на девайс).
		if dev := w.cyber.devices[p.dev]; dev != nil {
			dev.firewalled = pl.id
			// §13.1 №2: установка firewall — кибер-событие для watcher'ов
			// (ev=install). Пишем до rescan, чтобы журнал уехал в scan.
			w.fireWatchers(dev, pl, "install", "firewall")
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
			// §13.6 (ред. 2026-11-17): установка antivirus стирает ЧУЖИЕ
			// vuln-метки («пере-вскрытие после AV») — устройство откатывается
			// в закрытое состояние; свой метка остаётся (он вскрыл, чтобы
			// поставить). Правка M2 «навсегда»: навсегда, пока не встал AV.
			for uid := range dev.vulnedBy {
				if uid != pl.id {
					delete(dev.vulnedBy, uid)
				}
			}
			// §13.1 №2: установка antivirus — кибер-событие для watcher'ов
			// (ev=install); wipe чужих меток — отдельная строка журнала.
			w.fireWatchers(dev, pl, "install", "antivirus")
			w.logWatcherEvent(dev, "wipe", pl, "antivirus")
			w.resendScanFor(p.dev) // ореол antivirused + vulned=false у чужих
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

// scanNetLink — bw одного линка устройства (§16.9, итерация 1.5): МБ/с для
// UI табов и ширины линий карты деки.
type scanNetLink struct {
	ID   string  `json:"id"`
	Mbps float64 `json:"mbps"`
}

type scanDevice struct {
	ID    string   `json:"id"`
	Kind  string   `json:"kind"`
	X     float64  `json:"x"`
	Y     float64  `json:"y"`
	Z     float64  `json:"z"`
	Owner any      `json:"owner"` // null = нейтральное
	Links []string `json:"links"`
	// Net — bw каждого линка (параллелен Links, §16.3); omitempty: одноэтажные
	// мини-карты тестов без bw в UI не несут лишнего.
	Net []scanNetLink `json:"net,omitempty"`
	// Bp — backplane свитча, МБ/с (§16.3); omitempty: только switch.
	Bp float64 `json:"bp,omitempty"`
	// Vulned — уязвимость, найденная МОИМ vulnscan'ом (для этого хакера);
	// omitempty: поле появляется только когда true (§12.5, доп. 2026-11-14).
	Vulned bool `json:"vulned,omitempty"`
	// Watched — на устройстве стоит МОЙ watcher-триггер (§13.2), omitempty.
	Watched bool `json:"watched,omitempty"`
	// Log — журнал событий watcher'а (§13.1 №1, §13.2): только для устройств
	// с МОИМ watcher'ом (не раздуваем трафик остальным); omitempty.
	Log []logEntry `json:"log,omitempty"`
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
	// Mem/MemFree — MEM-хранилище данных: ёмкость и свободно (§16.9, МБ).
	// memFree динамический: items + резервации активных cp. Видны всем,
	// кто открыл устройство (объём — наблюдаемая вещь).
	Mem     int `json:"mem,omitempty"`
	MemFree int `json:"memFree,omitempty"`
	// Data — листинг данных (§16.9): ТОЛЬКО владельцу (trojan) — чужой
	// состав не раскрываем (иначе перехват теряет ценность).
	Data []dataItem `json:"data,omitempty"`
	// Soft — состав резидентного софта с хозяевами (§9.2, ред. 2026-11-17):
	// [{p:"trojan|watcher|firewall|antivirus", o:id}]; omitempty. Виден
	// ТОЛЬКО владельцу устройства (трояновому хозяину) — чужой состав не
	// раскрываем, иначе watcher/firewall теряют ценность (панель «ПРОЦЕССЫ»).
	Soft []scanSoft `json:"soft,omitempty"`
}

// scanSoft — одна запись списка процессов устройства (панель «ПРОЦЕССЫ»,
// §13.1): программа + хозяин процесса.
type scanSoft struct {
	P string `json:"p"`
	O uint64 `json:"o"`
}

// sortedWatcherUIDs — детерминированный порядок обхода watcherBy (снапшоты
// сканов стабильны между тиками).
func sortedWatcherUIDs(m map[uint64]bool) []uint64 {
	uids := make([]uint64, 0, len(m))
	for uid := range m {
		uids = append(uids, uid)
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })
	return uids
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
		if d.kind == "switch" && d.backplane > 0 {
			sd.Bp = d.backplane
		}
		if d.mem > 0 {
			sd.Mem = d.mem
			sd.MemFree = w.hostMemFree(d)
		}
		if d.owner == pl.id && len(d.items) > 0 {
			sd.Data = append([]dataItem(nil), d.items...)
		}
		for _, n := range sd.Links {
			if c := w.cyber.cableBetween(id, n); c != nil {
				sd.Net = append(sd.Net, scanNetLink{ID: n, Mbps: c.bw})
			}
		}
		if d.owner != 0 {
			sd.Owner = d.owner
		}
		// Состав софта — только владельцу устройства (§9.2): trojan (он сам)
		// + резидентные процессы с хозяевами. Порядок стабильный.
		if d.owner == pl.id {
			sd.Soft = append(sd.Soft, scanSoft{P: "trojan", O: d.owner})
			if d.firewalled != 0 {
				sd.Soft = append(sd.Soft, scanSoft{P: "firewall", O: d.firewalled})
			}
			if d.antivirused != 0 {
				sd.Soft = append(sd.Soft, scanSoft{P: "antivirus", O: d.antivirused})
			}
			for _, uid := range sortedWatcherUIDs(d.watcherBy) {
				sd.Soft = append(sd.Soft, scanSoft{P: "watcher", O: uid})
			}
		}
		if d.vulnedBy[pl.id] {
			sd.Vulned = true
		}
		if d.watcherBy[pl.id] {
			sd.Watched = true
			// Журнал — только хозяину watcher'а (§13.1 №1); копия, чтобы
			// будущий append не задел уже отправленный срез.
			if len(d.log) > 0 {
				sd.Log = append([]logEntry(nil), d.log...)
			}
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
	// cp (§16.9): приёмник, остаток данных и текущая скорость (МБ/с с
	// учётом доли канала) — прогресс-бар трансфера в деке.
	Dst    string  `json:"dst,omitempty"`
	Data   string  `json:"data,omitempty"`
	MbLeft int     `json:"mbLeft,omitempty"`
	Mbps   float64 `json:"mbps,omitempty"`
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
			f := w.netF[pr]
			if f <= 0 {
				f = 1
			}
			// ETA при текущих долях: CPU-очередь (×N) × канал (÷f, §16.3)
			remain := (pr.work - pr.progress) * float64(n) / f
			if remain < 0 {
				remain = 0
			}
			dp := deckProg{ID: pr.id, Prog: pr.prog, Dev: pr.dev, EtaMs: int64(remain * 1000)}
			if pr.prog == "cp" || pr.prog == "mv" {
				// §16.9: остаток МБ и текущая скорость (доля канала × номинал)
				dp.Dst = pr.dst
				dp.Data = pr.data
				dp.MbLeft = int(math.Ceil(float64(pr.mb) * (1 - pr.progress/pr.work)))
				dp.Mbps = round3(pr.mbps * f / float64(n))
			}
			progs = append(progs, dp)
		}
		w.sendTo(p.id, message{
			"t":       "deck",
			"cpuLoad": round3(math.Min(1, float64(n)/deckRAM)),
			"npuLoad": 0.0, // NPU-программ в M2 нет
			"ramUsed": n,
			// §16.1: MEM деки — занято данными + резервациями (МБ)
			"memUsed": w.deckItemsUsed(p),
			"mem":     deckMEM,
			// §16.1: инвентарь деки — только владельцу, живёт пока джекнут
			"data":    deckInventory(p),
			// §12.1 «дорогой вход»: канал не-точки входа — худший кабель, а
			// не паспортный netMbps устройства.
			"netLoad": round3(math.Min(1, float64(n)*progNetMbps/w.deckNet(p))),
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

// radarWho — один джекнутый хакер в радар-срезе (§13.1 №3): кто + точка входа.
type radarWho struct {
	ID   uint64 `json:"id"`
	Name string `json:"name"`
	Team int    `json:"team"`
	Cls  string `json:"cls"`
	Host string `json:"host"`
}

// radarFeedTick — радар «жучок» 1 Гц (§13.1 №3): каждому живому хозяину
// watcher'а (джекнут или нет — как лента камеры, §5.5) по каждому его
// устройству — срез джекнутых хакеров в сегменте, достижимом BFS ОТ этого
// устройства. Достижимость per-player (§13.5): чужой firewall режет видимость
// радара — сегментация работает против разведки. Сам хозяин в срез не входит;
// пустой срез тоже шлётся (UI: «сегмент чист»).
func (w *world) radarFeedTick() {
	if w.tick%radarFeedEvery != 0 {
		return
	}
	for _, id := range w.cyber.order {
		dev := w.cyber.devices[id]
		if len(dev.watcherBy) == 0 {
			continue
		}
		for ownerID := range dev.watcherBy {
			owner, ok := w.players[ownerID]
			if !ok || !owner.alive {
				continue
			}
			reach := w.reachableFor(dev.id, owner)
			who := make([]radarWho, 0, 4)
			for _, pl := range w.players {
				if pl.id == ownerID || !pl.alive || !pl.jacked || pl.jackHost == nil {
					continue
				}
				if !reach[pl.jackHost.id] {
					continue // за чужим firewall / вне сегмента — радар не видит
				}
				who = append(who, radarWho{
					ID: pl.id, Name: pl.name, Team: pl.team, Cls: pl.cls, Host: pl.jackHost.id,
				})
			}
			w.sendTo(ownerID, message{"t": "radar", "dev": dev.id, "who": who})
		}
	}
}

// gasTick — §14.2: DoT газовых ловушек, комната-горутина, после cyberTick,
// до broadcastSnap. Для каждого газа с открытым вентилем: пока идёт
// телеграф (первые gasTelegraph после взвода) — урона нет; иначе каждый
// живой игрок, чей AABB пересекает объём пропа, копит float-долг, и при
// переполнении получает урон целыми очками (FF ON, мёртвым — ничего). Долг
// сбрасывается при смене момента взвода (close→open рестартит телеграф).
func (w *world) gasTick(dt float64) {
	if len(w.cyber.gases) == 0 {
		return
	}
	now := w.now()
	for _, g := range w.cyber.gases {
		if !g.open {
			continue
		}
		if g.gasArmAt.IsZero() || now.Sub(g.gasArmAt) < gasTelegraph {
			continue
		}
		for _, pl := range w.players {
			if !pl.alive || !boxesOverlap(playerBoxAt(pl.pos), g.box) {
				continue
			}
			key := gasDebtKey{dev: g.id, arm: g.gasArmCount, pl: pl.id}
			debt, ok := w.gasDebt[key]
			if !ok { // свежий ключ: первый тик внутри объёма не начисляет — долг с нуля
				w.gasDebt[key] = gasDPS * dt
				continue
			}
			debt += gasDPS * dt
			whole := int(debt)
			if whole > 0 {
				debt -= float64(whole)
				w.envDamage(pl, whole, g.owner)
			}
			w.gasDebt[key] = debt
		}
	}
}

// fireTick — §14.6.1: DoT огненных полос, комната-горутина, сразу после
// gasTick. Ревизия v1: полоса горит только пока её водяной клапан закрыт
// (open=true — вода идёт, пул потушен); остальная механика v0 без изменений:
// без телеграфа, игрок «в огне», если его AABB ног (playerBoxAt) пересекает
// объём по всем трём осям (этажи не смешиваются). Float-долг на (пул,
// игрок), целые списания envDamage(owner=0) — килл чисто средовой
// («ЛОВУШКА», счёт не двигается). Первый тик в полосе только сеет долг.
func (w *world) fireTick(dt float64) {
	if len(w.cyber.fires) == 0 {
		return
	}
	for _, lv := range w.cyber.fires {
		if lv.valve != nil && lv.valve.open {
			continue // вода идёт — полоса потушена (§14.6.1)
		}
		for _, pl := range w.players {
			if !pl.alive || !boxesOverlap(playerBoxAt(pl.pos), lv.box) {
				continue
			}
			key := fireDebtKey{pool: lv.id, pl: pl.id}
			debt, ok := w.fireDebt[key]
			if !ok { // свежий ключ: первый тик внутри полосы не начисляет
				w.fireDebt[key] = lavaDPS * dt
				continue
			}
			debt += lavaDPS * dt
			whole := int(debt)
			if whole > 0 {
				debt -= float64(whole)
				w.envDamage(pl, whole, 0) // owner=0: нейтральная среда (§14.6)
			}
			w.fireDebt[key] = debt
		}
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
		case "door", "gas", "valve": // §14.2/§14.6.1: клапаны несут open, как дверь
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
