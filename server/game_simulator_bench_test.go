package main

// game_simulator_bench — симулятор матчей 4×4 на боевом коде сервера
// (запрос владельца 2026-11-20): боты играют через НАСТОЯЩИЙ протокол
// (handleMessage: input/fire/run/ctrl/enter/respawn/jackout), сервер
// авторитарно симулирует 30 Гц, инъекция часов делает прогон быстрым.
// Цель — измерить баланс: win-rate по составам/стратегиям/сторонам,
// таймлайны целей (door code → vault → valve → carry/crack), ценность
// контр-механик (щит SRV, backoff сейфа, antivirus/firewall/watcher, газ,
// пеленг/радар/камеры, брутфорс клавиатур) и найти дыры.
//
// Файл — _test.go сознательно: доступ к unexported-внутренностям (world,
// player, device, program) без попадания в прод-бинарник; `go test ./...`
// компилирует и vet'ит его всегда, а прогон запускается явно:
//
//	cd server && go test -run TestSimulatorBench -count=1 \
//	  -sim.games=1000 -sim.out=/tmp/gamesim -sim.tag=mixed
//
// Флаги: -sim.games N (0 = skip в обычном `go test ./...`), -sim.workers,
// -sim.seed, -sim.tag, -sim.out, -sim.teams "план0,план1" (фиксация
// хакер-стратегий для абляций), -sim.comps "comp0,comp1", -sim.passive 1|2
// (команда-жертва: держит базу, к целям не идёт).
//
// Честность ботов: своё состояние (pl.progs/scanned/items) и публичный мир
// (двери/клапан/physafe — snapProps виден всем) читается напрямую; враги —
// только через перцепцию (LOS+дистанция+FOV) и интеллект-каналы реального
// протокола (cam-лента, report, radar, alert, extract). Симметрично для
// обеих команд, поэтому смещение win-rate — свойство правил, а не ботов.

import (
	"container/heap"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	simGames   = flag.Int("sim.games", 0, "сколько матчей прогнать (0 = пропустить)")
	simWorkers = flag.Int("sim.workers", runtime.NumCPU(), "параллельные воркеры")
	simSeed    = flag.Int64("sim.seed", 20261120, "базовый сид")
	simTag     = flag.String("sim.tag", "run", "суффикс файлов результата")
	simOut     = flag.String("sim.out", "/tmp/gamesim", "каталог результатов")
	simTeams   = flag.String("sim.teams", "", "фикс. стратегии хакеров: \"план0,план1\"")
	simComps   = flag.String("sim.comps", "", "фикс. составы: \"comp0,comp1\"")
	simPassive = flag.Int("sim.passive", 0, "команда-жертва (1|2): держит базу, к целям не идёт")
	simFixVault = flag.Bool("sim.fixvault", false, "абляция: d5/d6 размер [0.3,3,4] (закрыть обход хранилища)")
	simSquads   = flag.String("sim.squads", "", "фикс. планы мяса: \"squad0,squad1\"")
	simBaseWork = flag.Float64("sim.basework", 0, "абляция: длительность base-канала physafe, с (0 = константа ГДД)")
)

// fixVaultDoors — абляционная правка геометрии: створки d5/d6 лежат ПОПЕРЁК
// проёма стены хранилища ([4,3,0.3]), оставляя по 1.85 м прохода с боков —
// хранилище обходится без кода. Поворот бокса ([0.3,3,4]) закрывает проём.
// Только для бенча: карту меняем только через владельца/ГДД.
func fixVaultDoors(m *gameMap) {
	for i := range m.props {
		p := &m.props[i]
		if p.Kind == "door" && (p.ID == "d5" || p.ID == "d6") {
			p.Size = [3]float64{0.3, p.Size[1], p.Size[0]}
		}
	}
}

// simTraceT — отладочный вывод одного матча (TestSimDebug перенесён сюда);
// в нормальных прогонах nil, накладных расходов нет.
var simTraceT *testing.T

func TestSimulatorBench(t *testing.T) {
	if *simGames <= 0 {
		t.Skip("bench disabled: pass -sim.games=N")
	}
	log.SetOutput(io.Discard) // серверные log.Printf душат тысячекратный прогон
	if err := os.MkdirAll(*simOut, 0o755); err != nil {
		t.Fatalf("outdir: %v", err)
	}
	ref, err := parseGameMap(h2dm1JSON)
	if err != nil {
		t.Fatalf("map: %v", err)
	}
	ng := buildNavGrid(ref) // статическая геометрия одинакова у каждого парса
	ngFix := ng
	if *simFixVault {
		refFix, err := parseGameMap(h2dm1JSON)
		if err != nil {
			t.Fatalf("map: %v", err)
		}
		fixVaultDoors(refFix)
		ngFix = buildNavGrid(refFix)
	}

	path := filepath.Join(*simOut, fmt.Sprintf("games_%s.jsonl", *simTag))
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	defer f.Close()
	jw := &jsonlWriter{f: f}

	jobs := make(chan int64, 64)
	var mu sync.Mutex
	var results []gameResult
	var wg sync.WaitGroup
	started := time.Now()
	for i := 0; i < *simWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for seed := range jobs {
				res := runSimGame(seed, ng, ngFix)
				mu.Lock()
				results = append(results, res)
				mu.Unlock()
				jw.write(res)
			}
		}()
	}
	for i := 0; i < *simGames; i++ {
		jobs <- *simSeed + int64(i)
	}
	close(jobs)
	wg.Wait()

	summary := computeSummary(results, time.Since(started))
	sumPath := filepath.Join(*simOut, fmt.Sprintf("summary_%s.json", *simTag))
	if b, err := json.MarshalIndent(summary, "", "  "); err == nil {
		_ = os.WriteFile(sumPath, b, 0o644)
	}
	b, _ := json.MarshalIndent(summary, "", "  ")
	t.Logf("done: %d games in %v\n%s", len(results), time.Since(started).Round(time.Second), b)
}

type jsonlWriter struct {
	f  *os.File
	mu sync.Mutex
}

func (w *jsonlWriter) write(r gameResult) {
	b, err := json.Marshal(r)
	if err != nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	_, _ = w.f.Write(append(b, '\n'))
}

// --- составы и стратегии ---------------------------------------------------

var compPresets = map[string][]string{
	"3AR":      {"assault", "assault", "assault"},
	"2AR+SN":   {"assault", "assault", "sniper"},
	"3HV":      {"heavy", "heavy", "heavy"},
	"2HV+SN":   {"heavy", "heavy", "sniper"},
	"2SN+AR":   {"sniper", "sniper", "assault"},
	"SN+2HV":   {"sniper", "heavy", "heavy"},
	"AR+HV+SN": {"assault", "heavy", "sniper"},
	"3SN":      {"sniper", "sniper", "sniper"},
	// noh4* — БЕЗ хакера, 4 «мяса» (сценарии владельца 2026-11-21: «у одной
	// команды хакер есть, у других только мясные»; noh4SN3HV — «1 снайпер и
	// 3 хеви ломятся сразу на второй этаж»)
	"noh4":      {"assault", "heavy", "sniper", "assault"},
	"noh4SN3HV": {"sniper", "heavy", "heavy", "heavy"},
}

var compNames = []string{"3AR", "2AR+SN", "3HV", "2HV+SN", "2SN+AR", "SN+2HV", "AR+HV+SN", "3SN"}

// noHacker — составы без хакера (4 мяса вместо хакер+3).
func noHacker(comp string) bool { return strings.HasPrefix(comp, "noh4") }

func pickComp(rng *rand.Rand) string {
	if rng.Float64() < 0.3 {
		return "rnd"
	}
	return compNames[rng.Intn(len(compNames))]
}

func meatClasses(comp string, rng *rand.Rand) []string {
	if comp == "noh4" {
		pool := []string{"assault", "assault", "heavy", "heavy", "sniper"}
		out := make([]string, 4)
		for i := range out {
			out[i] = pool[rng.Intn(len(pool))]
		}
		return out
	}
	if comp != "rnd" {
		return append([]string(nil), compPresets[comp]...)
	}
	pool := []string{"assault", "assault", "assault", "heavy", "heavy", "sniper"}
	out := make([]string, 3)
	for i := range out {
		out[i] = pool[rng.Intn(len(pool))]
	}
	return out
}

var hackerPlans = []string{"door_rush", "safe_rush", "hybrid", "defense", "disrupt", "valve_siege", "valve_brute"}

func pickHackerPlan(rng *rand.Rand) string {
	weights := []float64{0.26, 0.15, 0.11, 0.15, 0.15, 0.11, 0.07}
	r := rng.Float64()
	for i, w := range weights {
		if r < w {
			return hackerPlans[i]
		}
		r -= w
	}
	return "door_rush"
}

var squadPlans = []string{"escort", "push", "hold", "hunt", "cover_brute", "wave", "assassin"}

func pickSquadPlan(rng *rand.Rand) string {
	weights := []float64{0.25, 0.3, 0.1, 0.15, 0.1, 0.05, 0.05}
	r := rng.Float64()
	for i, w := range weights {
		if r < w {
			return squadPlans[i]
		}
		r -= w
	}
	return "push"
}

// --- навигационная сетка (высотное поле карты + A*) ------------------------

const (
	navLava = 1
	navGas  = 2
)

type navNode struct {
	x, z, h float64
	flags   uint8
	door    string // проп двери, перекрывающий точку стояния
}

type navGrid struct {
	cs        float64
	w, h      int
	nodes     []navNode
	cells     map[[2]int][]int32
	adj       [][]int32
	colliders []collider
	devBoxes  []aabb
}

// buildNavGrid — один раз на процесс: стоячие точки (пол 1F/2F + ступени),
// рёбра по правилам физики (autostep 0.55), лава/газ/двери — флаги и метки.
func buildNavGrid(m *gameMap) *navGrid {
	ng := &navGrid{
		cs: 0.5, w: int(m.Bounds[0] / 0.5), h: int(m.Bounds[2] / 0.5),
		colliders: m.Colliders, cells: make(map[[2]int][]int32),
	}
	for _, p := range m.props { // корпуса устройств — препятствия (как buildCyber)
		half := deviceHalfExtents(p.Kind)
		if half == (vec3{}) {
			continue
		}
		ng.devBoxes = append(ng.devBoxes, aabb{
			min: vec3{p.Pos[0] - half[0], p.Pos[1], p.Pos[2] - half[2]},
			max: vec3{p.Pos[0] + half[0], p.Pos[1] + half[1], p.Pos[2] + half[2]},
		})
	}
	type volBox struct {
		id  string
		box aabb
	}
	var doorBoxes, fireBoxes, gasBoxes []volBox
	for _, p := range m.props {
		if p.Kind == "door" {
			doorBoxes = append(doorBoxes, volBox{p.ID, aabb{
				min: vec3{p.Pos[0] - p.Size[0]/2, p.Pos[1], p.Pos[2] - p.Size[2]/2},
				max: vec3{p.Pos[0] + p.Size[0]/2, p.Pos[1] + p.Size[1], p.Pos[2] + p.Size[2]/2},
			}})
		}
		if p.Kind == "fire" || p.Kind == "gas" {
			b := aabb{
				min: vec3{p.Pos[0] - p.Size[0]/2, p.Pos[1] - p.Size[1]/2, p.Pos[2] - p.Size[2]/2},
				max: vec3{p.Pos[0] + p.Size[0]/2, p.Pos[1] + p.Size[1]/2, p.Pos[2] + p.Size[2]/2},
			}
			if p.Kind == "fire" {
				fireBoxes = append(fireBoxes, volBox{p.ID, b})
			} else {
				gasBoxes = append(gasBoxes, volBox{p.ID, b})
			}
		}
	}
	// blockedAt для НАВИГЕЦИИ мягче физики: препятствия не выше 0.55 над
	// ногами (autostep) и потолки выше головы — не блок. Без этого первая
	// ступень лестницы оставляла «ров» из заблокированной ячейки и этажи
	// не соединялись.
	blockedAt := func(x, y, z float64) bool {
		b := playerBoxAt(vec3{x, y, z})
		hit := func(min, max vec3) bool {
			if !boxesOverlap(b, aabb{min, max}) {
				return false
			}
			return max[1] > y+0.55 && min[1] < y+1.8
		}
		for i := range ng.colliders {
			if hit(vec3(ng.colliders[i].Min), vec3(ng.colliders[i].Max)) {
				return true
			}
		}
		for _, db := range ng.devBoxes {
			if hit(db.min, db.max) {
				return true
			}
		}
		return false
	}
	for gx := 0; gx < ng.w; gx++ {
		for gz := 0; gz < ng.h; gz++ {
			cx := (float64(gx) + 0.5) * ng.cs
			cz := (float64(gz) + 0.5) * ng.cs
			tops := map[float64]bool{}
			for i := range m.Colliders {
				c := &m.Colliders[i]
				if c.Kind == "wall" {
					continue
				}
				if c.Max[0] <= cx-ng.cs/2 || c.Min[0] >= cx+ng.cs/2 ||
					c.Max[2] <= cz-ng.cs/2 || c.Min[2] >= cz+ng.cs/2 {
					continue
				}
				if t := c.Max[1]; t >= 0.9 && t <= 9.0 {
					tops[math.Round(t*4)/4] = true
				}
			}
			ts := make([]float64, 0, len(tops))
			for tv := range tops {
				ts = append(ts, tv)
			}
			sort.Float64s(ts)
			for _, t := range ts {
				if blockedAt(cx, t, cz) {
					continue
				}
				n := navNode{x: cx, z: cz, h: t}
				b := playerBoxAt(vec3{cx, t, cz})
				for _, fb := range fireBoxes {
					if boxesOverlap(b, fb.box) {
						n.flags |= navLava
					}
				}
				for _, gb := range gasBoxes {
					if boxesOverlap(b, gb.box) {
						n.flags |= navGas
					}
				}
				for _, db := range doorBoxes {
					if boxesOverlap(b, db.box) {
						n.door = db.id
					}
				}
				key := [2]int{gx, gz}
				ng.cells[key] = append(ng.cells[key], int32(len(ng.nodes)))
				ng.nodes = append(ng.nodes, n)
			}
		}
	}
	ng.adj = make([][]int32, len(ng.nodes))
	for i := range ng.nodes {
		n := &ng.nodes[i]
		gx := int(n.x / ng.cs)
		gz := int(n.z / ng.cs)
		for _, d := range [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			for _, j := range ng.cells[[2]int{gx + d[0], gz + d[1]}] {
				m2 := &ng.nodes[j]
				dh := m2.h - n.h
				if dh > 0.55 || dh < -0.55 {
					continue // autostep
				}
				feet := math.Max(n.h, m2.h)
				if blockedAt((n.x+m2.x)/2, feet, (n.z+m2.z)/2) {
					continue
				}
				ng.adj[i] = append(ng.adj[i], j)
			}
		}
	}
	return ng
}

type apqItem struct {
	idx int32
	f   float64
}
type apq []apqItem

func (q apq) Len() int           { return len(q) }
func (q apq) Less(i, j int) bool { return q[i].f < q[j].f }
func (q apq) Swap(i, j int)      { q[i], q[j] = q[j], q[i] }
func (q *apq) Push(x any)        { *q = append(*q, x.(apqItem)) }
func (q *apq) Pop() any {
	old := *q
	n := len(old)
	it := old[n-1]
	*q = old[:n-1]
	return it
}

// nearestNode — узел рядом с позицией (приоритет своему этажу по высоте:
// штраф за разницу высот доминирует над дистанцией в радиусе поиска).
func (ng *navGrid) nearestNode(p vec3) int32 {
	gx := int(p[0] / ng.cs)
	gz := int(p[2] / ng.cs)
	best := int32(-1)
	bestD := math.Inf(1)
	for dx := -4; dx <= 4; dx++ {
		for dz := -4; dz <= 4; dz++ {
			for _, i := range ng.cells[[2]int{gx + dx, gz + dz}] {
				n := &ng.nodes[i]
				dh := n.h - p[1]
				d := (n.x-p[0])*(n.x-p[0]) + (n.z-p[2])*(n.z-p[2]) + dh*dh*16
				if d < bestD {
					bestD, best = d, i
				}
			}
		}
	}
	return best
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// path — A*: from→to; pass решает проходимость узлов-дверей, extra
// добавляет штраф за флаги (лава/газ — мировое состояние).
func (ng *navGrid) path(from, to vec3, pass func(string) bool, extra func(uint8) float64) []navNode {
	s, t := ng.nearestNode(from), ng.nearestNode(to)
	if s < 0 || t < 0 {
		return nil
	}
	if s == t {
		return nil
	}
	n := len(ng.nodes)
	g := make([]float64, n)
	came := make([]int32, n)
	closed := make([]bool, n)
	for i := range g {
		g[i] = math.Inf(1)
		came[i] = -1
	}
	g[s] = 0
	tgt := &ng.nodes[t]
	hEst := func(i int32) float64 {
		nd := &ng.nodes[i]
		return math.Hypot(nd.x-tgt.x, nd.z-tgt.z)
	}
	h := &apq{}
	heap.Push(h, apqItem{s, hEst(s)})
	for h.Len() > 0 {
		cur := heap.Pop(h).(apqItem)
		if closed[cur.idx] {
			continue
		}
		closed[cur.idx] = true
		if cur.idx == t {
			break
		}
		nd := &ng.nodes[cur.idx]
		for _, nb := range ng.adj[cur.idx] {
			if closed[nb] {
				continue
			}
			m := &ng.nodes[nb]
			if m.door != "" && pass != nil && !pass(m.door) {
				continue
			}
			w := math.Hypot(m.x-nd.x, m.z-nd.z) + 0.01
			if extra != nil {
				w += extra(m.flags)
			}
			if m.door != "" {
				w += 2 // двери — не любим даже проходимые
			}
			if ng2 := g[cur.idx] + w; ng2 < g[nb] {
				g[nb] = ng2
				came[nb] = cur.idx
				heap.Push(h, apqItem{nb, ng2 + hEst(nb)})
			}
		}
	}
	if came[t] < 0 {
		return nil
	}
	var out []navNode
	for at := t; at != s; at = came[at] {
		if came[at] < 0 {
			return nil
		}
		out = append(out, ng.nodes[at])
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}

// --- результаты ------------------------------------------------------------

type playerStat struct {
	ID           uint64  `json:"id"`
	Team         int     `json:"team"`
	Cls          string  `json:"cls"`
	Skill        float64 `json:"skill"`
	Frags        int     `json:"frags"`
	Deaths       int     `json:"deaths"`
	JackedDeaths int     `json:"jackedDeaths"`
	JackedS      float64 `json:"jackedS"`
	ProgsRun     int     `json:"progsRun"`
	Trojans      int     `json:"trojans"`
	Decrypts     int     `json:"decrypts"`
	Shots        int     `json:"shots"`
	Hits         int     `json:"hits"`
}

type objectivesStat struct {
	DoorCodeT        [2]float64 `json:"doorCodeT"`
	SafeCodeT        [2]float64 `json:"safeCodeT"`
	FirstChannelT    float64    `json:"firstChannelT"`
	ExtractAttempts  [2]int     `json:"extractAttempts"`
	SafeTaken        [2]int     `json:"safeTaken"`
	CarrierDeaths    [2]int     `json:"carrierDeaths"`
	VaultOpenT       float64    `json:"vaultOpenT"`
	ValveOpenS       float64    `json:"valveOpenS"`
	GasKills         [2]int     `json:"gasKills"`
	GasArms          [2]int     `json:"gasArms"`
	LavaKills        int        `json:"lavaKills"`
	EnvNeutral       int        `json:"envNeutral"`
	ShieldBurns      [2]int     `json:"shieldBurns"`
	AntivirusBlocks  [2]int     `json:"antivirusBlocks"`
	BackoffMax       int        `json:"backoffMax"`
	FirewallScanHits int        `json:"firewallScanHits"`
	Alerts           [2]int     `json:"alerts"`
	RadarMsgs        [2]int     `json:"radarMsgs"`
	CamFrames        [2]int     `json:"camFrames"`
	BruteTries       int        `json:"bruteTries"`
	BruteDoorT       [2]float64 `json:"bruteDoorT"` // когда команда вскрыла дверь брутом
	BruteSafeT       [2]float64 `json:"bruteSafeT"` // когда команда вскрыла сейф брутом
}

type combatStat struct {
	Kills       int `json:"kills"`
	FFKills     int `json:"ffKills"`
	HackerKills int `json:"hackerKills"`
	EnvKills    int `json:"envKills"`
	TotalShots  int `json:"totalShots"`
	TotalHits   int `json:"totalHits"`
}

type gameResult struct {
	Seed       int64          `json:"seed"`
	Winner     int            `json:"winner"` // -1 = ничья
	Reason     string         `json:"reason"`
	DurationS  float64        `json:"durationS"`
	Scores     [2]int         `json:"scores"`
	Comp       [2]string      `json:"comp"`
	Plan       [2]string      `json:"plan"`
	Squad      [2]string      `json:"squad"`
	Brute      [2]bool        `json:"brute"`
	Passive    int            `json:"passive"`
	Players    []playerStat   `json:"players"`
	Objectives objectivesStat `json:"objectives"`
	Combat     combatStat     `json:"combat"`
}

// --- матч-движок -----------------------------------------------------------

type teamBB struct {
	team         int
	comp         string
	plan         string // план хакера
	squad        string // план мяса
	brute        bool
	passive      bool
	doorCode     string
	safeCode     string
	carrierID    uint64
	enemyCarrier uint64

	// relay-брут (план мяса cover_brute): угадайка общекомандная, пробует
	// один бот за раз (ротация). Анти-флуд сервера персональный (player.
	// enterAt), поэтому N ботов у клавиатуры = N-кратная каденция перебора —
	// так и задумано: кооп-брутфорс легитимен. relay2 — то же для КОДА
	// СЕЙФА (фаза 2, требует открытого клапана — без лавы).
	relay    *codeGuesser
	relayBy  uint64 // чья проба в полёте (ответ этого бота кормит relay)
	relay2   *codeGuesser
	relay2By uint64
}

type intelPos struct {
	p      vec3
	at     time.Time
	jacked bool
	by     uint64 // кто виден в метке (radar/cam ID; 0 — устройство/неизвестно)
}

type simBot struct {
	pl   *player
	team int
	role string // "hacker" | "meat" | "brute"
	cls  string
	name string

	skill    float64
	reactS   float64
	prefMin  float64
	prefMax  float64

	visTarget  *player
	visDist    float64
	visAt      time.Time
	lastTgtID  uint64
	reactUntil time.Time
	strafe     float64
	strafeAt   time.Time

	threatAt  time.Time
	threat    bool
	threatD   float64

	goal      vec3
	goalSet   bool
	path      []navNode
	pathI     int
	repathCD  time.Time
	stuckN    int
	lastPos   vec3
	lastPosAt time.Time

	wantInteract bool
	enterCD      time.Time
	doorKp       string
	tickN        int
	doorCodeAt   time.Time // когда команда последний раз декриптила door_key

	wasJacked bool
	wasCarry  bool

	intel []intelPos

	inbox []message

	hh hackerBrain
	mm meatBrain

	// статистика
	frags, deaths, jackedDeaths int
	jackedS                     float64
	progsRun, trojans, decrypts int
	shots, hits                 int
	chaffSeen                   string
}

type hackerBrain struct {
	plan       string
	phase      string // entry | crack | guard | brute
	ops        []hackOp
	cur        *hackOp
	entry      string
	entryTries int
	scanCap    int
	valve      bool // нужен ли v3 в плане
	gasDev     string
	doorDev    string
	srvTries   int
	chaffLeft  int
	gasOpen    map[string]time.Time // когда какой свой газ открыт («закрыть через 5 с пустоты»)
	placed     map[string]bool
	guesser    *codeGuesser // valve_brute: физический перебор кода двери после клапана
}

type hackOp struct {
	kind     string // scan|vuln|trojan|watcher|firewall|antivirus|cp|rm|decrypt|ctrl
	dev      string
	dst      string
	data     string
	sent     bool
	tries    int
	deadline time.Time
	waitCD   time.Time
}

type meatBrain struct {
	plan      string // escort|push|hold|hunt|brute
	vaultDoor string
	wp        int
	bruteSafe bool
	guesser   codeGuesser // код двери
	guesser2  codeGuesser // код сейфа
	phase     int         // брутер: 0 дверь, 1 сейф/вынос
}

type simGame struct {
	seed       int64
	rng        *rand.Rand
	w          *world
	ng         *navGrid
	clock      time.Time
	bots       []*simBot
	bb         [2]*teamBB
	matchStart time.Time
	prevChKind string
	gasWasOpen map[string]bool
	ev         objectivesStat
	cb         combatStat
	done       bool
	res        gameResult
	keypads    map[string][]*mapProp
}

func runSimGame(seed int64, ng, ngFix *navGrid) gameResult {
	rng := rand.New(rand.NewSource(seed))
	m, err := parseGameMap(h2dm1JSON)
	if err != nil {
		panic(err)
	}
	if *simFixVault {
		fixVaultDoors(m)
		ng = ngFix
	}
	w := newWorld(m)
	g := &simGame{seed: seed, rng: rng, w: w, ng: ng, keypads: map[string][]*mapProp{},
		gasWasOpen: map[string]bool{}}
	g.clock = time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC).Add(time.Duration(seed%97) * time.Minute)
	w.now = func() time.Time { return g.clock }
	w.resetDoorKey() // привязать matchStart/коды к фейковым часам (детерминизм)
	for i := range m.props {
		if m.props[i].Kind == "keypad" {
			p := &m.props[i]
			g.keypads[p.To] = append(g.keypads[p.To], p)
		}
	}

	// конфигурация команд
	comp := [2]string{pickComp(rng), pickComp(rng)}
	plan := [2]string{pickHackerPlan(rng), pickHackerPlan(rng)}
	squad := [2]string{pickSquadPlan(rng), pickSquadPlan(rng)}
	brute := [2]bool{rng.Float64() < 0.08, rng.Float64() < 0.08}
	if *simComps != "" {
		parts := strings.Split(*simComps, ",")
		if len(parts) == 2 {
			comp = [2]string{parts[0], parts[1]}
		}
	}
	if *simTeams != "" {
		parts := strings.Split(*simTeams, ",")
		if len(parts) == 2 {
			plan = [2]string{parts[0], parts[1]}
			brute = [2]bool{false, false}
		}
	}
	if *simSquads != "" {
		parts := strings.Split(*simSquads, ",")
		if len(parts) == 2 {
			squad = [2]string{parts[0], parts[1]}
		}
	}
	for t := 0; t < 2; t++ {
		g.bb[t] = &teamBB{team: t, comp: comp[t], plan: plan[t], squad: squad[t],
			brute: brute[t], passive: *simPassive == t+1}
	}

	// игроки: по хакеру и 3 мясо в команде (spawnBot сам делает addPlayer —
	// второй вызов заменял w.players[id] новым объектом, а боты держали
	// протухший указатель и «водили» мёртвые тела); noh4* — 4 мяса без хакера
	id := uint64(1)
	for t := 0; t < 2; t++ {
		if noHacker(comp[t]) {
			for _, c := range meatClasses(comp[t], rng) {
				g.spawnBot(id, t, "meat", c)
				id++
			}
			continue
		}
		g.spawnBot(id, t, "hacker", "hacker")
		id++
		cls := meatClasses(comp[t], rng)
		for i, c := range cls {
			role := "meat"
			if i == 0 && brute[t] {
				role = "brute"
			}
			g.spawnBot(id, t, role, c)
			id++
		}
	}
	if *simBaseWork > 0 {
		w.physafeBaseWork = *simBaseWork // абляция длительности base-канала
	}
	g.matchStart = w.matchEndsAt.Add(-w.matchLen)
	if simTraceT != nil {
		for _, p := range w.players {
			simTraceT.Logf("ADD id=%d name=%s team=%d", p.id, p.name, p.team)
		}
	}

	// скилл: командный базис ± разброс (симметрично по сидам)
	teamSkill := [2]float64{0.75 + rng.Float64()*0.5, 0.75 + rng.Float64()*0.5}
	for _, b := range g.bots {
		s := teamSkill[b.team] + rng.NormFloat64()*0.12
		s = math.Max(0.5, math.Min(1.5, s))
		b.skill = s
		b.reactS = 0.12 + 0.30*(s-0.5)
		b.setWeaponPrefs()
		b.initBrain(g)
	}

	g.res = gameResult{Seed: seed, Winner: -1, Comp: comp, Plan: plan, Squad: squad,
		Brute: brute, Passive: *simPassive}
	g.loop()
	return g.res
}

func (g *simGame) spawnBot(id uint64, team int, role, cls string) {
	name := fmt.Sprintf("%s-%s%d-%d", cls, role, team, id)
	pl := g.w.addPlayer(id, name, cls, team)
	if pl.team != team {
		// балансировочный гейт addPlayer отклоняет wantTeam при последовательном
		// наборе одной команды («перекос ≥2»); для бенча составы фиксированы —
		// чиним команду и респавним на своей стороне
		pl.team = team
		g.w.spawnPlayer(pl, cls)
	}
	b := &simBot{pl: pl, team: team, role: role, name: name, cls: cls}
	if role == "hacker" {
		b.hh.plan = g.bb[team].plan
		b.hh.phase = "entry"
		b.hh.placed = map[string]bool{}
		b.hh.scanCap = 4 + g.rng.Intn(4)
		b.hh.valve = g.rng.Float64() < 0.5
		if b.hh.plan == "valve_siege" {
			b.hh.valve = true
		}
		if b.hh.plan == "disrupt" {
			if team == 0 {
				b.hh.gasDev, b.hh.doorDev = "g2", "d1"
			} else {
				b.hh.gasDev, b.hh.doorDev = "g1", "d2"
			}
		}
		if b.hh.plan == "defense" {
			b.hh.chaffLeft = 4 + g.rng.Intn(4)
		}
	}
	g.bots = append(g.bots, b)
}

func (b *simBot) setWeaponPrefs() {
	switch b.pl.cls {
	case "sniper":
		b.prefMin, b.prefMax = 13, 26
	case "heavy":
		b.prefMin, b.prefMax = 5, 12
	case "hacker":
		b.prefMin, b.prefMax = 6, 13
	default:
		b.prefMin, b.prefMax = 8, 16
	}
}

func (b *simBot) initBrain(g *simGame) {
	if b.role == "hacker" {
		return
	}
	bb := g.bb[b.team]
	b.mm.plan = bb.squad
	if bb.passive {
		b.mm.plan = "hold"
	}
	if b.role == "brute" || bb.brute {
		b.mm.plan = "brute"
		b.mm.bruteSafe = g.rng.Float64() < 0.6 // после двери брутить и код сейфа
	}
	// дверь хранилища: своя сторона предпочитает свой борт; альтернативы
	// ЗЕРКАЛЬНЫ (d4↔d3 — точечная симметрия карты): раньше обе команды
	// фолбэчились на d4/d3 с клавиатурами на восточной стороне — лишние
	// метры только для запада
	r := g.rng.Float64()
	if b.team == 0 {
		switch {
		case r < 0.5:
			b.mm.vaultDoor = "d5"
		case r < 0.75:
			b.mm.vaultDoor = "d4"
		default:
			b.mm.vaultDoor = "d3"
		}
	} else {
		switch {
		case r < 0.5:
			b.mm.vaultDoor = "d6"
		case r < 0.75:
			b.mm.vaultDoor = "d3"
		default:
			b.mm.vaultDoor = "d4"
		}
	}
}

func (g *simGame) loop() gameResult {
	const maxTicks = 18600 // чуть больше лимита матча (10 мин = 18000 тиков)
	for t := 0; t < maxTicks && !g.done; t++ {
		if simTraceT != nil && g.w.tick%300 == 0 {
			for _, b := range g.bots {
				cur := "nil"
				if b.hh.cur != nil {
					cur = fmt.Sprintf("%s:%s sent=%v tries=%d", b.hh.cur.kind, b.hh.cur.dev, b.hh.cur.sent, b.hh.cur.tries)
				}
				simTraceT.Logf("t=%d p%d(%s,bot%d,pl%d,%s) pos=(%.1f,%.1f,%.1f) hp=%d alive=%v ticks=%d goal=(%.1f,%.1f,%.1f) n=%d pi=%d plan=%s vdoor=%s phase=%s entry=%q cur=%s ops=%d scanned=%d",
					g.w.tick, b.pl.id, b.role, b.team, b.pl.team, b.pl.cls, b.pl.pos[0], b.pl.pos[1], b.pl.pos[2], b.pl.hp, b.pl.alive, b.tickN,
					b.goal[0], b.goal[1], b.goal[2], len(b.path), b.pathI, b.mm.plan, b.mm.vaultDoor, b.hh.phase, b.hh.entry,
					cur, len(b.hh.ops), len(b.pl.scanned))
				if b.pl.jackHost != nil {
					simTraceT.Logf("   p%d host=%s jacking=%v", b.pl.id, b.pl.jackHost.id, b.pl.jacking != nil)
				}
				if b.role == "hacker" && b.pl.id == 1 && b.pl.jackHost != nil {
					if d := g.w.cyber.devices["srv1"]; d != nil {
						vulns := ""
						for uid := range d.vulnedBy {
							vulns += fmt.Sprintf("%d,", uid)
						}
						progs := ""
						for _, pp := range b.pl.progs {
							progs += fmt.Sprintf("%s(%s,%.1f/%.1f) ", pp.prog, pp.dev, pp.progress, pp.work)
						}
						fw := ""
						for _, dd := range g.w.cyber.devices {
							if dd.firewalled != 0 {
								fw += dd.id + " "
							}
						}
						simTraceT.Logf("   SRV1 owner=%d shield=%d vulnedBy=[%s] myprogs=[%s] srv1scanned=%v reach=%v fw=[%s]",
							d.owner, d.shield, vulns, progs, b.pl.scanned["srv1"],
							g.w.reachableFor(b.pl.jackHost.id, b.pl)["srv1"], fw)
					}
				}
			}
		}
		for _, b := range g.bots {
			if simTraceT != nil && b.pl.jacked != b.wasJacked {
				host := "-"
				if b.pl.jackHost != nil {
					host = b.pl.jackHost.id
				}
				simTraceT.Logf("JACK t=%d p%d jacked=%v host=%s pos=(%.1f,%.1f,%.1f)",
					g.w.tick, b.pl.id, b.pl.jacked, host, b.pl.pos[0], b.pl.pos[1], b.pl.pos[2])
			}
			b.wasJacked = b.pl.jacked
			b.wasCarry = b.pl.carry
			if b.pl.jacked {
				b.jackedS += tickDT
			}
		}
		for _, b := range g.bots {
			b.tick(g)
		}
		g.clock = g.clock.Add(time.Second / time.Duration(tickRate))
		g.w.simulateTick()
		g.drain()
	}
	g.finish()
	return g.res
}

func (g *simGame) t() float64 {
	if g.matchStart.IsZero() {
		return 0
	}
	d := g.clock.Sub(g.matchStart).Seconds()
	if d < 0 {
		return 0
	}
	return d
}

func (g *simGame) finish() {
	if g.done {
		return
	}
	// тайм-аут симуляции: фиксируем текущее состояние (нормальный путь —
	// matchend, сюда попадаем только при баге бота)
	g.res.Winner = -1
	g.res.Reason = "simtimeout"
	g.res.Scores = g.w.scores
	g.res.DurationS = g.t()
	g.collectPlayers()
	g.res.Objectives = g.ev
	g.res.Combat = g.cb
	g.done = true
}

func (g *simGame) collectPlayers() {
	g.res.Players = g.res.Players[:0]
	for _, b := range g.bots {
		g.res.Players = append(g.res.Players, playerStat{
			ID: b.pl.id, Team: b.team, Cls: b.pl.cls, Skill: b.skill,
			Frags: b.frags, Deaths: b.deaths, JackedDeaths: b.jackedDeaths,
			JackedS: math.Round(b.jackedS), ProgsRun: b.progsRun,
			Trojans: b.trojans, Decrypts: b.decrypts, Shots: b.shots, Hits: b.hits,
		})
	}
}

func (g *simGame) botByID(id uint64) *simBot {
	for _, b := range g.bots {
		if b.pl.id == id {
			return b
		}
	}
	return nil
}

func (g *simGame) drain() {
	out := g.w.takeOut()
	for _, om := range out {
		msg := om.msg
		switch str(msg, "t") {
		case "death":
			vb := g.botByID(om.to)
			by := asUint(msg["by"])
			kb := g.botByID(by)
			if vb != nil {
				vb.deaths++
				if vb.wasJacked {
					vb.jackedDeaths++
				}
				if vb.wasCarry {
					g.ev.CarrierDeaths[vb.team]++
				}
			}
			if kb != nil && vb != nil {
				kb.frags++
				g.cb.Kills++
				if kb.team == vb.team {
					g.cb.FFKills++
				} else if vb.pl.cls == "hacker" {
					g.cb.HackerKills++
				}
			}
		case "envkill":
			vb := g.botByID(asUint(msg["victim"]))
			owner := asUint(msg["owner"])
			if vb != nil {
				g.cb.EnvKills++
				if g.posInLava(vb.pl.pos) {
					g.ev.LavaKills++
				} else if ob := g.botByID(owner); ob != nil {
					ob.frags++
					g.ev.GasKills[ob.team]++
				} else {
					g.ev.EnvNeutral++
				}
			}
		case "shot":
			by := g.botByID(asUint(msg["by"]))
			if by != nil {
				by.shots++
			}
			g.cb.TotalShots++
			if msg["hit"] != nil {
				g.cb.TotalHits++
				if by != nil {
					by.hits++
				}
			}
		case "extract":
			team := asInt(msg["team"])
			by := asUint(msg["by"])
			switch str(msg, "stage") {
			case "taken":
				if team >= 0 && team < 2 {
					g.ev.SafeTaken[team]++
				}
				for t := 0; t < 2; t++ {
					if t == team {
						g.bb[t].carrierID = by
						g.bb[t].enemyCarrier = 0
					} else {
						g.bb[t].enemyCarrier = by
						g.bb[t].carrierID = 0
					}
				}
			case "win":
				g.res.Winner = team
				g.res.Reason = "extract"
				g.res.DurationS = g.t()
				g.collectPlayers()
				g.res.Objectives = g.ev
				g.res.Combat = g.cb
				g.done = true
			}
		case "codes":
			b := g.botByID(om.to)
			if b == nil {
				continue
			}
			tm := b.team
			if dc := str(msg, "door"); dc != "" {
				if g.bb[tm].doorCode == "" {
					g.ev.DoorCodeT[tm] = g.t()
					if h := g.hackerOf(tm); h != nil {
						h.decrypts++
					}
				}
				g.bb[tm].doorCode = dc // поколение сменяется — код обновляется
			}
			if sc := str(msg, "safe"); sc != "" {
				if g.bb[tm].safeCode == "" {
					g.ev.SafeCodeT[tm] = g.t()
					if h := g.hackerOf(tm); h != nil {
						h.decrypts++
					}
				}
				g.bb[tm].safeCode = sc
			}
			if b.role == "hacker" {
				b.doorCodeAt = g.clock
			}
		case "denied":
			b := g.botByID(om.to)
			if b == nil {
				continue
			}
			reason := str(msg, "reason")
			switch reason {
			case "shield":
				g.ev.ShieldBurns[b.team]++
			case "antivirus":
				if dev := g.w.cyber.devices[str(msg, "dev")]; dev != nil && dev.antivirused != 0 {
					if ob := g.botByID(dev.antivirused); ob != nil {
						g.ev.AntivirusBlocks[ob.team]++
					}
				}
			case "firewall_scan":
				g.ev.FirewallScanHits++
			}
			b.inbox = append(b.inbox, msg)
		case "slow":
			b := g.botByID(om.to)
			if b == nil {
				continue
			}
			lvl := int(math.Log2(math.Max(1, num(msg, "mult"))))
			if lvl > g.ev.BackoffMax {
				g.ev.BackoffMax = lvl
			}
			b.inbox = append(b.inbox, msg)
		case "alert":
			if b := g.botByID(om.to); b != nil {
				g.ev.Alerts[b.team]++
				b.inbox = append(b.inbox, msg)
				if dev := g.w.cyber.devices[str(msg, "dev")]; dev != nil {
					b.addIntel(g, dev.pos, false, 0)
				}
			}
		case "radar":
			if b := g.botByID(om.to); b != nil {
				g.ev.RadarMsgs[b.team]++
				b.inbox = append(b.inbox, msg)
					if who, ok := msg["who"].([]radarWho); ok {
						for _, r := range who {
							if p, ok2 := g.w.players[r.ID]; ok2 {
								b.addIntel(g, p.pos, true, r.ID)
							}
						}
					}
			}
		case "cam":
			if b := g.botByID(om.to); b != nil {
				g.ev.CamFrames[b.team]++
				if seen, ok := msg["seen"].([]camSeen); ok {
					for _, s := range seen {
						b.addIntel(g, vec3{s.X, s.Y, s.Z}, false, s.ID)
					}
				}
			}
		case "code":
			if b := g.botByID(om.to); b != nil {
				b.onCodeReply(g, msg)
			}
		case "matchend":
			winner := -1
			if v, ok := msg["winner"].(int); ok {
				winner = v
			}
			if sc, ok := msg["scores"].([2]int); ok {
				g.res.Scores = sc
			}
			g.res.Winner = winner
			g.res.Reason = str(msg, "reason")
			g.res.DurationS = g.t()
			g.collectPlayers()
			g.res.Objectives = g.ev
			g.res.Combat = g.cb
			g.done = true
		}
	}
	// накопительные состояния целей
	if v3 := g.w.cyber.devices["v3"]; v3 != nil && v3.open {
		g.ev.ValveOpenS += tickDT
	}
	if g.ev.VaultOpenT == 0 {
		for _, id := range []string{"d3", "d4", "d5", "d6"} {
			if d := g.w.cyber.devices[id]; d != nil && d.open {
				g.ev.VaultOpenT = g.t()
				break
			}
		}
	}
	// газ: взведение (open false→true) с владельцем — ценность ловушек
	for _, gs := range g.w.cyber.gases {
		was := g.gasWasOpen[gs.id]
		if gs.open && !was {
			if ob := g.botByID(gs.owner); ob != nil {
				g.ev.GasArms[ob.team]++
			}
		}
		g.gasWasOpen[gs.id] = gs.open
	}
	// канал «вскрываем»: попытка = переход из пустого состояния
	kind := g.w.physafe.chKind
	if kind != "" && g.prevChKind == "" {
		tm := g.w.physafe.chTeam
		if tm >= 0 && tm < 2 {
			g.ev.ExtractAttempts[tm]++
			if g.ev.FirstChannelT == 0 {
				g.ev.FirstChannelT = g.t()
			}
		}
		if g.ev.FirstChannelT == 0 {
			g.ev.FirstChannelT = g.t()
		}
	}
	g.prevChKind = kind
}

// asInt — числовые поля сообщений, которые сервер кладёт как int (extract
// team/winner): num() читает только float64 и молча давал 0 — статистика
// extract'ов сползала в team0.
func asInt(v any) int {
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	}
	return -1
}

func asUint(v any) uint64 {
	switch x := v.(type) {
	case uint64:
		return x
	case int64:
		return uint64(x)
	case int:
		return uint64(x)
	case float64:
		return uint64(x)
	}
	return 0
}

func (g *simGame) posInLava(p vec3) bool {
	for _, f := range g.w.cyber.fires {
		if boxesOverlap(playerBoxAt(p), f.box) {
			return true
		}
	}
	return false
}

func (g *simGame) valve3Open() bool {
	if v := g.w.cyber.devices["v3"]; v != nil {
		return v.open
	}
	return false
}

func (g *simGame) vaultOpen() bool {
	for _, id := range []string{"d3", "d4", "d5", "d6"} {
		if d := g.w.cyber.devices[id]; d != nil && d.open {
			return true
		}
	}
	return false
}

// navExtra — мировые штрафы пути: лава (пока клапан закрыт) и газ.
func (g *simGame) navExtra(flags uint8) float64 {
	c := 0.0
	if flags&navLava != 0 && !g.valve3Open() {
		c += 10
	}
	if flags&navGas != 0 {
		c += 1.5
		for _, gs := range g.w.cyber.gases {
			if gs.open {
				c += 4.5
				break
			}
		}
	}
	return c
}

// doorPass — путь идёт только через ОТКРЫТЫЕ двери (запертые открываются
// клавиатурным крюком в follow/brute).
func (g *simGame) doorPass(door string) bool {
	d := g.w.cyber.devices[door]
	return d != nil && d.open
}

// --- ядро бота: ввод, перцепция, движение, бой ------------------------------

func b2f(v bool) float64 {
	if v {
		return 1
	}
	return 0
}

func (b *simBot) steer(g *simGame, mv vec3, yaw, pitch float64) {
	var kw, ka, ks, kd bool
	if mv != (vec3{}) {
		fwd := vec3{math.Sin(yaw), 0, math.Cos(yaw)}
		right := vec3{math.Cos(yaw), 0, -math.Sin(yaw)}
		fw := mv[0]*fwd[0] + mv[2]*fwd[2]
		rt := mv[0]*right[0] + mv[2]*right[2]
		kw, ks = fw > 0.25, fw < -0.25
		kd, ka = rt > 0.25, rt < -0.25
	}
	interact := b.wantInteract
	b.wantInteract = false
	g.w.handleMessage(b.pl, message{"t": "input", "yaw": yaw, "pitch": pitch,
		"keys": map[string]any{"w": b2f(kw), "a": b2f(ka), "s": b2f(ks), "d": b2f(kd),
			"interact": b2f(interact)}})
}

func (b *simBot) pressInteractPulse() {
	if !b.pl.prevInteract {
		b.wantInteract = true
	}
}

func dist2D(a, c vec3) float64 {
	dx, dz := a[0]-c[0], a[2]-c[2]
	return math.Sqrt(dx*dx + dz*dz)
}

func (b *simBot) addIntel(g *simGame, p vec3, jacked bool, by uint64) {
	b.intel = append(b.intel, intelPos{p: p, at: g.clock, jacked: jacked, by: by})
}

func (b *simBot) intelFresh(now time.Time) []intelPos {
	out := b.intel[:0]
	for _, it := range b.intel {
		if now.Sub(it.at) < 4*time.Second {
			out = append(out, it)
		}
	}
	b.intel = out
	return out
}

// perceive — 10 Гц: ближайший видимый враг (LOS + дистанция + FOV/слух).
func (b *simBot) perceive(g *simGame) {
	eye := b.pl.pos.add(vec3{0, eyeHeight, 0})
	best := math.Inf(1)
	var tgt *player
	for _, p := range g.w.players {
		if p.team == b.team || !p.alive {
			continue
		}
		c := p.pos.add(vec3{0, camBodyHeight, 0})
		d := c.sub(eye).length()
		if d > 30 {
			continue
		}
		if d > 8 { // вне слуха — проверяем FOV 140°
			dir := c.sub(eye).norm()
			fwd := aimDir(b.pl.yaw, 0)
			if dir.dot(fwd) < math.Cos(70*math.Pi/180) {
				continue
			}
		}
		if g.w.segmentBlockedAll(eye, c) {
			continue
		}
		if d < best {
			best, tgt = d, p
		}
	}
	b.visTarget, b.visDist, b.visAt = tgt, best, g.clock
}

func (b *simBot) aimSigma(dist float64) float64 {
	base := 0.012 + 0.030*(b.skill-0.5)
	return base * (1 + dist/50)
}

// combatStep — бой с текущей целью: прицел с ошибкой скилла, огонь с
// реакцией, движение в кадре прицела (подход/отход/стрейф). true = был бой.
func (b *simBot) combatStep(g *simGame) bool {
	if b.pl.jacked {
		return false
	}
	if b.visTarget == nil || !b.visTarget.alive || g.clock.Sub(b.visAt) > 300*time.Millisecond {
		return false
	}
	t := b.visTarget
	eye := b.pl.pos.add(vec3{0, eyeHeight, 0})
	c := t.pos.add(vec3{0, camBodyHeight, 0})
	dx, dz := c[0]-b.pl.pos[0], c[2]-b.pl.pos[2]
	dh := math.Hypot(dx, dz)
	if g.w.segmentBlockedAll(eye, c) {
		return false // укрылся
	}
	if g.clock.Before(b.reactUntil) {
		// реакция: повернуться, но не стрелять
		b.steer(g, vec3{}, math.Atan2(dx, dz), math.Atan2(c[1]-eye[1], dh))
		return true
	}
	yaw := math.Atan2(dx, dz) + g.rng.NormFloat64()*b.aimSigma(dh)
	pitch := math.Atan2(c[1]-eye[1], dh) + g.rng.NormFloat64()*b.aimSigma(dh)*0.5
	dir := aimDir(yaw, pitch)
	// friendly fire ON: не стрелять сквозь своего
	ff := false
	for _, m := range g.w.players {
		if m.team != b.team || !m.alive || m.id == b.pl.id {
			continue
		}
		if tt := rayBoxT(eye, dir, playerBoxAt(m.pos)); tt >= 0 && tt < dh-0.4 {
			ff = true
			break
		}
	}
	mv := b.combatMove(g, t)
	if !ff {
		g.w.handleMessage(b.pl, message{"t": "fire", "yaw": yaw, "pitch": pitch})
	}
	b.steer(g, mv, yaw, pitch)
	return true
}

func (b *simBot) combatMove(g *simGame, t *player) vec3 {
	d := dist2D(b.pl.pos, t.pos)
	adv := 0.0
	if d > b.prefMax {
		adv = 1
	} else if d < b.prefMin {
		adv = -0.7
	}
	if g.clock.After(b.strafeAt) {
		r := g.rng.Float64()
		if r < 0.4 {
			b.strafe = 0
		} else if r < 0.7 {
			b.strafe = 1
		} else {
			b.strafe = -1
		}
		b.strafeAt = g.clock.Add(400*time.Millisecond + time.Duration(g.rng.Intn(900))*time.Millisecond)
	}
	dx, dz := t.pos[0]-b.pl.pos[0], t.pos[2]-b.pl.pos[2]
	l := math.Hypot(dx, dz)
	if l < 1e-6 {
		return vec3{}
	}
	toT := vec3{dx / l, 0, dz / l}
	right := vec3{toT[2], 0, -toT[0]}
	return toT.scaled(adv).add(right.scaled(b.strafe * 0.8)).norm()
}

// acquireTarget — перцепция 10 Гц + реакция при СМЕНЕ цели.
func (b *simBot) acquireTarget(g *simGame) {
	if g.clock.Sub(b.visAt) > 100*time.Millisecond {
		b.perceive(g)
	}
	if b.visTarget != nil {
		if b.visTarget.id != b.lastTgtID {
			b.lastTgtID = b.visTarget.id
			b.reactUntil = g.clock.Add(time.Duration(b.reactS * float64(time.Second)))
		}
	} else {
		b.lastTgtID = 0
		b.reactUntil = time.Time{}
	}
}

// setGoal — путь к цели (повторные вызовы с той же целью дёшевы).
func (b *simBot) setGoal(g *simGame, to vec3) {
	if b.goalSet && dist2D(b.goal, to) < 0.8 && len(b.path) > 0 {
		return
	}
	if g.clock.Before(b.repathCD) {
		return
	}
	b.repathCD = g.clock.Add(700 * time.Millisecond)
	b.goal = to
	b.goalSet = true
	b.path = g.ng.path(b.pl.pos, to, g.doorPass, g.navExtra)
	b.pathI = 0
}

// follow — идти по пути: возвращает желаемое движение; открывает двери
// кодом на клавиатуре, борется с затыками.
func (b *simBot) follow(g *simGame) vec3 {
	if len(b.path) == 0 {
		return vec3{}
	}
	n := b.path[b.pathI]
	dx, dz := n.x-b.pl.pos[0], n.z-b.pl.pos[2]
	d := math.Hypot(dx, dz)
	if d < 0.5 {
		if b.pathI < len(b.path)-1 {
			b.pathI++
			n = b.path[b.pathI]
			dx, dz = n.x-b.pl.pos[0], n.z-b.pl.pos[2]
			d = math.Hypot(dx, dz)
		} else {
			b.path = nil
			b.goalSet = false
			return vec3{}
		}
	}
	if n.door != "" {
		dev := g.w.cyber.devices[n.door]
		if dev != nil && !dev.open {
			return b.doorFlow(g, dev)
		}
	}
	// затык: не двигаемся на месте
	if g.clock.Sub(b.lastPosAt) >= 600*time.Millisecond {
		if dist2D(b.pl.pos, b.lastPos) < 0.25 {
			b.stuckN++
			if b.stuckN >= 3 {
				b.stuckN = 0
				b.goalSet = false
				b.repathCD = time.Time{}
				return vec3{g.rng.Float64() - 0.5, 0, g.rng.Float64() - 0.5}
			}
		} else {
			b.stuckN = 0
		}
		b.lastPos = b.pl.pos
		b.lastPosAt = g.clock
	}
	l := math.Max(d, 1e-6)
	return vec3{dx / l, 0, dz / l}
}

// doorFlow — закрытая дверь на пути: с кодом идём к клавиатуре и вводим;
// без кода цель недостижима (сброс пути).
func (b *simBot) doorFlow(g *simGame, dev *device) vec3 {
	bb := g.bb[b.team]
	if dev.locked && bb.doorCode != "" {
		kp := g.nearestKeypad(dev.id, b.pl.pos)
		if kp == nil {
			b.path = nil
			return vec3{}
		}
		b.approachKeypad(g, kp)
		return vec3{}
	}
	// незапертую дверь открывает только trojan-владелец из деки — мясу путь
	// в обход (A* уже обошёл открытые; закрытая = тупик для этого бота)
	b.path = nil
	b.goalSet = false
	return vec3{}
}

func (b *simBot) enterCodeAt(g *simGame, kp *mapProp) {
	if b.enterCD.After(g.clock) {
		return
	}
	b.enterCD = g.clock.Add(2300 * time.Millisecond)
	code := g.bb[b.team].doorCode
	if kp == nil {
		return
	}
	g.w.handleMessage(b.pl, message{"t": "enter", "dev": kp.ID, "code": code})
}

// approachKeypad — подвести бота к клавиатуре в радиус ввода (≤2 м):
// путь сеткой до 3.2 м, последние метры напрямую (узел навсетки бывает
// дальше радиуса enter, и тогда бот замирал в 2.2 м, не вводя код).
func (b *simBot) approachKeypad(g *simGame, kp *mapProp) {
	d := dist2D(b.pl.pos, kp.Pos)
	if d <= 2.0 {
		b.enterCodeAt(g, kp)
		b.steer(g, vec3{}, math.Atan2(kp.Pos[0]-b.pl.pos[0], kp.Pos[2]-b.pl.pos[2]), 0)
		return
	}
	if d > 3.2 {
		b.setGoal(g, kp.Pos)
		b.steerFollow(g)
		return
	}
	dx, dz := kp.Pos[0]-b.pl.pos[0], kp.Pos[2]-b.pl.pos[2]
	l := math.Max(1e-6, math.Hypot(dx, dz))
	b.steer(g, vec3{dx / l, 0, dz / l}, math.Atan2(dx, dz), 0)
}

func (g *simGame) nearestKeypad(doorID string, from vec3) *mapProp {
	// клавиатуры каждой двери стоят по обе стороны; выбираем СВОЮ сторону:
	// снаружи закрытого хранилища внешняя (иначе путь шёл через лаву внутри
	// и бот умирал по дороге к «ближайшей» внутренней клавиатуре)
	var vaultC = vec3{32, 8, 32}
	fromInside := dist2D(from, vaultC) < 10.5
	var best *mapProp
	bestD := math.Inf(1)
	for _, kp := range g.keypads[doorID] {
		inside := dist2D(kp.Pos, vaultC) < 10.5
		if inside != fromInside {
			continue
		}
		if d := dist2D(kp.Pos, from); d < bestD {
			bestD, best = d, kp
		}
	}
	if best != nil {
		return best
	}
	for _, kp := range g.keypads[doorID] {
		if d := dist2D(kp.Pos, from); d < bestD {
			bestD, best = d, kp
		}
	}
	return best
}

func (b *simBot) tick(g *simGame) {
	b.tickN++
	b.procInbox(g)
	if !b.pl.alive {
		if !b.pl.respawnAt.IsZero() && !g.clock.Before(b.pl.respawnAt) {
			g.w.handleMessage(b.pl, message{"t": "respawn", "cls": b.pl.cls})
			b.path = nil
			b.goalSet = false
			b.reactUntil = time.Time{}
			if b.role == "hacker" {
				b.hh.phase = "entry"
				b.hh.cur = nil
				b.hh.ops = nil
				b.hh.entry = ""
			}
		}
		return
	}
	b.acquireTarget(g)
	if b.role == "hacker" {
		b.hackerTick(g)
		return
	}
	b.meatTick(g)
}

// --- мозг хакера ------------------------------------------------------------

func (b *simBot) procInbox(g *simGame) {
	hh := &b.hh
	for _, msg := range b.inbox {
		switch str(msg, "t") {
		case "denied":
			op := hh.cur
			if op == nil || !op.sent {
				continue
			}
			if simTraceT != nil && b.pl.id == 1 {
				reach := false
				if b.pl.jackHost != nil {
					reach = g.w.reachableFor(b.pl.jackHost.id, b.pl)[op.dev]
				}
				simTraceT.Logf("DENY t=%d p%d reason=%s prog=%s dev=%s opkind=%s scanned[%s]=%v reach=%v scannedN=%d",
					g.w.tick, b.pl.id, str(msg, "reason"), str(msg, "prog"), str(msg, "dev"),
					op.kind, op.dev, b.pl.scanned[op.dev], reach, len(b.pl.scanned))
			}
			if pr := str(msg, "prog"); pr != "" && normProg(pr) != op.kind {
				continue
			}
			switch str(msg, "reason") {
			case "shield", "antivirus", "cp_cancel":
				op.sent = false
				op.tries++
				if op.tries > 5 {
					hh.cur = nil
				}
			case "not_vulned":
				hh.ops = append([]hackOp{{kind: "vuln", dev: op.dev}, *op}, hh.ops...)
				hh.cur = nil
			case "ram_full":
				op.sent = false
				op.waitCD = g.clock.Add(1200 * time.Millisecond)
			case "too_far", "not_owner", "locked", "npu", "not_jacked":
				hh.cur = nil
			case "mem_full":
				hh.ops = append([]hackOp{{kind: "rm", dev: "deck", data: op.data}, *op}, hh.ops...)
				hh.cur = nil
			case "dup":
				hh.cur = nil
			case "in_progress":
				op.deadline = g.clock.Add(15 * time.Second)
			case "firewall_scan":
				hh.scanCap = 0 // скан упёрся — расширение бессмысленно
			}
		case "slow":
			if op := hh.cur; op != nil && op.sent {
				if eta := num(msg, "eta"); eta > 45 {
					hh.cur = nil // слишком долго — откладываем (backoff гнёт)
				}
			}
		}
	}
	b.inbox = b.inbox[:0]
}

// normProg — имя программы на wire → каноническое имя операции.
func normProg(pr string) string {
	switch pr {
	case "portscan":
		return "scan"
	case "vulnscan":
		return "vuln"
	case "watcher":
		return "watcher"
	case "cp", "mv":
		return "cp"
	}
	return pr
}

func (b *simBot) hackerTick(g *simGame) {
	hh := &b.hh
	if b.pl.jacked {
		// тело статично: следим за угрозой
		if b.threatAt.IsZero() || g.clock.After(b.threatAt) {
			b.threatAt = g.clock.Add(300 * time.Millisecond)
			b.threat = b.threatNear(g, 10)
		}
		if b.threat && (b.pl.hp < 80 || b.threatD < 5) {
			g.w.handleMessage(b.pl, message{"t": "jackout"})
			hh.cur = nil
			hh.ops = nil
			return
		}
		if hh.cur == nil && len(hh.ops) == 0 {
			b.replan(g)
		}
		b.opTick(g)
		b.jackedSide(g)
		b.steer(g, vec3{}, b.pl.yaw, 0)
		return
	}
	if b.combatStep(g) {
		return
	}
	switch hh.phase {
	case "entry":
		b.entryTick(g)
	case "crack":
		b.crackTick(g)
	case "brute":
		b.hackerBruteTick(g)
	default:
		b.guardTick(g)
	}
}

// threatNear — ближайший видимый враг у тела (джекнут/джекается).
func (b *simBot) threatNear(g *simGame, r float64) bool {
	best := math.Inf(1)
	found := false
	for _, p := range g.w.players {
		if p.team == b.team || !p.alive {
			continue
		}
		d := dist2D(p.pos, b.pl.pos)
		if d > r {
			continue
		}
		if g.w.segmentBlockedAll(b.pl.pos.add(vec3{0, eyeHeight, 0}), p.pos.add(vec3{0, camBodyHeight, 0})) {
			continue
		}
		if d < best {
			best, found = d, true
		}
	}
	b.threatD = best
	return found
}

func (b *simBot) pickEntry(g *simGame) {
	hh := &b.hh
	var prefs []string
	// СВОЙ терминал первым — симметрично для обеих команд. Раньше запад
	// шёл к радио (r1/r2 в миде, лишние метры под огнём на каждый джек) —
	// этот ботский bias, а не свойство карты, давал востоку 64.6% решённых
	// матчей в смешанном прогоне 2026-11-20.
	if b.team == 0 {
		prefs = []string{"t1", "r1", "r2", "s1"}
	} else {
		prefs = []string{"t2", "r1", "r2", "s2"}
	}
	hh.entryTries++
	if hh.entryTries > len(prefs)+2 {
		hh.entryTries = 0 // подождать — возможно, точку освободят
		return
	}
	for i := 0; i < len(prefs); i++ {
		id := prefs[(hh.entryTries+i)%len(prefs)]
		d := g.w.cyber.devices[id]
		if d == nil {
			continue
		}
		if jackEntry(d) && d.owner != 0 && d.owner != b.pl.id {
			if op, ok := g.w.players[d.owner]; !ok || op.team != b.team {
				continue // захвачено врагом
			}
		}
		hh.entry = id
		return
	}
	hh.entry = prefs[0]
}

func (b *simBot) entryTick(g *simGame) {
	hh := &b.hh
	if hh.entry == "" {
		b.pickEntry(g)
		return
	}
	dev := g.w.cyber.devices[hh.entry]
	if dev == nil {
		b.pickEntry(g)
		return
	}
	// contested-точка входа — сменить
	if jackEntry(dev) && dev.owner != 0 && dev.owner != b.pl.id {
		if op, ok := g.w.players[dev.owner]; !ok || op.team != b.team {
			b.pickEntry(g)
			return
		}
	}
	// канал «дорогого входа» уже ставится — не двигаться и не перезапускать
	if b.pl.jacking != nil {
		b.steer(g, vec3{}, b.pl.yaw, 0)
		return
	}
	r := jackTerminalRadius
	if dev.kind == "radio" {
		r = dev.radius
	}
	d := dist2D(b.pl.pos, dev.pos)
	if d > math.Max(1.4, r*0.7) {
		b.setGoal(g, dev.pos)
		mv := b.follow(g)
		yaw := math.Atan2(dev.pos[0]-b.pl.pos[0], dev.pos[2]-b.pl.pos[2])
		b.steer(g, mv, yaw, 0)
		return
	}
	// стоим у порта: прицел в устройство + interact (edge-пульс)
	yaw := math.Atan2(dev.pos[0]-b.pl.pos[0], dev.pos[2]-b.pl.pos[2])
	pitch := math.Atan2(dev.pos[1]+0.5-(b.pl.pos[1]+eyeHeight), math.Max(0.5, d))
	b.pressInteractPulse()
	b.steer(g, vec3{}, yaw, pitch)
}

func (b *simBot) opTick(g *simGame) {
	hh := &b.hh
	if hh.cur == nil {
		if len(hh.ops) == 0 {
			return
		}
		op := hh.ops[0]
		hh.ops = hh.ops[1:]
		op.sent = false
		op.tries = 0
		hh.cur = &op
	}
	op := hh.cur
	if !op.sent {
		if g.clock.Before(op.waitCD) {
			return
		}
		if op.kind != "scan" {
			dev := g.w.cyber.devices[op.dev]
			if dev == nil || !b.pl.scanned[op.dev] {
				// цели нет в знаниях — сначала разведка
				hh.ops = append([]hackOp{{kind: "scan"}, *op}, hh.ops...)
				hh.cur = nil
				return
			}
		}
		b.progsRun++
		b.runOp(g, op)
		op.sent = true
		op.deadline = g.clock.Add(b.opTimeout(op))
		return
	}
	if g.clock.After(op.deadline) {
		hh.cur = nil
		return
	}
	if b.progAlive(op) {
		return // ещё работает
	}
	if b.opVerify(g, op) {
		if op.kind == "trojan" {
			b.trojans++
		}
		hh.cur = nil
		return
	}
	op.sent = false
	op.tries++
	if op.tries > 3 {
		hh.cur = nil
	}
}

func (b *simBot) opTimeout(op *hackOp) time.Duration {
	switch op.kind {
	case "scan":
		return 30 * time.Second
	case "decrypt":
		return 120 * time.Second
	default:
		return 60 * time.Second
	}
}

func (b *simBot) progAlive(op *hackOp) bool {
	for _, p := range b.pl.progs {
		if normProg(p.prog) != op.kind {
			continue
		}
		switch op.kind {
		case "scan":
			return true
		case "cp":
			if p.dev == op.dev && p.dst == op.dst && p.data == op.data {
				return true
			}
		case "rm", "decrypt":
			if p.dev == op.dev && p.data == op.data {
				return true
			}
		default:
			if p.dev == op.dev {
				return true
			}
		}
	}
	return false
}

func (b *simBot) opVerify(g *simGame, op *hackOp) bool {
	w := g.w
	switch op.kind {
	case "vuln":
		d := w.cyber.devices[op.dev]
		return d != nil && d.vulnedBy[b.pl.id]
	case "trojan":
		d := w.cyber.devices[op.dev]
		return d != nil && d.owner == b.pl.id
	case "watcher":
		d := w.cyber.devices[op.dev]
		return d != nil && d.watcherBy[b.pl.id]
	case "firewall":
		d := w.cyber.devices[op.dev]
		return d != nil && d.firewalled == b.pl.id
	case "antivirus":
		d := w.cyber.devices[op.dev]
		return d != nil && d.antivirused == b.pl.id
	case "cp":
		if op.dst == "deck" {
			return deckHasItem(b.pl, op.data)
		}
		if d := w.cyber.devices[op.dst]; d != nil {
			return hostHasItem(d, op.data)
		}
		return false
	case "rm":
		if op.dev == "deck" {
			return !deckHasItem(b.pl, op.data)
		}
		if d := w.cyber.devices[op.dev]; d != nil {
			return !hostHasItem(d, op.data)
		}
		return true
	case "decrypt":
		bb := g.bb[b.team]
		if strings.HasPrefix(op.data, "door_key") {
			return bb.doorCode != ""
		}
		if strings.HasPrefix(op.data, "safe_key") {
			return bb.safeCode != ""
		}
		return true
	case "ctrl":
		d := w.cyber.devices[op.dev]
		return d != nil && d.open
	case "scan":
		return true
	}
	return true
}

func (b *simBot) runOp(g *simGame, op *hackOp) {
	if op.kind == "ctrl" {
		// ctrl — не run-программа, отдельное сообщение (§12.5)
		g.w.handleMessage(b.pl, message{"t": "ctrl", "dev": op.dev, "action": "toggle"})
		return
	}
	m := message{"t": "run"}
	switch op.kind {
	case "scan":
		m["prog"] = "portscan"
	case "vuln":
		m["prog"] = "vulnscan" // имя на wire (§12.5)
		m["dev"] = op.dev
	case "cp", "rm", "decrypt":
		m["prog"] = op.kind
		m["dev"] = op.dev
		if op.dst != "" {
			m["dst"] = op.dst
		}
		m["data"] = op.data
	default:
		m["prog"] = op.kind
		m["dev"] = op.dev
	}
	g.w.handleMessage(b.pl, m)
}

// replan — планировщик хакера: строит очередь операций под план и состояние.
func (b *simBot) replan(g *simGame) {
	hh := &b.hh
	bb := g.bb[b.team]
	w := g.w
	own := func(id string) bool { d := w.cyber.devices[id]; return d != nil && d.owner == b.pl.id }
	known := func(id string) bool { return b.pl.scanned[id] }
	push := func(ops ...hackOp) { hh.ops = append(hh.ops, ops...) }

	switch hh.plan {
	case "door_rush", "valve_siege", "hybrid":
		// door_key ротируется каждые 120 с (§16.5): декрипт된 код живёт
		// текущее+предыдущее поколение — пере-декриптим раз в ~100 с
		codeStale := bb.doorCode == "" || g.clock.Sub(b.doorCodeAt) > 100*time.Second
		if codeStale {
			if !known("srv1") {
				if hh.scanCap > 0 {
					hh.scanCap--
					push(hackOp{kind: "scan"})
				} else {
					hh.phase = "guard" // сеть отрезана/недостижима — охранять
				}
				return
			}
			if !own("srv1") {
				push(hackOp{kind: "vuln", dev: "srv1"}, hackOp{kind: "trojan", dev: "srv1"})
				return
			}
			// имя поколения реальное (door_key_HH_II), не префикс — иначе
			// handleDecrypt не находит item и молча отказывает too_far
			push(hackOp{kind: "decrypt", dev: "srv1", data: b.doorKeyName(g)})
			return
		}
		// код есть: клапан (v3) по флагу плана. NB: handleCtrl требует владельца
		// САМОГО клапана (v3), а не коммутатора s3 — трояним v3 напрямую
		if hh.valve && !g.valve3Open() {
			if !known("v3") {
				push(hackOp{kind: "scan"})
				return
			}
			if !own("v3") {
				push(hackOp{kind: "vuln", dev: "v3"}, hackOp{kind: "trojan", dev: "v3"})
				return
			}
			push(hackOp{kind: "ctrl", dev: "v3"})
			return
		}
		if hh.plan == "hybrid" && bb.safeCode == "" {
			b.planSafeOps(push, own, known)
			return
		}
		// всё сделано — охрана: выходим из деки (тело уязвимо, польза меньше)
		g.w.handleMessage(b.pl, message{"t": "jackout"})
		hh.phase = "guard"
	case "safe_rush":
		if bb.safeCode == "" {
			b.planSafeOps(push, own, known)
			return
		}
		if g.vaultOpen() {
			if !g.valve3Open() {
				if !known("v3") {
					push(hackOp{kind: "scan"})
					return
				}
				if !own("v3") {
					push(hackOp{kind: "vuln", dev: "v3"}, hackOp{kind: "trojan", dev: "v3"})
					return
				}
				push(hackOp{kind: "ctrl", dev: "v3"})
				return
			}
			hh.phase = "crack"
			g.w.handleMessage(b.pl, message{"t": "jackout"})
			return
		}
		hh.phase = "guard"
	case "defense":
		if b.defenseSetup(g, push, own, known) {
			hh.phase = "guard" // остаёмся джекнутыми: радар/watchers живут
		}
	case "disrupt":
		// «захватить все G и включить везде газ, отключая по мере
		// необходимости» (владелец 2026-11-21): трояним ВСЕ газы — комнаты
		// g1/g2 и лестничные g3..g6 (объёмы на оба этажа)
		for _, gs := range w.cyber.gases {
			if !known(gs.id) {
				if hh.scanCap > 0 {
					hh.scanCap--
					push(hackOp{kind: "scan"})
				} else {
					hh.phase = "guard" // сеть отрезана — рулим тем, что есть
				}
				return
			}
			if !own(gs.id) {
				push(hackOp{kind: "vuln", dev: gs.id}, hackOp{kind: "trojan", dev: gs.id})
				return
			}
		}
		if !own(hh.doorDev) && known(hh.doorDev) {
			push(hackOp{kind: "vuln", dev: hh.doorDev}, hackOp{kind: "trojan", dev: hh.doorDev})
			return
		}
		for _, cam := range []string{"cam1", "cam2"} {
			if !own(cam) && known(cam) {
				push(hackOp{kind: "vuln", dev: cam}, hackOp{kind: "trojan", dev: cam})
				return
			}
		}
		hh.phase = "guard" // рулим газами/дверью из jackedSide
	case "valve_brute":
		// Сценарий владельца 2026-11-21: хакер отключает лаву (v3 на 2F),
		// затем выходит из деки и ФИЗИЧЕСКИ перебирает код двери умным
		// алгоритмом (перепись цифр → перестановки), снайперы прикрывают.
		if !g.valve3Open() {
			if !known("v3") {
				push(hackOp{kind: "scan"})
				return
			}
			if !own("v3") {
				push(hackOp{kind: "vuln", dev: "v3"}, hackOp{kind: "trojan", dev: "v3"})
				return
			}
			push(hackOp{kind: "ctrl", dev: "v3"})
			return
		}
		// клапан открыт — джек-аут и пешком к клавиатуре (анти-флуд не пускает
		// джекнутого: enter у сервера — только физический ввод)
		g.w.handleMessage(b.pl, message{"t": "jackout"})
		hh.phase = "brute"
	}
}

func (b *simBot) planSafeOps(push func(...hackOp), own, known func(string) bool) {
	if !known("netsafe") {
		push(hackOp{kind: "scan"})
		return
	}
	if !own("netsafe") {
		push(hackOp{kind: "vuln", dev: "netsafe"}, hackOp{kind: "trojan", dev: "netsafe"})
		return
	}
	// NPU-хост: свой SRV (быстрый decrypt) иначе — SRV в захват, иначе дека
	for _, id := range []string{"srv2", "srv3", "srv1"} {
		if own(id) {
			push(hackOp{kind: "cp", dev: "netsafe", dst: id, data: "safe_key"})
			push(hackOp{kind: "decrypt", dev: id, data: "safe_key"})
			return
		}
	}
	if b.hh.srvTries < 1 {
		for _, id := range []string{"srv2", "srv3", "srv1"} {
			if known(id) {
				b.hh.srvTries++
				push(hackOp{kind: "vuln", dev: id}, hackOp{kind: "trojan", dev: id})
				return
			}
		}
	}
	push(hackOp{kind: "cp", dev: "netsafe", dst: "deck", data: "safe_key"})
	push(hackOp{kind: "decrypt", dev: "deck", data: "safe_key"})
}

// defenseSetup — расставить защиту; true когда всё поставлено.
func (b *simBot) defenseSetup(g *simGame, push func(...hackOp), own, known func(string) bool) bool {
	hh := &b.hh
	steps := []string{"watcher:srv1", "watcher:s3", "watcher:netsafe"}
	if b.team == 0 {
		steps = append(steps, "firewall:s2", "antivirus:srv1")
	} else {
		steps = append(steps, "firewall:s1", "antivirus:srv1")
	}
	steps = append(steps, "trojan:cam1", "trojan:cam2")
	for _, s := range steps {
		if hh.placed[s] {
			continue
		}
		parts := strings.SplitN(s, ":", 2)
		dev := parts[1]
		if !known(dev) {
			push(hackOp{kind: "scan"})
			return false
		}
		hh.placed[s] = true // успех подтвердит верификация операции
		switch parts[0] {
		case "watcher":
			push(hackOp{kind: "watcher", dev: dev})
		case "firewall":
			push(hackOp{kind: "firewall", dev: dev})
		case "antivirus":
			push(hackOp{kind: "antivirus", dev: dev})
		case "trojan":
			push(hackOp{kind: "vuln", dev: dev}, hackOp{kind: "trojan", dev: dev})
		}
		return false
	}
	// chaff: cp+rm door_key через магистраль — жмёт чужие сканы (§16.3)
	if hh.chaffLeft > 0 && own("srv1") {
		if name := b.doorKeyName(g); name != "" {
			hh.chaffLeft--
			push(hackOp{kind: "cp", dev: "srv1", dst: "deck", data: name},
				hackOp{kind: "rm", dev: "deck", data: name})
			return false
		}
	}
	return true
}

// doorKeyName — имя текущего поколения door_key на srv1 (для chaff).
func (b *simBot) doorKeyName(g *simGame) string {
	if d := g.w.cyber.devices["srv1"]; d != nil {
		for _, it := range d.items {
			if strings.HasPrefix(it.Name, "door_key") {
				return it.Name
			}
		}
	}
	return b.chaffSeen
}

func (b *simBot) jackedSide(g *simGame) {
	hh := &b.hh
	if hh.plan != "disrupt" || b.pl.jackHost == nil {
		return
	}
	reach := g.w.reachableFor(b.pl.jackHost.id, b.pl)
	// «захватить все G и включить везде газ, отключая по мере необходимости»
	// (владелец 2026-11-21): рулим КАЖДЫМ своим газом — враг в объёме
	// (intel/прицел) → открыть, пусто дольше 5 с → закрыть
	for _, gs := range g.w.cyber.gases {
		if gs.owner != b.pl.id || !reach[gs.id] {
			continue
		}
		enemyIn := false
		for _, it := range b.intelFresh(g.clock) {
			if boxesOverlap(playerBoxAt(it.p), gs.box) {
				enemyIn = true
			}
		}
		if b.visTarget != nil && boxesOverlap(playerBoxAt(b.visTarget.pos), gs.box) {
			enemyIn = true
		}
		switch {
		case enemyIn && !gs.open:
			g.w.handleMessage(b.pl, message{"t": "ctrl", "dev": gs.id, "action": "toggle"})
			if hh.gasOpen == nil {
				hh.gasOpen = map[string]time.Time{}
			}
			hh.gasOpen[gs.id] = g.clock
		case !enemyIn && gs.open && g.clock.Sub(hh.gasOpen[gs.id]) > 5*time.Second:
			g.w.handleMessage(b.pl, message{"t": "ctrl", "dev": gs.id, "action": "toggle"})
		}
	}
	// держать свою дверь-шлюз открытой для пуша
	dd := g.w.cyber.devices[hh.doorDev]
	if dd != nil && dd.owner == b.pl.id && !dd.locked && !dd.open && reach[dd.id] {
		g.w.handleMessage(b.pl, message{"t": "ctrl", "dev": dd.id, "action": "toggle"})
	}
}

func (b *simBot) guardTick(g *simGame) {
	// вне деки после плана: держаться около точки входа и охранять
	if dev := g.w.cyber.devices[b.hh.entry]; dev != nil {
		b.setGoal(g, dev.pos)
	}
	mv := b.follow(g)
	if mv == (vec3{}) {
		b.steer(g, vec3{}, b.pl.yaw+math.Sin(float64(g.w.tick)/30+float64(b.pl.id))*0.5, 0)
		return
	}
	b.steer(g, mv, math.Atan2(mv[0], mv[2]), 0)
}

func (b *simBot) crackTick(g *simGame) {
	w := g.w
	bb := g.bb[b.team]
	if !g.vaultOpen() || !g.valve3Open() || bb.safeCode == "" {
		b.hh.phase = "guard"
		return
	}
	if w.physafe.carrier != 0 {
		b.hh.phase = "guard"
		return
	}
	d := dist2D(b.pl.pos, w.physafe.pos)
	if d > 2.4 {
		b.setGoal(g, w.physafe.pos)
		mv := b.follow(g)
		yaw := math.Atan2(w.physafe.pos[0]-b.pl.pos[0], w.physafe.pos[2]-b.pl.pos[2])
		b.steer(g, mv, yaw, 0)
		return
	}
	// у сейфа: ввести код и стоять (канал 3 с; урон прервёт — клапан открыт)
	if w.physafe.chKind == "" && b.enterCD.Before(g.clock) {
		b.enterCD = g.clock.Add(2300 * time.Millisecond)
		g.w.handleMessage(b.pl, message{"t": "enter", "dev": "physafe", "code": bb.safeCode})
	}
	b.steer(g, vec3{}, math.Atan2(w.physafe.pos[0]-b.pl.pos[0], w.physafe.pos[2]-b.pl.pos[2]), 0)
}

// hackerBruteTick — план valve_brute, фаза «brute»: лава погашена, хакер
// вне деки у клавиатуры своей двери хранилища; умный перебор (перепись
// цифр → перестановки, hh.guesser), ответы — через onCodeReply. Под огнём
// сначала отстрел, перебор ждёт.
func (b *simBot) hackerBruteTick(g *simGame) {
	if !g.valve3Open() { // клапан закрыли — вернуться в деку и перехватить
		b.hh.phase = "entry"
		return
	}
	doorID := "d5"
	if b.team == 1 {
		doorID = "d6"
	}
	dev := g.w.cyber.devices[doorID]
	kp := g.nearestKeypad(doorID, b.pl.pos)
	if dev == nil || kp == nil {
		b.hh.phase = "guard"
		return
	}
	if dev.open {
		if g.ev.BruteDoorT[b.team] == 0 {
			g.ev.BruteDoorT[b.team] = g.t()
		}
		b.hh.phase = "guard"
		return
	}
	if b.hh.guesser == nil {
		b.hh.guesser = &codeGuesser{}
	}
	if d := dist2D(b.pl.pos, kp.Pos); d > 2.0 {
		if b.combatStep(g) {
			return
		}
		if d > 3.2 {
			b.setGoal(g, kp.Pos)
			b.steerFollow(g)
		} else {
			dx, dz := kp.Pos[0]-b.pl.pos[0], kp.Pos[2]-b.pl.pos[2]
			l := math.Max(1e-6, math.Hypot(dx, dz))
			b.steer(g, vec3{dx / l, 0, dz / l}, math.Atan2(dx, dz), 0)
		}
		return
	}
	if b.combatStep(g) {
		return
	}
	if b.enterCD.Before(g.clock) {
		b.enterCD = g.clock.Add(2300 * time.Millisecond)
		g.w.handleMessage(b.pl, message{"t": "enter", "dev": kp.ID, "code": b.hh.guesser.probe()})
	}
	b.steer(g, vec3{}, math.Atan2(kp.Pos[0]-b.pl.pos[0], kp.Pos[2]-b.pl.pos[2]), 0)
}

// --- мозг мяса --------------------------------------------------------------

func (b *simBot) meatTick(g *simGame) {
	bb := g.bb[b.team]
	if bb.passive {
		if b.combatStep(g) {
			return
		}
		b.passiveTick(g)
		return
	}
	// несу сейф — к базе (по дороге ограниченно отстреливаюсь)
	if b.pl.carry {
		if b.combatStep(g) {
			return
		}
		b.carryTick(g)
		return
	}
	// свой носитель: двое ближайших сопровождают
	if bb.carrierID != 0 {
		car := g.botByID(bb.carrierID)
		if car != nil && car.pl.alive && car.pl.carry {
			if b.combatStep(g) {
				return
			}
			if b.rankNear(g, car.pl.pos, 2) {
				b.setGoal(g, car.pl.pos)
				b.steerFollow(g)
				return
			}
		} else {
			bb.carrierID = 0
		}
	}
	// вражеский носитель: двое ближайших перехватывают
	if bb.enemyCarrier != 0 && g.w.physafe.carrier != 0 {
		if b.combatStep(g) {
			return
		}
		if b.rankNear(g, g.w.physafe.pos, 2) {
			b.setGoal(g, g.w.physafe.pos)
			b.steerFollow(g)
			return
		}
	}
	// сейф на земле — ближайший подбирает
	if g.w.physafe.carrier == 0 && b.canReachSafe(g) {
		d := dist2D(b.pl.pos, g.w.physafe.pos)
		if d < 2.4 {
			b.pressInteractPulse()
			b.steer(g, vec3{}, math.Atan2(g.w.physafe.pos[0]-b.pl.pos[0], g.w.physafe.pos[2]-b.pl.pos[2]), 0)
			return
		}
		if b.rankNear(g, g.w.physafe.pos, 1) {
			// сейф достижим — приоритет цели над боем (владелец 2026-11-21:
			// «у ботов есть цель вскрыть physafe, оно должно работать»);
			// отстрел только когда враг стоит прямо на пути к сейфу
			if b.visTarget != nil && dist2D(b.visTarget.pos, g.w.physafe.pos) < 6 {
				if b.combatStep(g) {
					return
				}
			}
			b.setGoal(g, g.w.physafe.pos)
			b.steerFollow(g)
			return
		}
	}
	if b.combatStep(g) {
		return
	}
	switch b.mm.plan {
	case "escort":
		b.escortTick(g)
	case "push":
		b.pushTick(g)
	case "hold":
		b.holdTick(g)
	case "hunt":
		b.huntTick(g)
	case "cover_brute":
		b.coverBruteTick(g)
	case "wave":
		b.waveTick(g)
	case "assassin":
		b.assassinTick(g)
	case "brute":
		b.bruteTick(g)
	default:
		b.pushTick(g)
	}
}

func (b *simBot) steerFollow(g *simGame) {
	mv := b.follow(g)
	if mv == (vec3{}) {
		b.steer(g, vec3{}, b.pl.yaw, 0)
		return
	}
	b.steer(g, mv, math.Atan2(mv[0], mv[2]), 0)
}

// rankNear — я среди N ближайших живых союзников-мяса к точке.
func (b *simBot) rankNear(g *simGame, to vec3, n int) bool {
	myD := dist2D(b.pl.pos, to)
	cnt := 0
	for _, o := range g.bots {
		if o.team != b.team || o.pl.id == b.pl.id || !o.pl.alive || o.role == "hacker" {
			continue
		}
		if dist2D(o.pl.pos, to) < myD {
			cnt++
		}
	}
	return cnt < n
}

func (b *simBot) canReachSafe(g *simGame) bool {
	ps := g.w.physafe
	if ps.carrier != 0 || b.pl.carry {
		return false
	}
	// сейф в хранилище — нужен открытый проём
	inVault := dist2D(ps.pos, vec3{32, 8, 32}) < 11
	if inVault && !g.vaultOpen() {
		return false
	}
	return true
}

func (b *simBot) carryTick(g *simGame) {
	sp := g.w.m.teamSpawns(b.team)
	if len(sp) == 0 {
		return
	}
	home := vec3{sp[0][0], sp[0][1], sp[0][2]}
	for _, s := range sp { // ближайшая точка спавна — зона сдачи
		if dist2D(b.pl.pos, vec3{s[0], s[1], s[2]}) < dist2D(b.pl.pos, home) {
			home = vec3{s[0], s[1], s[2]}
		}
	}
	if g.w.inBaseZone(b.pl) {
		// канал идёт сам: стоять и прикрывать
		b.steer(g, vec3{}, b.pl.yaw+math.Sin(float64(g.w.tick)/15)*0.4, 0)
		return
	}
	b.setGoal(g, home)
	b.steerFollow(g)
}

func (b *simBot) escortTick(g *simGame) {
	bb := g.bb[b.team]
	// код известен ИЛИ дверь вскрыта (хакером с кодом или физическим
	// перебором valve_brute) — эскорт превращается в пуш
	if bb.doorCode != "" || g.vaultOpen() {
		b.mm.plan = "push"
		return
	}
	h := g.hackerOf(b.team)
	if h == nil || !h.pl.alive {
		b.mm.plan = "push"
		return
	}
	// позиция между хакером и центром карты (тело хакера прикрыть)
	off := vec3{32 - h.pl.pos[0], 0, 32 - h.pl.pos[2]}
	l := math.Max(1e-6, math.Hypot(off[0], off[2]))
	tgt := h.pl.pos.add(vec3{off[0] / l * 3, 0, off[2] / l * 3})
	if b.rankNear(g, tgt, 3) {
		b.setGoal(g, tgt)
	}
	b.steerFollow(g)
}

func (b *simBot) pushTick(g *simGame) {
	bb := g.bb[b.team]
	door := g.w.cyber.devices[b.mm.vaultDoor]
	if door != nil && door.open {
		// хранилище открыто: к сейфу
		b.setGoal(g, g.w.physafe.pos)
		b.steerFollow(g)
		return
	}
	kp := g.nearestKeypad(b.mm.vaultDoor, b.pl.pos)
	if bb.doorCode != "" && kp != nil {
		// подойти к клавиатуре и открыть (все с кодом — анти-флуд страхует)
		b.approachKeypad(g, kp)
		return
	}
	// кода нет: держать рубеж у своей двери хранилища
	var rally vec3
	if kp != nil {
		rally = kp.Pos
	} else if door != nil {
		rally = door.pos
	} else {
		return
	}
	b.setGoal(g, rally)
	mv := b.follow(g)
	if mv == (vec3{}) {
		b.steer(g, vec3{}, b.pl.yaw+math.Sin(float64(g.w.tick)/20)*0.6, 0)
		return
	}
	b.steer(g, mv, math.Atan2(mv[0], mv[2]), 0)
}

func (b *simBot) holdTick(g *simGame) {
	// код двери известен — оборона превращается в пуш (цель доступна)
	if g.bb[b.team].doorCode != "" {
		b.mm.plan = "push"
		return
	}
	sp := g.w.m.teamSpawns(b.team)
	if len(sp) == 0 {
		return
	}
	home := vec3{sp[0][0], sp[0][1], sp[0][2]}
	// маятник база↔подход к центру
	var tgt vec3
	if b.team == 0 {
		tgt = vec3{home[0] + 22, home[1], home[2]}
	} else {
		tgt = vec3{home[0] - 22, home[1], home[2]}
	}
	if int(g.w.tick/300)%2 == 1 {
		tgt = home
	}
	b.setGoal(g, tgt)
	b.steerFollow(g)
}

var huntPoints = []vec3{
	{32, 1, 16}, {32, 1, 32}, {32, 1, 48}, {19, 1, 32}, {45, 1, 32},
	{32, 1, 10}, {32, 1, 54},
}

func (b *simBot) huntTick(g *simGame) {
	bb := g.bb[b.team]
	// код двери известен — охотники подключаются к пушу
	if bb.doorCode != "" {
		b.mm.plan = "push"
		return
	}
	// intel от союзников — сходиться на свежую метку
	for _, it := range b.intelFresh(g.clock) {
		if dist2D(it.p, b.pl.pos) < 26 {
			b.setGoal(g, it.p)
			b.steerFollow(g)
			return
		}
	}
	if bb.enemyCarrier != 0 {
		b.setGoal(g, g.w.physafe.pos)
		b.steerFollow(g)
		return
	}
	wp := huntPoints[b.mm.wp%len(huntPoints)]
	if dist2D(b.pl.pos, wp) < 2.5 {
		b.mm.wp++
	}
	b.setGoal(g, wp)
	b.steerFollow(g)
}

// coverBruteTick — кооп-брутфорс (запрос владельца 2026-11-21 «один
// бруфорсит, остальные прикрывают»): рота у клавиатуры своей двери, пробует
// ОБЩУЮ угадайку по ротации (персональный анти-флуд сервера легализует
// эстафету — N ботов у клавиатуры дают N-кратную каденцию), бой обслуживает
// combatStep в meatTick. Вскрыл — обычный пуш к сейфу.
func (b *simBot) coverBruteTick(g *simGame) {
	bb := g.bb[b.team]
	if bb.doorCode != "" { // хакер добыл код — перебор не нужен
		b.mm.plan = "push"
		return
	}
	dev := g.w.cyber.devices[b.mm.vaultDoor]
	kp := g.nearestKeypad(b.mm.vaultDoor, b.pl.pos)
	if dev == nil || kp == nil {
		b.mm.plan = "push"
		return
	}
	if dev.open {
		if g.ev.BruteDoorT[b.team] == 0 {
			g.ev.BruteDoorT[b.team] = g.t()
		}
		if g.valve3Open() && bb.safeCode == "" && g.w.physafe.carrier == 0 {
			b.safeRelayTick(g) // клапан открыт — эстафетой перебираем код сейфа
			return
		}
		b.mm.plan = "push"
		return
	}
	if bb.relay == nil {
		bb.relay = &codeGuesser{}
	}
	if d := dist2D(b.pl.pos, kp.Pos); d > 2.4 {
		b.setGoal(g, kp.Pos)
		b.steerFollow(g)
		return
	}
	// у клавиатуры: стоим, по ротации 33 тика (~1.1 с) кто-то один пробует —
	// каждый бот не чаще своего анти-флуда (2 с), каденция команды 2с/N
	var atKP []*simBot
	for _, o := range g.bots {
		if o.team != b.team || o.role == "hacker" || !o.pl.alive {
			continue
		}
		if dist2D(o.pl.pos, kp.Pos) <= 2.4 {
			atKP = append(atKP, o)
		}
	}
	if len(atKP) > 0 {
		prober := atKP[int(g.w.tick/33)%len(atKP)]
		if prober.pl.id == b.pl.id && b.enterCD.Before(g.clock) {
			b.enterCD = g.clock.Add(2300 * time.Millisecond)
			bb.relayBy = b.pl.id
			g.w.handleMessage(b.pl, message{"t": "enter", "dev": kp.ID, "code": bb.relay.probe()})
		}
	}
	b.steer(g, vec3{}, b.pl.yaw+math.Sin(float64(g.w.tick)/20)*0.8, 0)
}

// safeRelayTick — фаза 2 кооп-брута (вопрос владельца 2026-11-21: «один
// бруфорсит, остальные прикрывают»): клапан открыт (лавы нет), эстафетный
// перебор КОДА СЕЙФА у physafe; найденный код вводится тем же ротационным
// порядком — ввод верного кода сам стартует канал crack (3 с, урон прерывает).
func (b *simBot) safeRelayTick(g *simGame) {
	bb := g.bb[b.team]
	if bb.safeCode != "" {
		b.mm.plan = "push" // хакер decrypt'нул — открываем кодом как обычно
		return
	}
	if bb.relay2 == nil {
		bb.relay2 = &codeGuesser{}
	}
	ps := g.w.physafe.pos
	const psEnter = 3.0 // сервер пускает enter в physafeTakeRadius+0.7
	if d := dist2D(b.pl.pos, ps); d > psEnter {
		b.setGoal(g, ps)
		b.steerFollow(g)
		return
	}
	var atPS []*simBot
	for _, o := range g.bots {
		if o.team != b.team || o.role == "hacker" || !o.pl.alive {
			continue
		}
		if dist2D(o.pl.pos, ps) <= psEnter {
			atPS = append(atPS, o)
		}
	}
	if len(atPS) > 0 {
		prober := atPS[int(g.w.tick/33)%len(atPS)]
		if prober.pl.id == b.pl.id && b.enterCD.Before(g.clock) {
			b.enterCD = g.clock.Add(2300 * time.Millisecond)
			bb.relay2By = b.pl.id
			g.w.handleMessage(b.pl, message{"t": "enter", "dev": "physafe", "code": bb.relay2.probe()})
		}
	}
	b.steer(g, vec3{}, math.Atan2(ps[0]-b.pl.pos[0], ps[2]-b.pl.pos[2]), 0)
}

// waveTick — «мясная волна» (сценарий владельца: без хакера, 1 снайпер и 3
// хеви ломятся на 2F и выносят сейф по очереди): каждый сам перебирает СВОЙ
// код у клавиатуры (каденция 2с/N естественная), вскрыл — внутрь к сейфу.
// Лава без клапана встречает волны смертей — сценарий и проверяет клапан-шлюз.
func (b *simBot) waveTick(g *simGame) {
	bb := g.bb[b.team]
	dev := g.w.cyber.devices[b.mm.vaultDoor]
	kp := g.nearestKeypad(b.mm.vaultDoor, b.pl.pos)
	if dev == nil || kp == nil {
		return
	}
	if dev.open {
		if g.ev.BruteDoorT[b.team] == 0 {
			g.ev.BruteDoorT[b.team] = g.t()
		}
		if g.w.physafe.carrier == 0 && b.canReachSafe(g) {
			if d := dist2D(b.pl.pos, g.w.physafe.pos); d < 2.4 {
				b.pressInteractPulse()
				b.steer(g, vec3{}, math.Atan2(g.w.physafe.pos[0]-b.pl.pos[0], g.w.physafe.pos[2]-b.pl.pos[2]), 0)
				return
			}
			b.setGoal(g, g.w.physafe.pos)
			b.steerFollow(g)
			return
		}
		return
	}
	if bb.doorCode != "" { // код всё-таки добыт — обычный ввод
		b.approachKeypad(g, kp)
		return
	}
	if d := dist2D(b.pl.pos, kp.Pos); d > 2.0 {
		if d > 3.2 {
			b.setGoal(g, kp.Pos)
			b.steerFollow(g)
		} else {
			dx, dz := kp.Pos[0]-b.pl.pos[0], kp.Pos[2]-b.pl.pos[2]
			l := math.Max(1e-6, math.Hypot(dx, dz))
			b.steer(g, vec3{dx / l, 0, dz / l}, math.Atan2(dx, dz), 0)
		}
		return
	}
	if b.enterCD.Before(g.clock) {
		b.enterCD = g.clock.Add(2300 * time.Millisecond)
		g.w.handleMessage(b.pl, message{"t": "enter", "dev": kp.ID, "code": b.mm.guesser.probe()})
	}
	b.steer(g, vec3{}, math.Atan2(kp.Pos[0]-b.pl.pos[0], kp.Pos[2]-b.pl.pos[2]), 0)
}

// assassinTick — «мясной раш на чужого хакера» (запрос владельца 2026-11-21:
// 3 снайпера + хакер убивают чужого хакера всегда, победа по фрагам). Цель —
// только легитимные каналы: LOS (класс виден в прицеле) и radar/cam-метки
// с ID игрока.
func (b *simBot) assassinTick(g *simGame) {
	eh := g.hackerOf(1 - b.team)
	if eh == nil || !eh.pl.alive {
		b.patrolTick(g) // враг без хакера — обычное патрулирование
		return
	}
	if b.visTarget != nil && b.visTarget.id == eh.pl.id && b.visTarget.alive {
		b.setGoal(g, eh.pl.pos)
		b.steerFollow(g)
		return
	}
	for _, it := range b.intelFresh(g.clock) {
		if it.by == eh.pl.id {
			b.setGoal(g, it.p)
			b.steerFollow(g)
			return
		}
	}
	b.patrolTick(g)
}

// patrolTick — обход опорных точек мида (общая часть охоты/убийцы).
func (b *simBot) patrolTick(g *simGame) {
	wp := huntPoints[b.mm.wp%len(huntPoints)]
	if dist2D(b.pl.pos, wp) < 2.5 {
		b.mm.wp++
	}
	b.setGoal(g, wp)
	b.steerFollow(g)
}

// bruteTick — физический перебор кодов на клавиатурах (проверка
// «анти-брутфорс» §16.7): дверь хранилища, затем код сейфа у physafe.
func (b *simBot) bruteTick(g *simGame) {
	if b.mm.phase == 0 {
		door := g.w.cyber.devices[b.mm.vaultDoor]
		kp := g.nearestKeypad(b.mm.vaultDoor, b.pl.pos)
		if door == nil || kp == nil {
			b.mm.plan = "push"
			return
		}
		if door.open {
			b.mm.phase = 1
			if g.ev.BruteDoorT[b.team] == 0 {
				g.ev.BruteDoorT[b.team] = g.t()
			}
			return
		}
		if d := dist2D(b.pl.pos, kp.Pos); d > 2.0 {
			if d > 3.2 {
				b.setGoal(g, kp.Pos)
				b.steerFollow(g)
			} else {
				dx, dz := kp.Pos[0]-b.pl.pos[0], kp.Pos[2]-b.pl.pos[2]
				l := math.Max(1e-6, math.Hypot(dx, dz))
				b.steer(g, vec3{dx / l, 0, dz / l}, math.Atan2(dx, dz), 0)
			}
			return
		}
		if b.enterCD.Before(g.clock) {
			b.enterCD = g.clock.Add(2300 * time.Millisecond)
			g.w.handleMessage(b.pl, message{"t": "enter", "dev": kp.ID, "code": b.mm.guesser.probe()})
		}
		b.steer(g, vec3{}, math.Atan2(kp.Pos[0]-b.pl.pos[0], kp.Pos[2]-b.pl.pos[2]), 0)
		return
	}
	// фаза 1: внутри хранилища — брутить код сейфа или нести
	if g.w.physafe.chKind == "crack" {
		b.steer(g, vec3{}, b.pl.yaw, 0) // канал идёт — стоять
		return
	}
	if b.mm.bruteSafe && g.bb[b.team].safeCode == "" {
		d := dist2D(b.pl.pos, g.w.physafe.pos)
		if d > 2.4 {
			b.setGoal(g, g.w.physafe.pos)
			b.steerFollow(g)
			return
		}
		if b.enterCD.Before(g.clock) {
			b.enterCD = g.clock.Add(2300 * time.Millisecond)
			g.w.handleMessage(b.pl, message{"t": "enter", "dev": "physafe", "code": b.mm.guesser2.probe()})
		}
		b.steer(g, vec3{}, math.Atan2(g.w.physafe.pos[0]-b.pl.pos[0], g.w.physafe.pos[2]-b.pl.pos[2]), 0)
		return
	}
	if g.w.physafe.carrier == 0 && dist2D(b.pl.pos, g.w.physafe.pos) < 2.4 {
		b.pressInteractPulse()
		b.steer(g, vec3{}, math.Atan2(g.w.physafe.pos[0]-b.pl.pos[0], g.w.physafe.pos[2]-b.pl.pos[2]), 0)
		return
	}
	b.carryTick(g)
}

func (b *simBot) passiveTick(g *simGame) {
	sp := g.w.m.teamSpawns(b.team)
	if len(sp) == 0 {
		return
	}
	home := vec3{sp[0][0], sp[0][1], sp[0][2]}
	if dist2D(b.pl.pos, home) > 5 {
		b.setGoal(g, home)
		b.steerFollow(g)
		return
	}
	b.steer(g, vec3{}, b.pl.yaw+math.Sin(float64(g.w.tick)/25+float64(b.pl.id))*0.8, 0)
}

func (g *simGame) hackerOf(team int) *simBot {
	for _, b := range g.bots {
		if b.team == team && b.role == "hacker" {
			return b
		}
	}
	return nil
}

// --- брутфорс-угадайка: двухфазный алгоритм (предложение владельца 2026-11-21)
//
// Фаза 1 «перепись»: пробы 0000, 1111, ..., 9999 дают census[d] — сколько
// позиций кода заняты цифрой d (hintMatch считает точные совпадения позиций;
// сумма census всегда 4). Как только сумма набрана, остальные цифры — нули,
// перепись обрывается раньше десятой пробы.
//
// Фаза 2 «перестановки»: код — FNV-1a от имени поколения, цифры МОГУТ
// повторяться, поэтому перебираем все РАЗЛИЧНЫЕ перестановки мультимножества
// (максимум 24 при четырёх разных цифрах). match==4 — код найден. Если все
// перестановки исчерпаны — код сменился (ротация door_key посреди перебора),
// перепись начинается заново.
//
// Итого ~7-10 проб переписи + ~12 перестановок в среднем против ~40 у наивной
// позиционной угадайки: ~40 с соло при анти-флуде 2 с, 2с/N с эстафетой.

type codeGuesser struct {
	census [10]int
	phase  int      // 0 = перепись, 1 = перестановки
	dig    int      // текущая цифра переписи
	perms  []string // кандидаты фазы 2
	permI  int
	done   bool
	code   string
}

func (cg *codeGuesser) probe() string {
	if cg.done {
		return cg.code
	}
	if cg.phase == 0 {
		return fmt.Sprintf("%d%d%d%d", cg.dig, cg.dig, cg.dig, cg.dig)
	}
	if cg.permI >= len(cg.perms) {
		*cg = codeGuesser{} // рестарт: код сменился посреди перебора
		return "0000"
	}
	return cg.perms[cg.permI]
}

func (cg *codeGuesser) onReply(match int) {
	if cg.done || match < 0 {
		return
	}
	if cg.phase == 0 {
		cg.census[cg.dig] = match
		cg.dig++
		sum := 0
		for _, c := range cg.census {
			sum += c
		}
		if sum > 4 {
			// перепись «разъехалась»: код сменился посреди неё (ротация
			// door_key 120 с) — начинается заново
			*cg = codeGuesser{}
			return
		}
		if sum == 4 || cg.dig > 9 {
			cg.perms = multisetPerms(cg.census)
			cg.phase = 1
		}
		return
	}
	cur := cg.perms[cg.permI]
	cg.permI++
	if match == 4 {
		cg.done = true
		cg.code = cur
	}
}

// multisetPerms — все различные перестановки мультимножества цифр census.
// Защита: не более 4 цифр (перепись, смешанная с ротацией кода, может дать
// сумму >4 — лишнее отсекается).
func multisetPerms(census [10]int) []string {
	var digits []byte
	for d := 0; d < 10 && len(digits) < 4; d++ {
		for i := 0; i < census[d] && len(digits) < 4; i++ {
			digits = append(digits, byte('0'+d))
		}
	}
	sort.Slice(digits, func(i, j int) bool { return digits[i] < digits[j] })
	var out []string
	var buf [4]byte
	used := make([]bool, len(digits))
	var rec func(k int)
	rec = func(k int) {
		if k == len(digits) {
			out = append(out, string(buf[:]))
			return
		}
		for i := range digits {
			if used[i] || (i > 0 && digits[i] == digits[i-1] && !used[i-1]) {
				continue
			}
			used[i] = true
			buf[k] = digits[i]
			rec(k + 1)
			used[i] = false
		}
	}
	rec(0)
	return out
}

// onCodeReply — ответ клавиатуры/сейфа на ввод: угадайка + метрики брутфорса.
func (b *simBot) onCodeReply(g *simGame, msg message) {
	bb := g.bb[b.team]
	if msg["ok"] == true {
		if str(msg, "dev") == "physafe" && g.ev.BruteSafeT[b.team] == 0 &&
			((b.mm.plan == "brute" && b.mm.phase == 1) || b.mm.plan == "cover_brute") {
			g.ev.BruteSafeT[b.team] = g.t() // код сейфа подобран брутом
		}
		return
	}
	// hintMatch у сервера — int (num() читает только float64 и давал 0:
	// перепись не сходилась и перебор крутился вечно)
	match := asInt(msg["match"])
	if match < 0 {
		return // анти-флуд: ответ без подсказки — в статистику не идёт
	}
	dev := str(msg, "dev")
	// relay-брут: ответ кормит ОБЩУЮ угадайку команды (проба этого бота в полёте)
	if b.mm.plan == "cover_brute" && strings.HasPrefix(dev, "k") && bb.relay != nil && bb.relayBy == b.pl.id {
		g.ev.BruteTries++
		bb.relay.onReply(match)
		return
	}
	// relay-брут кода сейфа (фаза 2, клапан открыт)
	if b.mm.plan == "cover_brute" && dev == "physafe" && bb.relay2 != nil && bb.relay2By == b.pl.id {
		g.ev.BruteTries++
		bb.relay2.onReply(match)
		return
	}
	// хакер в фазе физического перебора (valve_brute)
	if b.role == "hacker" && b.hh.plan == "valve_brute" && b.hh.phase == "brute" && strings.HasPrefix(dev, "k") {
		g.ev.BruteTries++
		b.hh.guesser.onReply(match)
		return
	}
	if b.mm.plan != "brute" {
		return
	}
	if b.mm.phase == 0 && strings.HasPrefix(dev, "k") {
		g.ev.BruteTries++
		b.mm.guesser.onReply(match)
	} else if b.mm.phase == 1 && dev == "physafe" {
		g.ev.BruteTries++
		b.mm.guesser2.onReply(match)
	}
}

// --- агрегация --------------------------------------------------------------

type keyStat struct {
	games  int
	w      [2]int
	draws  int
	dur    float64
	score0 float64
	score1 float64
}

func (st *keyStat) add(r gameResult) {
	st.games++
	if r.Winner >= 0 && r.Winner < 2 {
		st.w[r.Winner]++
	} else {
		st.draws++
	}
	st.dur += r.DurationS
	st.score0 += float64(r.Scores[0])
	st.score1 += float64(r.Scores[1])
}

func computeSummary(results []gameResult, wall time.Duration) map[string]any {
	games := len(results)
	overall := &keyStat{}
	byReason := map[string]int{}
	byComp := map[string]*keyStat{}
	byPlan := map[string]*keyStat{}
	obj := objectivesStat{}
	cb := combatStat{}
	hackDeaths, jackedDeaths := 0, 0
	doorSum, doorCnt := [2]float64{}, [2]int{}
	safeSum, safeCnt := [2]float64{}, [2]int{}
	vaultSum, vaultCnt := 0.0, 0
	chanSum, chanCnt := 0.0, 0
	bruteGames := 0
	bruteSafeOK := [2]int{}
	bruteDoorOK := [2]int{}
	for _, r := range results {
		overall.add(r)
		byReason[r.Reason]++
		kc := r.Comp[0] + " vs " + r.Comp[1]
		kp := r.Plan[0] + " vs " + r.Plan[1]
		if byComp[kc] == nil {
			byComp[kc] = &keyStat{}
		}
		byComp[kc].add(r)
		if byPlan[kp] == nil {
			byPlan[kp] = &keyStat{}
		}
		byPlan[kp].add(r)
		for i := 0; i < 2; i++ {
			obj.ExtractAttempts[i] += r.Objectives.ExtractAttempts[i]
			obj.SafeTaken[i] += r.Objectives.SafeTaken[i]
			obj.CarrierDeaths[i] += r.Objectives.CarrierDeaths[i]
			obj.GasKills[i] += r.Objectives.GasKills[i]
			obj.GasArms[i] += r.Objectives.GasArms[i]
			obj.ShieldBurns[i] += r.Objectives.ShieldBurns[i]
			obj.AntivirusBlocks[i] += r.Objectives.AntivirusBlocks[i]
			obj.Alerts[i] += r.Objectives.Alerts[i]
			obj.RadarMsgs[i] += r.Objectives.RadarMsgs[i]
			obj.CamFrames[i] += r.Objectives.CamFrames[i]
			if r.Objectives.DoorCodeT[i] > 0 {
				doorSum[i] += r.Objectives.DoorCodeT[i]
				doorCnt[i]++
			}
			if r.Objectives.SafeCodeT[i] > 0 {
				safeSum[i] += r.Objectives.SafeCodeT[i]
				safeCnt[i]++
			}
		}
		if r.Objectives.VaultOpenT > 0 {
			vaultSum += r.Objectives.VaultOpenT
			vaultCnt++
		}
		if r.Objectives.FirstChannelT > 0 {
			chanSum += r.Objectives.FirstChannelT
			chanCnt++
		}
		obj.ValveOpenS += r.Objectives.ValveOpenS
		obj.LavaKills += r.Objectives.LavaKills
		obj.EnvNeutral += r.Objectives.EnvNeutral
		obj.FirewallScanHits += r.Objectives.FirewallScanHits
		obj.BackoffMax += r.Objectives.BackoffMax
		obj.BruteTries += r.Objectives.BruteTries
		cb.Kills += r.Combat.Kills
		cb.FFKills += r.Combat.FFKills
		cb.HackerKills += r.Combat.HackerKills
		cb.EnvKills += r.Combat.EnvKills
		cb.TotalShots += r.Combat.TotalShots
		cb.TotalHits += r.Combat.TotalHits
		for _, p := range r.Players {
			if p.Cls == "hacker" {
				hackDeaths += p.Deaths
				jackedDeaths += p.JackedDeaths
			}
		}
		hasBrute := r.Brute[0] || r.Brute[1]
		for t := 0; t < 2; t++ {
			if r.Squad[t] == "cover_brute" || r.Squad[t] == "wave" || r.Plan[t] == "valve_brute" {
				hasBrute = true
			}
			if r.Objectives.BruteDoorT[t] > 0 {
				bruteDoorOK[t]++
			}
		}
		if hasBrute {
			bruteGames++
		}
		for t := 0; t < 2; t++ {
			if r.Objectives.BruteSafeT[t] > 0 {
				bruteSafeOK[t]++
			}
		}
	}
	share := func(a, b int) float64 {
		if a+b == 0 {
			return 0
		}
		return math.Round(float64(a)/float64(a+b)*1000) / 10
	}
	avg := func(v float64, n int) float64 {
		if n == 0 {
			return 0
		}
		return math.Round(v/float64(n)*10) / 10
	}
	table := func(m map[string]*keyStat) map[string]any {
		out := map[string]any{}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			st := m[k]
			out[k] = map[string]any{
				"games": st.games, "wins": st.w, "draws": st.draws,
				"t0win%": share(st.w[0], st.w[1]), "avgDur": avg(st.dur, st.games),
				"avgScores": []float64{avg(st.score0, st.games), avg(st.score1, st.games)},
			}
		}
		return out
	}
	return map[string]any{
		"games": games, "wallSec": math.Round(wall.Seconds()),
		"wins": overall.w, "draws": overall.draws,
		"team0Share%": share(overall.w[0], overall.w[1]),
		"avgDurS":     avg(overall.dur, games),
		"avgScores":   []float64{avg(overall.score0, games), avg(overall.score1, games)},
		"byReason":    byReason,
		"byComp":      table(byComp),
		"byPlan":      table(byPlan),
		"objectives": map[string]any{
			"doorCodeAvgS": []float64{avg(doorSum[0], doorCnt[0]), avg(doorSum[1], doorCnt[1])},
			"doorCodeIn":   []int{doorCnt[0], doorCnt[1]},
			"safeCodeAvgS": []float64{avg(safeSum[0], safeCnt[0]), avg(safeSum[1], safeCnt[1])},
			"safeCodeIn":   []int{safeCnt[0], safeCnt[1]},
			"vaultOpenAvgS": avg(vaultSum, vaultCnt),
			"vaultOpenIn":   vaultCnt,
			"firstChannelAvgS": avg(chanSum, chanCnt),
			"extractAttempts":  obj.ExtractAttempts,
			"safeTaken":        obj.SafeTaken,
			"carrierDeaths":    obj.CarrierDeaths,
			"valveOpenAvgS":    avg(obj.ValveOpenS, games),
			"gasKills":         obj.GasKills,
			"gasArms":          obj.GasArms,
			"lavaKills":        obj.LavaKills,
			"envNeutral":       obj.EnvNeutral,
			"shieldBurns":      obj.ShieldBurns,
			"antivirusBlocks":  obj.AntivirusBlocks,
			"backoffMaxAvg":    avg(float64(obj.BackoffMax), games),
			"firewallScanHits": obj.FirewallScanHits,
			"alerts":           obj.Alerts,
			"radarMsgs":        obj.RadarMsgs,
			"camFrames":        obj.CamFrames,
			"brute": map[string]any{
				"games": bruteGames, "hintTries": obj.BruteTries,
				"doorOpened": []int{bruteDoorOK[0], bruteDoorOK[1]},
					"safeOpened": []int{bruteSafeOK[0], bruteSafeOK[1]},
			},
		},
		"combat": map[string]any{
			"killsPerGame": avg(float64(cb.Kills), games),
			"ffKills":      cb.FFKills,
			"hackerKills":  cb.HackerKills,
			"envKills":     cb.EnvKills,
			"accuracy%":    math.Round(float64(cb.TotalHits)/math.Max(1, float64(cb.TotalShots))*1000) / 10,
			"hackerDeaths": hackDeaths,
			"jackedDeaths": jackedDeaths,
		},
	}
}

// --- отладка одного матча ---------------------------------------------------
func TestSimDebug(t *testing.T) {
	log.SetOutput(io.Discard)
	m, _ := parseGameMap(h2dm1JSON)
	ng := buildNavGrid(m)
	simTraceT = t
	defer func() { simTraceT = nil }()
	*simComps = "3SN,3AR"
	*simTeams = "valve_brute,door_rush"
	*simSquads = "escort,push"
	*simPassive = 0
	res := runSimGame(42, ng, ng)
	t.Logf("RESULT winner=%d reason=%s dur=%.0f scores=%v", res.Winner, res.Reason, res.DurationS, res.Scores)
	t.Logf("obj: %+v", res.Objectives)
	for _, p := range res.Players {
		t.Logf("p%d t%d %-7s frags=%d deaths=%d shots=%d hits=%d progs=%d troj=%d jackS=%.0f",
			p.ID, p.Team, p.Cls, p.Frags, p.Deaths, p.Shots, p.Hits, p.ProgsRun, p.Trojans, p.JackedS)
	}
}
