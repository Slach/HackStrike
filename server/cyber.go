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
	"strconv"
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

	// decrypt-джобы (§16.4): дека NPU ×1, SRV NPU ×3. Честная очередь:
	// N джоб на хосте = каждая ×1/N (devJobTick / cyberTick).
	deckDecryptMbps = 2.0
	srvDecryptMbps  = 6.0

	jobReportEvery = tickRate // прогресс SRV-decrypt команде 1 Гц (§16.9 job)

	// PHYSAFE (§16.6, итерация 7): взятие — 2.5 м (плейтест «смотрю на сейф,
	// жму space — ничего»: ховер-метка ловится лучом до ~3 м, а взятие было
	// 1.8 м — унифицировано), зона базы — 6 м от точек спавна, канал
	// «вскрываем»: на месте (код) — 3 с, на базе — 6 с.
	// Feedback-радиус: space у сейфа вне 2.5 м — не молчание, а отказ
	// «ПОДОЙДИ БЛИЖЕ К СЕЙФУ» (плейтест: «надо как-то на space реагировать»).
	physafeFeedbackRadius = 4.5
	physafeTakeRadius     = 2.5

	matchRestartDelay = 30 * time.Second // §16.6: end-оверлей поживает 30 с (плейтест «отсчет рестарта 30 секунд =)»)
	// safeKeyRegenDelay (§16.2, решение владельца 2026-11-20): rm safe_key —
	// задержка, не перманентный отказ extract-победы: ключ регенерируется на
	// NETSAFE, если его нет ВЕЗДЕ (хосты/деки/трансферы) 150 с подряд.
	safeKeyRegenDelay = 150 * time.Second

	// Лифты (§16.12, итерация 8.5): спуск 2F→1F один раз за матч (кнопка
	// только на 2F — наверх никак; использованный лифт остаётся внизу).
	// Скорость 2.8 м/с → 7 м за 2.5 с; платформа 2.7×2.7 — сейф влезает.
	liftSpeed              = 2.8
	liftFloor2Y            = 8.0
	liftFloor1Y            = 1.0
	liftBtnRadius          = 3.5 // плейтест: 2 м — «какой-то маленький радиус»
	physafeBaseRadius      = 6.0
	physafeChannelWork     = 3.0
	physafeBaseChannelWork = 6.0
	portscanWork           = 2.0 // с работы при полной CPU-доле (§12.4)

	// §12.4 ревизия (плейтест «4 раза нажал 1 — и вся сеть видна»):
	// разведка дорожает с размером УЖЕ известной сети — work сканa =
	// portscanWork × (1 + 0.25 × открытых устройств). Первые хопи быстрые,
	// поздняя разведка (когда карта большая) — заметное ожидание.
	portscanFogFactor = 0.25
	vulnscanWork      = 3.0
	trojanWork        = 2.0
	watcherWork       = 1.0 // §13.1: пассивный слушатель — дешевле vulnscan'а
	firewallWork      = 1.5 // §13.5: активный фильтр — дороже watcher'а, дешевле trojan'а
	antivirusWork     = 1.5 // §13.6: активная защита — тот же ярус, что firewall

	camVisionRadius = 12.0  // §13.7: зона видимости камеры, м (радиус + LOS)
	camConeHalf     = 0.5   // §13.7 M6: полуугол конуса (рад) — как полу-fov рендера 1.0
	camPatrolAmp    = 0.785 // §13.7: автопатруль, размах ±45° (рад)
	camPatrolPeriod = 8 * time.Second
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

	// Яд (§14.2, ревизия 2026-11-21 — решение владельца «газ отравленный»):
	// каждый урон-тик в объёме продлевает отравление, и после выхода из
	// объёма яд продолжает жечь медленно. Механика антидота — в roadmap.
	gasPoisonDur = 10 * time.Second // сколько секунд яд жжёт после выхода
	gasPoisonDPS = 2.5              // HP/с отравления вне объёма

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
	"gas":      {cpu: 0.2, npu: 0, net: 100, ram: 1},   // §14.2: клапан — контроллер, как дверь
	"valve":    {cpu: 0.2, npu: 0, net: 100, ram: 1},   // §14.6.1: водяной клапан — контроллер, как газовый
	"camera":   {cpu: 0.2, npu: 0, net: 100, ram: 1},   // §13.7: сенсор, как switch
	"srv":      {cpu: 1.0, npu: 1.0, net: 100, ram: 4}, // §16.5: сервер — CPU+NPU станция
	"keypad":   {cpu: 0.1, npu: 0, net: 10, ram: 1},    // §16.7: клавиатура замка — контроллер
	"safe":     {cpu: 0.2, npu: 0, net: 100, ram: 1},   // §16.6: NETSAFE — хранилище без NPU (decrypt-станции — SRV/дека)
}

// deviceHalfExtents — корпус устройства для коллизии: [halfW, height,
// halfD]. Дверь/газ/клапан уже имеют свои AABB в map.colliders по геометрии
// — здесь только сетевые коробки (терминал, камера, свитч, SRV, радио).
func deviceHalfExtents(kind string) vec3 {
	switch kind {
	case "terminal":
		return vec3{0.3, 1.2, 0.3}
	case "camera":
		return vec3{0.2, 0.3, 0.2}
	case "switch":
		return vec3{0.25, 0.85, 0.15}
	case "srv":
		return vec3{0.6, 2.2, 0.4}
	case "radio":
		return vec3{0.15, 1.6, 0.15} // §16.5-стиль: узкая мачта-столб, а не тумбочка
	case "safe":
		return vec3{0.5, 1.1, 0.5} // §16.6: NETSAFE-тумба — непроходима, как терминал
	case "liftbtn":
		return vec3{0.17, 1.1, 0.17} // §16.12: пьедестал кнопки лифта — сплошной
	default:
		return vec3{}
	}
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

// devJob — джоба decrypt на хосте (§16.4): «либо прошло, либо нет»,
// прогресс в МБ. Живёт на хосте: переживает джек-аут и смерть запустившего,
// результат падает в MEM хоста (перехват, §16.1). team запустившего —
// константа матча: job/codes уходят команде даже после его смерти.
type devJob struct {
	id       int
	data     string
	mb       int
	by       uint64
	team     int
	progress float64
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

	// jobs — decrypt-джобы хоста (§16.4): SRV-джоба живёт на хосте,
	// смена владельца mid-job её не отменяет (результат достанется новому
	// владельцу — перехват).
	jobs []*devJob

	// safeLevel — экспоненциальный backoff сейфа (§16.6, итерация 5.5,
	// плейтест «NETSAFE больно легко вскрывается по сети»): каждая сетевая
	// vulnscan/trojan ×2 к work следующих попыток КОМАНДЫ (per-team — иначе
	// второй хакер команды начинал бы с нуля); спад −1 ступень/90 с.
	// Локальная работа (джек-ин в сам сейф) — без пени.
	safeLevel map[int]int
	safeAt    map[int]time.Time

	owner         uint64          // владелец trojan (0 = нейтральное)
	open          bool            // дверь/газ (§14.2): стартует закрытой
	locked        bool            // §16.7: d3 заперта код-замком (клавиатура)
	lockedDefault bool            // исходная запертость из карты (сброс на новом матче)
	keypadFor     string          // §16.7: keypad — id двери, которой управляет
	gasArmAt      time.Time       // газ (§14.2): момент последнего взвода клапана; нулевой = не взведён
	gasArmCount   uint64          // газ: счётчик взводов для ключа накопленного долга (resync-устойчив)
	vulnedBy      map[uint64]bool // хакеры с завершённым vulnscan (M2: навсегда)
	watcherBy     map[uint64]bool // хакеры с установленным watcher-триггером (§13.1)
	firewalled    uint64          // хозяин firewall-фильтра точки входа (§13.5; 0 = нет)
	antivirused   uint64          // хозяин antivirus-процесса (§13.6; 0 = нет)

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

	// yaw/pitch/baseYaw/basePitch/patrol — камера (§13.7 M6-конус):
	// ориентация — состояние сервера (map даёт стартовую), конус видимости
	// считается от yaw; base* — для автопатруля и сброса матча. patrol —
	// сервер сам ведёт объектив синусом от baseYaw.
	yaw       float64
	pitch     float64
	baseYaw   float64
	basePitch float64
	patrol    bool

	// recBy — §13.7 REC: кто сейчас СМОТРИТ в камеру (V-fullscreen или таб
	// деки) — heartbeat {"t":"camview"} каждые 1 с; тише 2 с = ушёл.
	// Сервер раздаёт rec в snap.props ВСЕМ: LED на корпусе пульсирует у
	// каждого клиента (раньше пульс рисовал только клиент смотрящего, который
	// собственный корпус не видит — сигнал на земле никто не видел).
	recBy map[uint64]time.Time
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

// physafeState — физический сейф (§16.6, итерация 7): офлайн (вне графа
// сети), позиция ездит с носителем. Канал «вскрываем 3 с»: crack — ввод
// верного кода сейфа у сейфа; base — носитель в зоне своей базы. Прерывается
// уроном по вскрывающему, смертью, отходом (crack — от сейфа, base — из
// зоны), дропом сейфа.
type physafeState struct {
	pos        vec3
	carrier    uint64
	chKind     string // "" | "crack" | "base"
	chProgress float64
	chBy       uint64
	chTeam     int
}

// liftState — платформа лифта (§16.12): физика, не сеть. top — Y верхней
// поверхности (8 = 2 этаж, 1 = 1 этаж). Один спуск за матч: кнопка на 2F,
// наверх платформа не возвращается до рестарта.
type liftState struct {
	id     string
	x, z   float64
	half   float64 // половина стороны платформы
	thick  float64
	top    float64
	moving bool
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
	// Корпуса устройств — препятствия движения/лучей: раньше сквозь терминалы,
	// камеры и свитчи проходили как сквозь воздух (плейтест: «я не должен
	// проходить сквозь сервера, терминалы, камеры и свитчи»).
	for _, p := range m.props {
		half := deviceHalfExtents(p.Kind)
		if half == (vec3{}) {
			continue
		}
		m.deviceBoxes = append(m.deviceBoxes, aabb{
			min: vec3{p.Pos[0] - half[0], p.Pos[1], p.Pos[2] - half[2]},
			max: vec3{p.Pos[0] + half[0], p.Pos[1] + half[1], p.Pos[2] + half[2]},
		})
	}
	for _, p := range m.props {
		if p.Kind == "cable" {
			continue
		}
		if p.Kind == "physafe" {
			// §16.6: физический сейф — НЕ сетевое устройство (офлайн, вне
			// графа): состояние живёт на world, позиция ездит со носителем.
			continue
		}
		if p.Kind == "lift" || p.Kind == "liftbtn" {
			// §16.12 (плейтест «тащить сейф по лестнице — самоубийство»):
			// лифты и их кнопки — физика, НЕ сеть (взломать нельзя по
			// определению — устройства нет). Состояние на world.
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
		if d.kind == "keypad" {
			d.keypadFor = p.To // §16.7: клавиатура — контроллер своей двери
		}
		if d.kind == "door" {
			d.locked = p.Locked
			d.lockedDefault = p.Locked
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
			// §13.7 M6-конус: стартовая ориентация из карты; 0/0 → в центр
			// карты (ту же логику держит клиент для меша — один источник
			// правды, дублирование только формулой по bounds).
			if p.Yaw == 0 && p.Pitch == 0 {
				d.yaw = math.Atan2(m.Bounds[0]/2-p.Pos[0], m.Bounds[2]/2-p.Pos[2])
			} else {
				d.yaw = p.Yaw
			}
			d.pitch = p.Pitch
			d.baseYaw, d.basePitch = d.yaw, d.pitch
			d.recBy = make(map[uint64]time.Time)
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
	dev, _ := w.jackTargetScored(pl)
	return dev
}

// jackTargetScored — джек-цель + «сила прицела»: score = dot с взглядом
// (конус ~25°) либо -дистанция для ближайшего вне конуса. Отрицательный
// score НИКОГДА не бьёт положительный — прицелённый physafe честно
// побеждает свитч за спиной (плейтест: «конфликт по space с netsafe и
// physafe и s3» — у центра комнаты они в 1 м друг от друга).
func (w *world) jackTargetScored(pl *player) (*device, float64) {
	eye := pl.pos.add(vec3{0, eyeHeight, 0})
	var best *device  // ближайший в радиусе
	var aimed *device // лучший в конусе взгляда
	bestD := math.Inf(1)
	bestDot := math.Cos(25 * math.Pi / 180)
	for _, id := range w.cyber.order {
		d := w.cyber.devices[id]
		// §16.7: клавиатура замка — настенный контроллер, не точка джек-ина
		// (space у неё = пад кода, а не вход в сеть).
		if d.kind == "keypad" {
			continue
		}
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
		return aimed, bestDot
	}
	if best != nil {
		return best, -bestD
	}
	return nil, math.Inf(-1)
}

// nearestLiftButton — ближайшая кнопка лифта в радиусе (§16.12), "" = нет.
func (w *world) nearestLiftButton(pl *player) string {
	best, bestD := "", liftBtnRadius
	for i := range w.m.props {
		b := &w.m.props[i]
		if b.Kind != "liftbtn" {
			continue
		}
		dp := vec3{b.Pos[0] - pl.pos[0], 0, b.Pos[2] - pl.pos[2]}
		if d := dp.length(); d < bestD {
			best, bestD = b.ID, d
		}
	}
	return best
}

// physafeScore — «сила прицела» на PHYSAFE (§16.6): как у джек-цели —
// dot в конусе либо -дистанция; сейф должен быть на земле (не у носителя).
func (w *world) physafeScore(pl *player) float64 {
	if !w.physafePresent || w.physafe.carrier != 0 {
		return math.Inf(-1)
	}
	dp := w.physafe.pos.sub(pl.pos)
	dp[1] = 0
	dist := dp.length()
	if dist > physafeTakeRadius {
		return math.Inf(-1)
	}
	eye := pl.pos.add(vec3{0, eyeHeight, 0})
	to := w.physafe.pos.add(vec3{0, 0.5, 0}).sub(eye)
	if to.length() < 0.001 {
		return math.Inf(-1)
	}
	dot := to.dot(aimDir(pl.yaw, pl.pitch)) / to.length()
	if dot >= math.Cos(25*math.Pi/180) {
		return dot
	}
	return -dist
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
	// enc — снапшот Enc источника на старте: POSIX-семантика rm (как у
	// decrypt): item могли удалить mid-flight — трансфер доносит снапшот,
	// «открытый дескриптор» (плейтест M5: финиш молча глотал результат).
	enc bool
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
	if !pressed || !pl.alive || pl.jacked {
		return // мёртвые и джекнутые ничего не берут
	}
	// §16.6 (итерация 7) + плейтест «конфликт по space с netsafe и physafe
	// и s3»: у центра комнаты сейф, switch и NETSAFE в 1 м друг от друга —
	// цель space выбирается ЕДИНЫМ сравнением «сила прицела» (dot в конусе
	// 25°, вне конуса — ближайшая по дистанции с отрицательным score, который
	// никогда не бьёт прицеленную). Взял сейф — takeSafe; иначе джек-флоу.
	// §16.12: физическая кнопка лифта (space, любой класс) — рядом с ней
	// нет сетевых устройств, конфликтов нет; радиус 2 м
	if btn := w.nearestLiftButton(pl); btn != "" {
		w.pressLiftButton(pl, btn)
		return
	}
	pfScore := w.physafeScore(pl)
	dev, devScore := w.jackTargetScored(pl)
	if pfScore > devScore {
		w.takeSafe(pl)
		return
	}
	// плейтест «надо на space реагировать — подойди ближе»: стоя у сейфа
	// вне радиуса взятия (но рядом), молчание выглядит как сломанная кнопка
	if w.physafePresent && w.physafe.carrier == 0 && !pl.carry {
		dp := w.physafe.pos.sub(pl.pos)
		dp[1] = 0
		if dp.length() <= physafeFeedbackRadius {
			w.dataDenied(pl, "too_far", "physafe", "")
			return
		}
	}
	if pl.cls != "hacker" {
		return // дека только у хакера
	}
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
	if pl.scanned == nil {
		// §12.5 «точка входа известна всегда»: пустых знаний не бывает —
		// jackin инициализирует карту точкой входа. Плейтест-баг: при
		// scanned==nil (новый матч/реконнект) scan НЕ отправлялся и клиент
		// доживал со картой прошлой сессии до первого portscan.
		pl.scanned = map[string]bool{dev.id: true}
	} else {
		reach := w.reachableFor(dev.id, pl)
		for id := range pl.scanned {
			if !reach[id] {
				delete(pl.scanned, id)
			}
		}
	}
	w.sendScan(pl)
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
	// who может быть nil (финиш SRV-джобы после смерти/выхода запустившего,
	// §16.4) — события с whoID=0.
	var whoID uint64
	if who != nil {
		whoID = who.id
	}
	// Журнал — история устройства, пишется независимо от живости хозяев
	// (в т.ч. собственные события, §13.1).
	w.logWatcherEvent(dev, ev, who, prog)
	for ownerID := range dev.watcherBy {
		if ownerID == whoID {
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
	var whoID uint64
	if who != nil {
		whoID = who.id
	}
	dev.log = append(dev.log, logEntry{Tick: w.tick, Ev: ev, Who: whoID, Prog: prog})
	if len(dev.log) > watcherLogCap {
		dev.log = dev.log[len(dev.log)-watcherLogCap:]
	}
}

// sendWatcherAlert — alert хозяину watcher'а (relay=false) или союзнику
// (relay=true). ev/prog — контекст события; prog omitempty.
func (w *world) sendWatcherAlert(to *player, dev *device, who *player, ev, prog string, relay bool) {
	var whoID uint64
	if who != nil {
		whoID = who.id
	}
	m := message{"t": "alert", "dev": dev.id, "who": whoID, "src": "watcher", "ev": ev}
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
	var whoID uint64
	if who != nil {
		whoID = who.id
	}
	for _, ally := range w.players {
		if ally.id == owner.id || ally.id == whoID || !ally.alive || ally.team != owner.team {
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

// hostItemIndex/deckItemIndex — индекс item'а по имени (−1 = нет): финиш
// cp/mv берёт источник по индексу (mv вырезает), чтобы не тащить мутабельную
// ссылку по циклу.
func hostItemIndex(dev *device, name string) int {
	for i, it := range dev.items {
		if it.Name == name {
			return i
		}
	}
	return -1
}

func deckItemIndex(pl *player, name string) int {
	for i, it := range pl.items {
		if it.Name == name {
			return i
		}
	}
	return -1
}

// cpSnapshot — POSIX-«открытый дескриптор» (§16.2, как у decrypt): источник
// могли rm-нуть mid-flight — трансфер всё равно доносит снапшот старта.
// Код расшифрованного item'а — текущего поколения (кто расшифровал до старта
// трансфера, тот код уже знает через codes).
func (w *world) cpSnapshot(p *program) dataItem {
	d := dataItem{Name: p.data, MB: p.mb, Enc: p.enc}
	if !p.enc {
		d.Code = w.decryptCodeOf(p.data)
	}
	return d
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

// Базы работ взлома СЕЙФА (§16.6, плейтест «слишком быстро»: спавн → 2
// portscan → vulnscan → trojan ≈ 5 с и владелец — сейф должен держать в
// деке долго): vulnscan 8 с, trojan 10 с на ЧИСТОМ пути, дальше экспонента.
const (
	safeVulnscanWork = 8.0
	safeTrojanWork   = 10.0
)

// safeBackoffLevel — текущая ступень backoff КОМАНДЫ на сейфе (спад
// −1 ступень за 90 с с последнего нарушения, §16.6).
func safeBackoffLevel(d *device, team int, now time.Time) int {
	if d.safeLevel == nil || d.safeLevel[team] <= 0 {
		return 0
	}
	lvl := d.safeLevel[team] - int(now.Sub(d.safeAt[team]).Minutes()*1.5)
	if lvl < 0 {
		lvl = 0
	}
	return lvl
}

// safeBackoffInc — нарушение зафиксировано: спад пере-вычислен, +1 ступень.
func safeBackoffInc(d *device, team int, now time.Time) {
	if d.safeLevel == nil {
		d.safeLevel = make(map[int]int)
		d.safeAt = make(map[int]time.Time)
	}
	lvl := safeBackoffLevel(d, team, now)
	d.safeAt[team] = now
	d.safeLevel[team] = lvl + 1
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
// лут на время. Читаемо для игрока: ЧАСЫ-МИНУТЫ генерации + дата
// («door_key1432_2026-11-18»), не порядковый номер — владелец: «HHII это
// часы и минуты, а не просто 1,2,3,4». Ротация раз в 2 минуты → имена
// уникальны внутри матча.
func doorKeyName(t time.Time) string {
	// плейтест 2026-11-20: дата в имени не влезает в UI-листинги — коротко:
	// door_key_HH_II (часы_минуты); уникальность поколений внутри матча
	// сохраняется (ротация 2 мин, матч 10 мин)
	return fmt.Sprintf("door_key_%02d_%02d", t.Hour(), t.Minute())
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
	if w.matchStart.IsZero() {
		return
	}
	el := w.now().Sub(w.matchStart)
	if el < doorKeyRot {
		return
	}
	gen := int(el / doorKeyRot)
	if w.doorKeyGen == gen {
		return
	}
	w.doorKeyGen = gen
	srv := w.cyber.devices[w.doorKeyHost]
	if srv == nil {
		return
	}
	name := doorKeyName(w.now())
	if w.doorKeyName == name {
		return // защитно: та же минута — то же поколение
	}
	// Решение владельца (плейтест 2026-11-18): старые поколения НЕ удаляем —
	// за 10-минутный матч их максимум 6 × 60 = 360 МБ ≤ MEM 512. Хакер, не
	// вскрывший SRV1, не знает, какой ключ валиден (грейс держит только
	// текущий и предыдущий код) — неоднозначность intentional. Чистка — при
	// старте нового матча (resetDoorKey): именно там был настоящий баг.
	srv.items = append(srv.items, dataItem{Name: name, MB: 60, Enc: true})
	// грейс: предыдущее поколение валидно ещё одну ротацию (§16.7)
	w.doorKeyPrevCode = w.doorKeyCode
	w.doorKeyCode = w.doorKeyCodeNow(name)
	w.doorKeyName = name
	log.Printf("room: door_key rotated -> %s on %s", name, srv.id)
}

// resetDoorKey — новый матч (§16.5): SRV1 чистится от старых поколений,
// код перегенерирован, грейс сброшен. Ключи в деках игроков тоже устарели —
// матч-специфичный лут не переезжает в следующий раунд (плейтест:
// «не чистятся после 10 минут, в новом раунде»). §16.6: NETSAFE так же
// чистится и пересеивается safe_key, код сейфа перегенерирован.
func (w *world) resetDoorKey() {
	w.matchStart = w.now()
	w.doorKeyGen = 0
	w.doorKeyPrevCode = ""
	w.doorKeyName = doorKeyName(w.now())
	w.doorKeyCode = w.doorKeyCodeNow(w.doorKeyName)
	if srv := w.cyber.devices[w.doorKeyHost]; srv != nil {
		kept := srv.items[:0]
		for _, it := range srv.items {
			if !strings.HasPrefix(it.Name, "door_key") {
				kept = append(kept, it)
			}
		}
		srv.items = append(kept, dataItem{Name: w.doorKeyName, MB: 60, Enc: true})
	}
	// §16.6: safe_key — не ротируется, но матч-специфичен (код сейфа от
	// старта матча — не повторяется между матчами, как и код d3).
	w.safeKeyRegenAt = time.Time{} // новый матч: сид на месте, таймер не нужен
	if w.safeKeyHost == "" {
		w.safeKeyHost = "netsafe"
	}
	w.safeCode = w.doorKeyCodeNow("safe_key")
	if ns := w.cyber.devices[w.safeKeyHost]; ns != nil {
		ns.items = []dataItem{{Name: "safe_key", MB: 120, Enc: true}}
	}
	// Плейтест M5 «между раундами неправильное содержимое на srv2/srv3»:
	// chaff-копии door_key/safe_key (в т.ч. РАСШИФРОВАННЫЕ, с кодом прошлого
	// матча) жили на остальных хостах сквозь границу матча — чистим ВСЕ
	// устройства, не только дом ключа и деки.
	for _, d := range w.cyber.devices {
		if d.id == w.doorKeyHost || d.id == w.safeKeyHost {
			continue // дом ключа и NETSAFE пересеиваются выше
		}
		kept := d.items[:0]
		for _, it := range d.items {
			if !strings.HasPrefix(it.Name, "door_key") && it.Name != "safe_key" {
				kept = append(kept, it)
			}
		}
		d.items = kept
	}
	for _, pl := range w.players {
		kept := pl.items[:0]
		for _, it := range pl.items {
			// матч-специфичный лут (door_key + safe_key) не переезжает
			if !strings.HasPrefix(it.Name, "door_key") && it.Name != "safe_key" {
				kept = append(kept, it)
			}
		}
		pl.items = kept
	}
	log.Printf("room: door_key reset for new match -> %s, safe_key reseeded (code %s)", w.doorKeyName, w.safeCode)
}

// safeKeyTick — регенерация safe_key (§16.2, решение владельца 2026-11-20):
// rm не должен убивать extract-победу навсегда. Таймер 150 с идёт только
// когда ключа нет ВЕЗДЕ (хосты, деки, cp/mv в полёте — снапшот доедет).
func (w *world) safeKeyTick() {
	if w.safeKeyHost == "" {
		return
	}
	if w.safeKeyPresent() {
		w.safeKeyRegenAt = time.Time{}
		return
	}
	now := w.now()
	if w.safeKeyRegenAt.IsZero() {
		w.safeKeyRegenAt = now.Add(safeKeyRegenDelay)
		log.Printf("room: safe_key absent — regen timer %v started", safeKeyRegenDelay)
		return
	}
	if now.Before(w.safeKeyRegenAt) {
		return
	}
	ns := w.cyber.devices[w.safeKeyHost]
	if ns == nil {
		w.safeKeyRegenAt = time.Time{}
		return
	}
	ns.items = append(ns.items, dataItem{Name: "safe_key", MB: 120, Enc: true})
	w.safeKeyRegenAt = time.Time{}
	w.resendScanFor(ns.id)
	log.Printf("room: safe_key regenerated on %s", ns.id)
}

// safeKeyPresent — safe_key есть хотя бы в одном месте: хост, дека, или он
// летит cp/mv (POSIX-снапшот доедет и займёт место).
func (w *world) safeKeyPresent() bool {
	for _, d := range w.cyber.devices {
		if hostHasItem(d, "safe_key") {
			return true
		}
	}
	for _, pl := range w.players {
		if deckHasItem(pl, "safe_key") {
			return true
		}
		for _, p := range pl.progs {
			if (p.prog == "cp" || p.prog == "mv") && p.data == "safe_key" {
				return true
			}
		}
	}
	return false
}

// doorKeyLeftMs — сколько осталось до следующей ротации поколения (§16.5):
// клиент считает таймер в паде. −1 — матч не идёт.
func (w *world) doorKeyLeftMs() int64 {
	if w.matchStart.IsZero() {
		return -1
	}
	el := w.now().Sub(w.matchStart)
	if el < 0 {
		return -1
	}
	left := doorKeyRot - el%doorKeyRot
	return left.Milliseconds()
}

// doorKeyCodeNow — код d3 поколения: от имени + старта матча (чистая дата в
// имени иначе повторяла бы код между матчами одного дня — запомнил и вошёл).
func (w *world) doorKeyCodeNow(name string) string {
	return doorKeyCodeOf(name + "|" + w.matchStart.Format("20060102150405"))
}

// doorKeyValidCodes — код d3 валиден для текущего и предыдущего поколения
// (грейс одна ротация, §16.7): ротация за 2 с до ввода — не плевок в лицо.
func (w *world) doorKeyValid(pl *player, code string) bool {
	if code == w.doorKeyCode {
		return true
	}
	return w.doorKeyPrevCode != "" && code == w.doorKeyPrevCode
}

// resetCyberMatchState — новый матч = НОВАЯ СЕТЬ (плейтест 2026-11-20
// «после нескольких раундов в клиенте старая мапа»): trojan'ы/владельцы,
// vulned/firewall/antivirus/watcher, открытые двери, запертость d3–d6,
// журналы и SRV-джобы прошлого матча не переезжают; знания скана (scanned)
// игроков чистятся — туман войны заново (портсить сеть придётся по новой,
// но карта деки не врёт старыми захватами).
func (w *world) resetCyberMatchState() {
	for _, d := range w.cyber.devices {
		d.owner = 0
		d.open = false
		if d.kind == "door" {
			d.locked = d.lockedDefault
		}
		d.gasArmAt = time.Time{}
		d.gasArmCount = 0
		d.vulnedBy = make(map[uint64]bool)
		d.watcherBy = make(map[uint64]bool)
		d.firewalled = 0
		d.antivirused = 0
		d.jobs = nil
		d.log = nil
		// §13.7 M6: ориентация камер — к стартовой из карты, патруль гаснет,
		// зрители REC обнуляются (новый матч — никто не смотрит).
		if d.kind == "camera" {
			d.yaw, d.pitch = d.baseYaw, d.basePitch
			d.patrol = false
			d.recBy = make(map[uint64]time.Time)
		}
	}
	for _, pl := range w.players {
		pl.scanned = nil
		if pl.jacked && pl.jackHost != nil {
			// точка входа известна всегда (§12.5): карта нового матча для
			// джекнутого = одна точка входа, не пустой срез
			pl.scanned = map[string]bool{pl.jackHost.id: true}
			w.sendScan(pl) // старая карта уходит с экрана сразу
		}
	}
	log.Printf("room: cyber state reset for new match")
}

// seedData — стартовые данные матча (§16.1): одно поколение door_key на SRV1.
// Код d3 генерится здесь же (doorKeyCode), предыдущий пуст.
func (w *world) seedData() {
	if w.doorKeyHost == "" {
		w.doorKeyHost = "srv1"
	}
	if w.cyber.devices[w.doorKeyHost] == nil {
		return
	}
	w.resetDoorKey()
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
	if prog == "decrypt" {
		w.handleDecrypt(pl, str(msg, "dev"), str(msg, "data"))
		return
	}
	work := progWork(prog)
	if work == 0 {
		return // неизвестная программа — мусор в протоколе, игнорируем
	}
	if prog == "portscan" {
		// §12.4 ревизия: туман войны дорожает — пропорционально открытому
		work *= 1 + float64(len(pl.scanned))*portscanFogFactor
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
	// §16.6 (итерация 5.5, плейтест «NETSAFE больно легко вскрывается по
	// сети» + «слишком быстро»): сетевая vulnscan/trojan на сейф — базовые
	// работы 8/10 с (чистый путь ≈18 с в деке, siege-чувство) и
	// экспоненциальный backoff КОМАНДЫ ×2^ступень (спад 1 ступень/90 с).
	// Локальная работа (джек-ин в сам сейф) и владелец — без пени.
	// Обязательно ИНФО игроку (slow): «ждать или идти ногами».
	if dev, ok := w.cyber.devices[devID]; ok && dev.kind == "safe" && (prog == "vulnscan" || prog == "trojan") && pl.jackHost.id != devID && dev.owner != pl.id {
		// база сейфа выше терминальной (плейтест «слишком быстро»)
		if prog == "vulnscan" {
			work = safeVulnscanWork
		} else {
			work = safeTrojanWork
		}
		lvl := safeBackoffLevel(dev, pl.team, w.now())
		if lvl > 0 {
			mult := 1 << lvl
			work *= float64(mult)
			eta := int(math.Ceil(work))
			w.sendTo(pl.id, message{"t": "slow", "dev": devID, "prog": prog, "mult": mult, "eta": eta})
			log.Printf("room: safe backoff x%d on %s for team %d player %d (%s, %d s)", mult, devID, pl.team, pl.id, prog, eta)
		}
		// плейтест «не ощутил»: пеня за КАЖДЫЙ старт (в т.ч. прерванный),
		// не только за завершение — «подряд» растёт сразу: vulnscan 8с,
		// trojan ×2 (20с), повторный vulnscan ×4 (32с)…
		safeBackoffInc(dev, pl.team, w.now())
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
		enc: it.Enc, // POSIX-снапшот источника (rm mid-flight, как у decrypt)
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

// handleDecrypt — §16.4: {"t":"run","prog":"decrypt","dev":host,"data":name}.
// Джоба бежит НА ХОСТЕ, где лежат данные; хост обязан иметь NPU, иначе
// denied npu («НУЖЕН NPU»). Скорость: дека 2 МБ/с (NPU ×1), SRV 6 МБ/с
// (NPU ×3); честная очередь — N джоб на хосте = каждая ×1/N.
// Результат «либо прошло, либо нет»: item → enc:false + код команде
// навсегда (codes, HUD «КОД D3»). Джоба на деке — процесс деки (RAM-слоты,
// отменяется джек-аутом/смертью); джоба на SRV живёт на хосте (§16.4).
func (w *world) handleDecrypt(pl *player, hostID, dataName string) {
	if dataName == "" {
		w.dataDenied(pl, "too_far", "decrypt", dataName)
		return
	}
	if hostID == "deck" {
		var it dataItem
		for _, x := range pl.items {
			if x.Name == dataName {
				it = x
			}
		}
		if it.Name == "" {
			w.dataDenied(pl, "too_far", "decrypt", dataName)
			return
		}
		if !it.Enc {
			w.dataDenied(pl, "decrypted", "decrypt", dataName) // уже расшифрован
			return
		}
		if len(pl.progs) >= deckRAM {
			w.denied(pl, "ram_full", "decrypt", dataName)
			return
		}
		pl.progs = append(pl.progs, &program{
			id: pl.nextProgID, prog: "decrypt", dev: "deck", data: dataName,
			work: float64(it.MB) / deckDecryptMbps, mb: it.MB, mbps: deckDecryptMbps,
		})
		pl.nextProgID++
		log.Printf("room: player %d run decrypt %s on deck", pl.id, dataName)
		return
	}
	dev, ok := w.cyber.devices[hostID]
	if !ok || !pl.scanned[hostID] || !w.reachableFor(pl.jackHost.id, pl)[hostID] {
		w.dataDenied(pl, "too_far", "decrypt", dataName)
		return
	}
	// Доступ к данным хоста = владение trojan'ом (как cp src, §16.1).
	if dev.owner != pl.id {
		w.dataDenied(pl, "not_owner", "decrypt", dataName)
		return
	}
	if dev.npu <= 0 {
		w.dataDenied(pl, "npu", "decrypt", dataName)
		return
	}
	var it dataItem
	found := false
	for _, x := range dev.items {
		if x.Name == dataName {
			it, found = x, true
		}
	}
	if !found {
		w.dataDenied(pl, "too_far", "decrypt", dataName)
		return
	}
	if !it.Enc {
		w.dataDenied(pl, "decrypted", "decrypt", dataName)
		return
	}
	for _, j := range dev.jobs {
		if j.data == dataName {
			w.dataDenied(pl, "in_progress", "decrypt", dataName) // джоба уже летит
			return
		}
	}
	dev.jobs = append(dev.jobs, &devJob{id: pl.nextProgID, data: dataName, mb: it.MB, by: pl.id, team: pl.team})
	pl.nextProgID++
	// Старт джобы палевен (§16.4): watcher'ы хоста триггерятся, команда
	// сразу видит прогресс (job, prog=0).
	w.fireWatchers(dev, pl, "job", "decrypt")
	w.sendJob(dev.jobs[len(dev.jobs)-1], dev)
	log.Printf("room: player %d run decrypt %s on %s", pl.id, dataName, hostID)
}

// devJobTick — тик SRV-джоб (§16.4): живут на хосте, честная NPU-очередь
// (N джоб = каждая ×1/N от srvDecryptMbps). Смена владельца хоста mid-job
// джобу НЕ отменяет — результат достанется новому владельцу (перехват).
// Прогресс — команде запустившего 1 Гц (job, §16.9).
func (w *world) devJobTick() {
	for _, dev := range w.cyber.devices {
		if len(dev.jobs) == 0 {
			continue
		}
		rate := srvDecryptMbps / float64(len(dev.jobs))
		var finished []*devJob
		for _, j := range dev.jobs {
			j.progress += rate * tickDT
			if w.tick%jobReportEvery == 0 {
				w.sendJob(j, dev)
			}
			if j.progress >= float64(j.mb) {
				finished = append(finished, j)
			}
		}
		for _, j := range finished {
			for i, q := range dev.jobs {
				if q == j {
					dev.jobs = append(dev.jobs[:i], dev.jobs[i+1:]...)
					break
				}
			}
			w.finishDecrypt(dev, j)
		}
	}
}

// finishDecrypt — «либо прошло, либо нет» (§16.4): item на хосте →
// enc:false + код; код команда знает навсегда (codes → HUD «КОД D3»).
// POSIX-семантика rm (плейтест M5): джоба держит «открытый дескриптор» —
// item могли rm-нуть mid-job, имя исчезло, но КОД всё равно доносится
// команде (unlink не прерывает работающий процесс).
func (w *world) finishDecrypt(dev *device, j *devJob) {
	code := w.decryptCodeOf(j.data)
	for i := range dev.items {
		if dev.items[i].Name != j.data {
			continue
		}
		dev.items[i].Enc = false
		dev.items[i].Code = code
		break
	}
	w.noteTeamCode(j.team, j.data, code)
	w.sendCodes(j.team)
	w.resendScanFor(dev.id)
	// Финиш тоже watcher-событие (§16.4); запустивший мог умереть/выйти —
	// кто жив, тот и получит alert (who=nil допустим).
	var who *player
	if p, ok := w.players[j.by]; ok {
		who = p
	}
	w.fireWatchers(dev, who, "job", "decrypt")
	w.sendJob(j, dev)
	log.Printf("room: decrypt %s on %s finished (team %d)", j.data, dev.id, j.team)
}

// decryptCodeOf — код внутри item'а: door_key несёт код своего поколения
// (§16.5: FNV-1a от имени + старта матча); safe_key — код сейфа (§16.6,
// фиксирован на матч). Прочие данные кода не имеют.
func (w *world) decryptCodeOf(name string) string {
	if strings.HasPrefix(name, "door_key") {
		return w.doorKeyCodeNow(name)
	}
	if strings.HasPrefix(name, "safe_key") {
		return w.safeCode
	}
	return ""
}

// noteTeamCode — команда узнала код (§16.4): ключ по имени — door_key
// кладётся в doorCodes (HUD «КОД D3»), safe_key в safeCodes («КОД СЕЙФА»).
func (w *world) noteTeamCode(team int, name, code string) {
	if code == "" {
		return
	}
	if w.doorCodes == nil {
		w.doorCodes = map[int]string{}
	}
	if w.safeCodes == nil {
		w.safeCodes = map[int]string{}
	}
	if strings.HasPrefix(name, "door_key") {
		w.doorCodes[team] = code
	} else if strings.HasPrefix(name, "safe_key") {
		w.safeCodes[team] = code
	}
}

// sendJob — прогресс SRV-decrypt команде запустившего (§16.9 job 1 Гц,
// в т.ч. после джек-аута/смерти запустившего).
func (w *world) sendJob(j *devJob, dev *device) {
	prog := j.progress / float64(j.mb)
	if prog > 1 {
		prog = 1
	}
	for _, p := range w.players {
		if p.team == j.team {
			w.sendTo(p.id, message{"t": "job", "dev": dev.id, "data": j.data, "prog": round3(prog)})
		}
	}
}

// sendCodes — коды, узнанные командой (§16.9 codes): HUD «КОД D3» и
// «КОД СЕЙФА». Уходит всей команде при расшифровке и вошедшим позже
// (addPlayer); поле только то, что команда уже знает.
func (w *world) sendCodes(team int) {
	door := w.doorCodes[team]
	safe := w.safeCodes[team]
	if door == "" && safe == "" {
		return
	}
	m := message{"t": "codes"}
	if door != "" {
		m["door"] = door
	}
	if safe != "" {
		m["safe"] = safe
	}
	for _, p := range w.players {
		if p.team == team {
			w.sendTo(p.id, m)
		}
	}
}

// handleCtrl — {"t":"ctrl"} (§12.5): toggle двери; §14.2 — тот же контроллер
// у газа (вентиль). Только владелец trojan, лично и из hacker view
// (джекнутый), и пока устройство достижимо от точки входа — перерубленный
// кабель отрезает и управление (контр-хакинг §6).
// handleCamview — {"t":"camview","dev","on"} (§13.7 REC): heartbeat
// смотрящего. on=true каждые 1 с, on=false при закрытии; тише 2 с = ушёл
// (смерть/дисконнект без явного off). Доступ не проверяем строже жизни:
// rec — косметика «камеру смотрят», данных не несёт.
func (w *world) handleCamview(pl *player, msg message) {
	cam := w.cyber.devices[str(msg, "dev")]
	if cam == nil || cam.kind != "camera" || cam.recBy == nil {
		return
	}
	if msg["on"] == true {
		if !pl.alive {
			return
		}
		cam.recBy[pl.id] = w.now()
	} else {
		delete(cam.recBy, pl.id)
	}
}

// camRecActive — есть ли живой зритель (beat не старше 2 с).
func camRecActive(cam *device, now time.Time) bool {
	for id, at := range cam.recBy {
		if now.Sub(at) > 2*time.Second {
			delete(cam.recBy, id)
			continue
		}
		return true
	}
	return false
}

// handleCamrot — {"t":"camrot","dev","yaw","pitch"} (§13.7 M6-конус):
// доворот камеры живым союзником владельца (V-mlook или drag по кадру в
// деке). Ориентация — состояние сервера: переживает закрытие вида, видна
// союзникам (snap.props), конус видимости следует за yaw. Ручной доворот
// глушит автопатруль — камера остаётся там, куда повернули.
func (w *world) handleCamrot(pl *player, msg message) {
	if !w.camOperableBy(pl, str(msg, "dev")) {
		return
	}
	cam := w.cyber.devices[str(msg, "dev")]
	cam.patrol = false
	cam.yaw = num(msg, "yaw")
	for cam.yaw > math.Pi {
		cam.yaw -= 2 * math.Pi
	}
	for cam.yaw < -math.Pi {
		cam.yaw += 2 * math.Pi
	}
	cam.pitch = math.Max(-1.3, math.Min(1.3, num(msg, "pitch")))
	w.fireWatchers(cam, pl, "camrot", "")
}

// handleCampatrol — {"t":"campatrol","dev","on"} (§13.7): тогл автопатруля.
// Сервер ведёт yaw синусом от baseYaw (§ camFeedTick), pitch — базовый.
func (w *world) handleCampatrol(pl *player, msg message) {
	if !w.camOperableBy(pl, str(msg, "dev")) {
		return
	}
	cam := w.cyber.devices[str(msg, "dev")]
	cam.patrol = msg["on"] == true
	if cam.patrol {
		cam.pitch = cam.basePitch // патруль горизонтальный — вертикаль домой
	}
	log.Printf("room: camera %s patrol=%v by player %d", cam.id, cam.patrol, pl.id)
}

// camOperableBy — поворот/патруль доступны как просмотр: камера захвачена и
// проситель — живой союзник владельца (§13.7). Молча игнорируем чужих:
// это не боевое действие, denied-шум не нужен.
func (w *world) camOperableBy(pl *player, devID string) bool {
	cam := w.cyber.devices[devID]
	if cam == nil || cam.kind != "camera" || !pl.alive {
		return false
	}
	if cam.owner == 0 {
		return false
	}
	if cam.owner == pl.id {
		return true
	}
	owner, ok := w.players[cam.owner]
	return ok && w.sameTeam(owner, pl)
}

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
	if dev.kind == "door" && dev.locked {
		// §16.7: запертую дверь запирает/отпирает ТОЛЬКО код с клавиатуры —
		// троян на d3 управляет створкой лишь незапертой двери.
		w.denied(pl, "locked", "toggle", dev.id)
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

// handleEnter — ввод кода на клавиатуре d3 (§16.7): физически у двери
// (радиус как у джек-ина), любой класс, анти-флуд 1/2 с. Код валиден для
// текущего и предыдущего поколения door_key (грейс). Неверно — подсказка
// «N/4 цифр на месте», журнал d3, alert владельцу агрегированно.
func (w *world) handleEnter(pl *player, msg message) {
	devID := str(msg, "dev")
	if devID == "physafe" {
		w.enterPhysafe(pl, msg)
		return
	}
	at, ok := w.cyber.devices[devID]
	if !ok {
		return
	}
	// §16.7: код вводится на клавиатуре рядом с дверью. Дистанция — до
	// КЛАВИАТУРЫ (это физический ввод; от створки она в 2.5+ м — плейтест:
	// «подошёл к D5, 0000 → нет ответа»: too_far от двери глотался).
	dev := at
	if at.kind == "keypad" {
		if at.keypadFor == "" {
			return
		}
		dev = w.cyber.devices[at.keypadFor]
		if dev == nil || dev.kind != "door" {
			return
		}
	} else if at.kind != "door" {
		return
	}
	// §16.7: код общий для всех запертых дверей хранилища (d3–d6) — один
	// door_key; идея на будущее — разные коды внутри дубликатов door_key.
	if !pl.alive || pl.jacked {
		// всегда отвечаем — молчание вешает панель на «ПРОВЕРКА…»
		w.dataDenied(pl, "not_jacked", "enter", "")
		return
	}
	dp := at.pos.sub(pl.pos)
	dp[1] = 0
	if dp.length() > jackTerminalRadius+0.5 {
		w.dataDenied(pl, "too_far", "enter", "")
		return
	}
	now := w.now()
	// Анти-флуд (§16.7): спам-перебор не выталкивает журнал и не шлёт
	// alert'ы — но ОТВЕТ кодом шлём всегда: молчание вешало панель на
	// «ПРОВЕРКА…» (плейтест 2026-11-18).
	flood := !pl.enterAt.IsZero() && now.Sub(pl.enterAt) < 2*time.Second
	if !flood {
		pl.enterAt = now
	}
	code := str(msg, "code")
	if w.doorKeyValid(pl, code) {
		dev.locked = false
		dev.open = !dev.open
		if !dev.open {
			dev.locked = true // ввод кода на открытой двери запирает обратно
		}
		// open — итоговое состояние створки: код-ТОГГЛ, повторный ввод
		// ЗАКРЫВАЕТ и запирает дверь (плейтест: «пишет ОТКРЫТО, а дверь на
		// самом деле закрывается — путаница»; клиент отвечает «ПРАВИЛЬНО»).
		w.sendTo(pl.id, message{"t": "code", "dev": devID, "ok": true, "open": dev.open})
		log.Printf("room: player %d entered valid code on %s (open=%v)", pl.id, devID, dev.open)
		return
	}
	if flood {
		w.sendTo(pl.id, message{"t": "code", "dev": devID, "ok": false, "match": -1})
		return
	}
	// подсказка N/4: цифра верна И на своей позиции; секрет — поколение,
	// с которым код согласуется лучше (грейс держит два).
	secret := w.doorKeyCode
	if w.doorKeyPrevCode != "" {
		mc := hintMatch(w.doorKeyCode, code)
		mp := hintMatch(w.doorKeyPrevCode, code)
		if mp > mc {
			secret = w.doorKeyPrevCode
		}
	}
	match := hintMatch(secret, code)
	w.sendTo(pl.id, message{"t": "code", "dev": devID, "ok": false, "match": match})
	log.Printf("room: player %d wrong code on %s (N/4=%d)", pl.id, devID, match)
	w.fireWatchers(dev, pl, "code", "")
}

// hintMatch — сколько цифр верны И стоят на своих местах (§16.7).
func hintMatch(secret, code string) int {
	n := 0
	for i := 0; i < len(code) && i < len(secret); i++ {
		if code[i] == secret[i] {
			n++
		}
	}
	return n
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
				i := hostItemIndex(src, p.data)
				var d dataItem
				if i >= 0 {
					d = src.items[i]
					if p.prog == "mv" {
						src.items = append(src.items[:i], src.items[i+1:]...)
					}
				} else {
					d = w.cpSnapshot(p)
				}
				pl.items = append(pl.items, d)
			}
		} else if dst := w.cyber.devices[p.dst]; dst != nil {
			// deck→host (chaff) и host→host.
			if p.dev == "deck" {
				i := deckItemIndex(pl, p.data)
				var d dataItem
				if i >= 0 {
					d = pl.items[i]
					if p.prog == "mv" {
						pl.items = append(pl.items[:i], pl.items[i+1:]...)
					}
				} else {
					d = w.cpSnapshot(p)
				}
				dst.items = append(dst.items, d)
			} else if src := w.cyber.devices[p.dev]; src != nil {
				i := hostItemIndex(src, p.data)
				var d dataItem
				if i >= 0 {
					d = src.items[i]
					if p.prog == "mv" {
						src.items = append(src.items[:i], src.items[i+1:]...)
					}
				} else {
					d = w.cpSnapshot(p)
				}
				dst.items = append(dst.items, d)
			}
		}
		w.sendScan(pl) // листинг/память приёмника-источника обновить
		if src := w.cyber.devices[p.dev]; src != nil {
			w.fireWatchers(src, pl, "job", p.prog)
		}
	case "decrypt":
		// §16.4: джоба на деке — результат в MEM деки: item → enc:false +
		// код; код команда знает навсегда (codes → HUD «КОД D3»).
		// Отмена джек-аутом/смертью случилась бы раньше (jackout: progs=nil).
		// POSIX-семантика rm: item могли удалить mid-job — код всё равно
		// доносится команде («открытый дескриптор», как на SRV).
		code := w.decryptCodeOf(p.data)
		for i := range pl.items {
			if pl.items[i].Name != p.data {
				continue
			}
			pl.items[i].Enc = false
			pl.items[i].Code = code
			break
		}
		w.noteTeamCode(pl.team, p.data, code)
		w.sendCodes(pl.team)
		log.Printf("room: decrypt %s on deck finished (team %d)", p.data, pl.team)
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
	// Pct — доля выполнения 0..1 для ЛЮБОЙ программы: сканы (portscan и
	// др.) не имеют МБ-прогресса, но их карточка в деке живёт на этой
	// доле (плейтест M5: «бабл ушёл, а portscan идёт»).
	Pct float64 `json:"pct"`
	// Path — маршрут widest-path, зафиксированный на старте (§16.3): клиент
	// подсвечивает каналы активной операции на хак-карте (плейтест M5).
	Path []string `json:"path,omitempty"`
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
			dp := deckProg{ID: pr.id, Prog: pr.prog, Dev: pr.dev, EtaMs: int64(remain * 1000), Pct: round3(pr.progress / pr.work), Path: pr.path}
			if pr.prog == "cp" || pr.prog == "mv" {
				// §16.9: остаток МБ и текущая скорость (доля канала × номинал)
				dp.Dst = pr.dst
				dp.Data = pr.data
				dp.MbLeft = int(math.Ceil(float64(pr.mb) * (1 - pr.progress/pr.work)))
				dp.Mbps = round3(pr.mbps * f / float64(n))
			}
			if pr.prog == "decrypt" {
				// §16.4: decrypt-джоба деки — тот же МБ-прогресс (NPU-доля
				// вместо канала: честная очередь всех процессов деки)
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
			"data": deckInventory(p),
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
	// автопатруль (§13.7): сервер ведёт объектив синусом от baseYaw —
	// синхронно у всех (детерминировано от now, без накопления фазы).
	for _, cam := range w.cyber.cameras {
		if !cam.patrol {
			continue
		}
		ph := float64(w.now().UnixNano()%int64(camPatrolPeriod)) / float64(camPatrolPeriod)
		cam.yaw = cam.baseYaw + camPatrolAmp*math.Sin(2*math.Pi*ph)
	}
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
			// M6-конус (§13.7): камера видит туда, куда смотрит — картинка
			// и сенсор совпадают (полуугол = полу-fov рендера). Проверяем
			// горизонтальный угол до цели; вертикаль — радиус уже покрыл.
			dx, dz := center[0]-cam.pos[0], center[2]-cam.pos[2]
			if math.Hypot(dx, dz) > 0.5 {
				ang := math.Atan2(dx, dz)
				d := math.Abs(ang - cam.yaw)
				for d > math.Pi {
					d = 2 * math.Pi - d
				}
				if d > camConeHalf {
					continue
				}
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
		// §17.2 vision-миникарта: кадр — ВСЕЙ команде владельца (было: только
		// владельцу): враг под союзной камерой — затухающая точка на миникарте
		// союзников; владельцу кадр нужен ещё и для ленты в деке.
		for _, p := range w.players {
			if !p.alive || p.team != owner.team {
				continue
			}
			w.sendTo(p.id, message{"t": "cam", "dev": cam.id, "seen": seen})
		}
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
//
// Отравление (rev 2026-11-21, решение владельца «газ отравленный»): каждый
// урон-тик внутри объёма продлевает игроку gasPoisonUntil; после выхода
// (или снятия газа — яд уже в крови) HP продолжает падать gasPoisonDPS ещё
// gasPoisonDur. Антидот — будущая механика (roadmap).
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
			// яд: урон-тик в объёме освежает отравление (источник — владелец газа)
			pl.gasPoisonUntil = now.Add(gasPoisonDur)
			pl.gasPoisonOwner = g.owner
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
	// Фаза яда: живой с активным отравлением вне урон-объёмов продолжает
	// терять HP. Мёртвым сбрасываем сразу — отравление не переживает респавн.
	for _, pl := range w.players {
		if !pl.alive {
			pl.gasPoisonUntil = time.Time{}
			continue
		}
		if pl.gasPoisonUntil.IsZero() || !now.Before(pl.gasPoisonUntil) {
			continue
		}
		if w.inArmedGas(pl.pos, now) {
			continue // внутри объёма уже жжёт объёмный DoT — яд не дублируем
		}
		debt := w.gasPoisonDebt[pl.id] + gasPoisonDPS*dt
		if whole := int(debt); whole > 0 {
			debt -= float64(whole)
			w.envDamage(pl, whole, pl.gasPoisonOwner)
		}
		w.gasPoisonDebt[pl.id] = debt
	}
}

// inArmedGas — игрок внутри хотя бы одного ОТКРЫТОГО газа за телеграфом.
func (w *world) inArmedGas(p vec3, now time.Time) bool {
	for _, g := range w.cyber.gases {
		if !g.open || g.gasArmAt.IsZero() || now.Sub(g.gasArmAt) < gasTelegraph {
			continue
		}
		if boxesOverlap(playerBoxAt(p), g.box) {
			return true
		}
	}
	return false
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
func (cs *cyberState) snapProps(now time.Time) []any {
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
			// M6-конус: ориентация объектива — наблюдаема физически, видна
			// ВСЕМ (куда смотрит камера видно и с земли); patrol — для UI.
			m["yaw"] = math.Round(d.yaw*100) / 100
			m["pitch"] = math.Round(d.pitch*100) / 100
			if d.patrol {
				m["patrol"] = true
			}
			// §13.7 REC: «камеру смотрят» — все клиенты пульсируют LED.
			if camRecActive(d, now) {
				m["rec"] = true
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
		// Корпуса устройств (§12.2, плейтест «не проходить сквозь сервера,
		// терминалы, камеры и свитчи»): то же исключение, что у дверей —
		// если игрок УЖЕ внутри (не должно случаться, но не запираем насмерть
		// спавном/телепортом), выйти можно.
		for _, db := range w.m.deviceBoxes {
			if boxesOverlap(b, db) && !boxesOverlap(playerBoxAt(pl.pos), db) {
				return true
			}
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
	if pl.carry {
		// §16.6: сейф тяжёлый — ×0.5 скорость носителя
		w.m.movePlayerScaled(pl, dt, w.doorBlocker(pl), 0.5)
		return
	}
	w.m.movePlayerBlocked(pl, dt, w.doorBlocker(pl))
}

// --- PHYSAFE (§16.6, итерация 7) -------------------------------------------

// takeSafe — space у сейфа (любой класс); несущий ×0.5 и без джек-ина.
func (w *world) takeSafe(pl *player) {
	w.physafe.carrier = pl.id
	pl.carry = true
	w.broadcast(message{"t": "extract", "team": pl.team, "by": pl.id, "stage": "taken"})
	log.Printf("room: player %d took the physafe", pl.id)
}

// dropSafe — сейф падает на месте носителя (смерть/F5/телепорт); канал
// сбрасывается (§16.6: «сейф остаётся на земле, каналы сбрасываются»).
func (w *world) dropSafe() {
	if w.physafe.carrier == 0 {
		return
	}
	if p, ok := w.players[w.physafe.carrier]; ok {
		w.physafe.pos = p.pos
		p.carry = false
	}
	w.physafe.carrier = 0
	w.cancelSafeChannel()
	log.Printf("room: physafe dropped")
}

// cancelSafeChannel — канал прерван (§16.6): прогресс теряется, рестарт —
// новый старт (+10 фрагов повторно НЕ начисляются).
func (w *world) cancelSafeChannel() {
	if w.physafe.chKind == "" {
		return
	}
	w.physafe.chKind = ""
	w.broadcast(message{"t": "extract", "team": w.physafe.chTeam, "stage": "broken"})
}

// startSafeChannel — «вскрываем 3 с» (§16.6): первый старт канала в матче
// даёт команде +10 фрагов (один раз; обрыв/рестарт не начисляют повторно).
func (w *world) startSafeChannel(kind string, pl *player) {
	w.physafe.chKind = kind
	w.physafe.chProgress = 0
	w.physafe.chBy = pl.id
	w.physafe.chTeam = pl.team
	if !w.safeFragsAwarded {
		w.safeFragsAwarded = true
		w.scores[pl.team] += 10
	}
	w.broadcast(message{"t": "extract", "team": pl.team, "by": pl.id, "stage": "channel"})
	log.Printf("room: team %d started safe channel (%s), by player %d", pl.team, kind, pl.id)
}

// inBaseZone — зона сдачи: радиус 6 м от точек спавна СВОЕЙ команды (§16.6).
func (w *world) inBaseZone(pl *player) bool {
	for _, s := range w.m.Spawns[strconv.Itoa(pl.team)] {
		dp := vec3{s[0] - pl.pos[0], 0, s[2] - pl.pos[2]}
		if dp.length() <= physafeBaseRadius {
			return true
		}
	}
	return false
}

// physafeTick — канал «вскрываем» (§16.6): авто-старт на базе у несущего;
// прерывание — смерть/отход (crack: от сейфа; base: из зоны/дроп); успех —
// broadcast extract win + matchend reason=extract (победа в матче).
func (w *world) physafeTick(dt float64) {
	if !w.physafePresent {
		return
	}
	// сейф едет с носителем (плейтест «сейф не двигается вместе со мной»):
	// позиция = позиция носителя каждый тик — уезжает в snap.props
	if w.physafe.carrier != 0 {
		if c, ok := w.players[w.physafe.carrier]; ok {
			w.physafe.pos = c.pos
		}
	}
	// доставка на базу: несущий в зоне — канал стартует сам (§16.6)
	if w.physafe.carrier != 0 && w.physafe.chKind == "" {
		if c, ok := w.players[w.physafe.carrier]; ok && w.inBaseZone(c) {
			w.startSafeChannel("base", c)
		}
	}
	if w.physafe.chKind == "" {
		return
	}
	pl, ok := w.players[w.physafe.chBy]
	if !ok || !pl.alive {
		w.cancelSafeChannel()
		return
	}
	if w.physafe.chKind == "crack" {
		// вскрытие на месте: вскрывающий стоит у сейфа (урон прерывает —
		// см. damage/envDamage)
		dp := w.physafe.pos.sub(pl.pos)
		dp[1] = 0
		if dp.length() > physafeTakeRadius+1 {
			w.cancelSafeChannel()
			return
		}
	} else if !pl.carry || !w.inBaseZone(pl) {
		// base: сейф потерян или носитель ушёл из зоны
		w.cancelSafeChannel()
		return
	}
	w.physafe.chProgress += dt
	// на месте 3 с (сейф под огнём лавы — быстро), на базе 6 с (плейтест)
	work := w.physafeCrackWork
	if w.physafe.chKind == "base" {
		work = w.physafeBaseWork
	}
	if w.tick%tickRate == 0 {
		w.broadcast(message{"t": "extract", "team": w.physafe.chTeam, "stage": "channel",
			"prog": round3(math.Min(1, w.physafe.chProgress/work))})
	}
	if w.physafe.chProgress >= work {
		team := w.physafe.chTeam
		w.broadcast(message{"t": "extract", "team": team, "stage": "win"})
		w.endMatch(team, "extract")
		// канал закрыт: матч кончился, автостарт на базе не должен
		// сработать в том же тике со старым состоянием
		w.physafe.chKind = ""
		log.Printf("room: team %d extracted the physafe — WIN", team)
	}
}

// liftTick — движение платформ и райдеры (§16.12): платформа едет вниз
// 2.8 м/с; игрок, стоящий на ней (AABB платформы, ноги в пределах), едёт —
// каждый тик его ноги прижимаются к top. Динамический коллайдер платформы
// пишется в m.dynamic ДО движения игроков — applyPhysics приземляет на неё.
func (w *world) liftTick() {
	if len(w.lifts) == 0 {
		return
	}
	for i := range w.lifts {
		l := &w.lifts[i]
		if l.moving && l.top > liftFloor1Y {
			l.top -= liftSpeed * tickDT
			if l.top <= liftFloor1Y {
				l.top = liftFloor1Y
				l.moving = false
				log.Printf("room: lift %s arrived at floor 1", l.id)
			}
		}
	}
	// райдеры: ноги на платформе (или чуть в воздухе над ней — едем вместе)
	for i := range w.lifts {
		l := &w.lifts[i]
		for _, pl := range w.players {
			if !pl.alive || pl.jacked {
				continue
			}
			if math.Abs(pl.pos[0]-l.x) > l.half+playerHalf || math.Abs(pl.pos[2]-l.z) > l.half+playerHalf {
				continue
			}
			if pl.pos[1] >= l.top-0.15 && pl.pos[1] <= l.top+0.4 {
				pl.pos[1] = l.top
				pl.vy = 0
				pl.grounded = true
			}
		}
	}
	// динамические коллайдеры — платформы как пол (приземление applyPhysics)
	// + КРЫШКА: спущенный лифт оставлял ОТКРЫТУЮ ДЫРУ в плите 2F (плейтест:
	// «тупо дыра остаётся… проваливаешься») — после прибытия платформы
	// проём закрывается стальной крышкой на уровне пола 2F
	dyn := make([]collider, 0, len(w.lifts))
	for i := range w.lifts {
		l := &w.lifts[i]
		dyn = append(dyn, collider{
			Min:  [3]float64{l.x - l.half, l.top - l.thick, l.z - l.half},
			Max:  [3]float64{l.x + l.half, l.top, l.z + l.half},
			Kind: "floor",
		})
		if l.top <= liftFloor1Y+0.01 && !l.moving {
			dyn = append(dyn, collider{
				Min:  [3]float64{l.x - l.half, liftFloor2Y - l.thick, l.z - l.half},
				Max:  [3]float64{l.x + l.half, liftFloor2Y, l.z + l.half},
				Kind: "floor",
			})
		}
	}
	w.m.dynamic = dyn
}

// pressLiftButton — физическая кнопка на 2F (space, любой класс; §16.12):
// лифт вверх → старт спуска; использованный лифт отвечает отказом.
func (w *world) pressLiftButton(pl *player, btnID string) {
	var btn *mapProp
	for i := range w.m.props {
		if w.m.props[i].Kind == "liftbtn" && w.m.props[i].ID == btnID {
			btn = &w.m.props[i]
		}
	}
	if btn == nil {
		return
	}
	dp := vec3{btn.Pos[0] - pl.pos[0], 0, btn.Pos[2] - pl.pos[2]}
	if dp.length() > liftBtnRadius {
		w.dataDenied(pl, "too_far", "liftbtn", btnID)
		return
	}
	for i := range w.lifts {
		l := &w.lifts[i]
		if l.id != btn.To || l.moving {
			continue
		}
		if l.top <= liftFloor1Y+0.01 {
			w.dataDenied(pl, "used", "liftbtn", btnID) // спущен — один раз за матч
			return
		}
		l.moving = true
		log.Printf("room: player %d called lift %s down", pl.id, l.id)
		return
	}
}

// enterPhysafe — ввод кода сейфа у PHYSAFE (§16.6): {"t":"enter",
// "dev":"physafe","code":"8241"}. Вернный код стартует канал crack «вскрываем
// 3 с» — гейт лавы lv3 остаётся: стоит в огне = урон = обрыв канала.
func (w *world) enterPhysafe(pl *player, msg message) {
	if !pl.alive || pl.jacked {
		w.dataDenied(pl, "not_jacked", "enter", "")
		return
	}
	if pl.carry || w.physafe.carrier != 0 {
		w.dataDenied(pl, "bad_target", "enter", "")
		return
	}
	dp := w.physafe.pos.sub(pl.pos)
	dp[1] = 0
	if dp.length() > physafeTakeRadius+0.7 {
		w.dataDenied(pl, "too_far", "enter", "")
		return
	}
	now := w.now()
	flood := !pl.enterAt.IsZero() && now.Sub(pl.enterAt) < 2*time.Second
	if !flood {
		pl.enterAt = now
	}
	code := str(msg, "code")
	if code != w.safeCode {
		if flood {
			w.sendTo(pl.id, message{"t": "code", "dev": "physafe", "ok": false, "match": -1})
			return
		}
		w.sendTo(pl.id, message{"t": "code", "dev": "physafe", "ok": false, "match": hintMatch(w.safeCode, code)})
		return
	}
	// всегда отвечаем — молчание вешает пад на «ПРОВЕРКА…»
	w.sendTo(pl.id, message{"t": "code", "dev": "physafe", "ok": true})
	if w.physafe.chKind == "" {
		w.startSafeChannel("crack", pl)
	}
	log.Printf("room: player %d entered the safe code at the physafe", pl.id)
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
