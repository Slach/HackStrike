package main

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

func mustParseEmbeddedMap(t *testing.T) *gameMap {
	t.Helper()
	m, err := parseGameMap(h2dm1JSON)
	if err != nil {
		t.Fatalf("parseGameMap(embedded): %v", err)
	}
	return m
}

func TestMapParsesAndSpawnsExist(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	for _, team := range []string{"0", "1"} {
		if len(m.Spawns[team]) < 4 {
			t.Fatalf("team %s: want >=4 spawns, got %d", team, len(m.Spawns[team]))
		}
	}
	// Спавны не внутри геометрии.
	for _, team := range []int{0, 1} {
		for i, s := range m.teamSpawns(team) {
			if m.overlapsAny(playerBoxAt(vec3(s))) {
				t.Fatalf("spawn team %d [%d] %v intersects geometry", team, i, s)
			}
		}
	}
}

// §14.2: kind `gas` — валидация как у двери: size [w,h,d] > 0 обязателен,
// to → существующий switch; карта m1 содержит ровно один газовый проп.
func TestMapGasValidation(t *testing.T) {
	const base = `{"name":"g","bounds":[40,8,40],
	 "colliders":[{"min":[0,0,0],"max":[40,1,40],"kind":"floor"},
	              {"min":[0,1,37],"max":[0.7,1.5,39],"kind":"stair"}],
	 "spawns":{"0":[[5,1,5]],"1":[[35,1,35]]},
	 "props":[{"kind":"switch","id":"s1","pos":[5,1,15]},%s]}`

	if _, err := parseGameMap([]byte(fmt.Sprintf(base,
		`{"kind":"gas","id":"g1","pos":[20,1.5,20],"size":[6,3,6],"to":"s1"}`))); err != nil {
		t.Fatalf("valid gas must parse: %v", err)
	}
	if _, err := parseGameMap([]byte(fmt.Sprintf(base,
		`{"kind":"gas","id":"g1","pos":[20,1.5,20],"to":"s1"}`))); err == nil ||
		!strings.Contains(err.Error(), "size") {
		t.Fatalf("gas without size must be rejected, got %v", err)
	}
	if _, err := parseGameMap([]byte(fmt.Sprintf(base,
		`{"kind":"gas","id":"g1","pos":[20,1.5,20],"size":[6,3,0],"to":"s1"}`))); err == nil ||
		!strings.Contains(err.Error(), "size") {
		t.Fatalf("gas with zero component must be rejected, got %v", err)
	}
	if _, err := parseGameMap([]byte(fmt.Sprintf(base,
		`{"kind":"gas","id":"g1","pos":[20,1.5,20],"size":[6,3,6],"to":"nope"}`))); err == nil ||
		!strings.Contains(err.Error(), "switch") {
		t.Fatalf("gas to→missing must be rejected, got %v", err)
	}
	if _, err := parseGameMap([]byte(fmt.Sprintf(base,
		`{"kind":"gas","id":"g1","pos":[20,1.5,20],"size":[6,3,6]}`))); err == nil ||
		!strings.Contains(err.Error(), "switch") {
		t.Fatalf("gas without to must be rejected, got %v", err)
	}

	m := mustParseEmbeddedMap(t)
	gases := 0
	for _, p := range m.props {
		if p.Kind == "gas" {
			gases++
		}
	}
	if gases != 6 {
		t.Fatalf("m1 must carry 6 gases: 2 mirrored chambers g1/g2 + 4 stair shafts g3..g6 (§14.2 rev 2026-11-21), got %d", gases)
	}
}

// fireMapJSON — базовая мини-карта для валидации kind `fire`/`valve`
// (§14.6.1); s1 — switch-якорь сети.
func fireMapJSON(prop string) string {
	return `{"name":"f","bounds":[40,16,40],
	 "colliders":[{"min":[0,0,0],"max":[40,1,40],"kind":"floor"},
	              {"min":[0,1,37],"max":[0.7,1.5,39],"kind":"stair"}],
	 "spawns":{"0":[[5,1,5]],"1":[[35,1,35]]},
	 "props":[{"kind":"switch","id":"s1","pos":[5,1,15]},
	          {"kind":"valve","id":"v1","pos":[10,1,15],"to":"s1"},` + prop + `]}`
}

// §14.6.1 (ревизия v1): kind `fire` — стихия: size [w,h,d] > 0 обязателен,
// to → существующий valve, from запрещён; кабель к огню недопустим.
// kind `valve` — сетевой контроллер: to → существующий switch.
// m1 несёт ровно 3 полосы lv1/lv2/lv3 — вытянутые у wifi-точек (z-зеркало)
// и lv3 в data-отсеке, каждая с ссылкой на свой клапан v1/v2/v3.
func TestMapFireValidation(t *testing.T) {
	if _, err := parseGameMap([]byte(fireMapJSON(
		`{"kind":"fire","id":"lv1","pos":[20,1.15,20],"size":[4,0.3,4],"to":"v1"}`))); err != nil {
		t.Fatalf("valid fire must parse: %v", err)
	}
	if _, err := parseGameMap([]byte(fireMapJSON(
		`{"kind":"fire","id":"lv1","pos":[20,1.15,20]}`))); err == nil ||
		!strings.Contains(err.Error(), "size") {
		t.Fatalf("fire without size must be rejected, got %v", err)
	}
	if _, err := parseGameMap([]byte(fireMapJSON(
		`{"kind":"fire","id":"lv1","pos":[20,1.15,20],"size":[4,0.3,4]}`))); err == nil ||
		!strings.Contains(err.Error(), "valve") {
		t.Fatalf("fire without to→valve must be rejected, got %v", err)
	}
	if _, err := parseGameMap([]byte(fireMapJSON(
		`{"kind":"fire","id":"lv1","pos":[20,1.15,20],"size":[4,0.3,4],"to":"s1"}`))); err == nil ||
		!strings.Contains(err.Error(), "valve") {
		t.Fatalf("fire to→switch must be rejected (valve only), got %v", err)
	}
	if _, err := parseGameMap([]byte(fireMapJSON(
		`{"kind":"fire","id":"lv1","pos":[20,1.15,20],"size":[4,0.3,4],"to":"nope"}`))); err == nil ||
		!strings.Contains(err.Error(), "valve") {
		t.Fatalf("fire to→missing must be rejected, got %v", err)
	}
	if _, err := parseGameMap([]byte(fireMapJSON(
		`{"kind":"fire","id":"lv1","pos":[20,1.15,20],"size":[4,0.3,4],"to":"v1","from":"s1"}`))); err == nil ||
		!strings.Contains(err.Error(), "from") {
		t.Fatalf("fire with from must be rejected as non-network, got %v", err)
	}
	// Кабель к огню — endpoint не устройство: ребро запрещено.
	if _, err := parseGameMap([]byte(fireMapJSON(
		`{"kind":"fire","id":"lv1","pos":[20,1.15,20],"size":[4,0.3,4],"to":"v1"},` +
			`{"kind":"cable","id":"c9","from":"s1","to":"lv1"}`))); err == nil {
		t.Fatalf("cable to fire must be rejected (not a network device)")
	}
	// Клапан: to → только switch.
	if _, err := parseGameMap([]byte(fireMapJSON(
		`{"kind":"fire","id":"lv1","pos":[20,1.15,20],"size":[4,0.3,4],"to":"v1"},
		 {"kind":"valve","id":"v2","pos":[11,1,15],"to":"v1"}`))); err == nil ||
		!strings.Contains(err.Error(), "switch") {
		t.Fatalf("valve to→valve must be rejected, got %v", err)
	}

	m := mustParseEmbeddedMap(t)
	fi := map[string]mapProp{}
	fires := 0
	for _, p := range m.props {
		if p.Kind == "fire" {
			fires++
			fi[p.ID] = p
		}
	}
	if fires != 3 || len(fi) != 3 {
		t.Fatalf("m1 must carry exactly 3 fire strips lv1..lv3 (§14.6.1), got %d", fires)
	}
	a, b, c := fi["lv1"], fi["lv2"], fi["lv3"]
	if a.ID != "lv1" || b.ID != "lv2" || c.ID != "lv3" {
		t.Fatalf("m1 fire ids must be lv1/lv2/lv3, got %v", fi)
	}
	// Полосы у wifi-точек: z-зеркальная пара r1/r2 (z′=64−z), x/size идентичны
	// (решение владельца: у спавнов слишком хардкор — огонь теперь у радио).
	if b.Pos[2] != 64-a.Pos[2] || b.Pos[0] != a.Pos[0] || b.Pos[1] != a.Pos[1] ||
		b.Size != a.Size {
		t.Fatalf("lv2 must mirror lv1 across z=32 exactly: lv1=%v lv2=%v", a, b)
	}
	// Вытянутость: полосы 1 этажа длинные (E-W), lv3 осталась точечной 4×4.
	if a.Size[0] < 8 {
		t.Fatalf("ground strips must be elongated (owner rev), got %v", a.Size)
	}
	// Лужи стоят НА плите: низ пола 1 этажа = 1.0, террасы = 8.0
	// (float-допуск: 1.15−0.3/2 не ровно 1.0 в двоичной арифметике).
	for _, p := range []mapProp{a, b} {
		if d := math.Abs(p.Pos[1] - p.Size[1]/2 - 1.0); d > 1e-9 {
			t.Fatalf("ground strip %s must sit on floor top y=1, got bottom %v", p.ID, p.Pos[1]-p.Size[1]/2)
		}
	}
	if d := math.Abs(c.Pos[1] - c.Size[1]/2 - 8.0); d > 1e-9 {
		t.Fatalf("terrace strip lv3 must sit on slab top y=8, got bottom %v", c.Pos[1]-c.Size[1]/2)
	}
	// Каждая полоса ссылается на свой клапан; клапаны — на s1/s2/s3.
	want := map[string]string{"lv1": "v1", "lv2": "v2", "lv3": "v3"}
	for id, v := range want {
		if fi[id].To != v {
			t.Fatalf("fire %s must reference valve %s, got %q", id, v, fi[id].To)
		}
	}
	valves := map[string]string{}
	for _, p := range m.props {
		if p.Kind == "valve" {
			valves[p.ID] = p.To
		}
	}
	if len(valves) != 3 || valves["v1"] != "s1" || valves["v2"] != "s2" || valves["v3"] != "s3" {
		t.Fatalf("m1 valves v1..v3 must bind s1/s2/s3, got %v", valves)
	}
	// Огонь далеко от спавнов (решение владельца: у спавнов слишком хардкор).
	for _, p := range m.props {
		if p.Kind != "fire" {
			continue
		}
		box := aabb{
			min: vec3{p.Pos[0] - p.Size[0]/2, p.Pos[1] - p.Size[1]/2, p.Pos[2] - p.Size[2]/2},
			max: vec3{p.Pos[0] + p.Size[0]/2, p.Pos[1] + p.Size[1]/2, p.Pos[2] + p.Size[2]/2},
		}
		for _, team := range []int{0, 1} {
			for _, sp := range m.teamSpawns(team) {
				if boxOverlapPoint(box, vec3(sp), 4.0) {
					t.Fatalf("fire %s within 4 m of spawn %v (owner: not hardcore)", p.ID, sp)
				}
			}
		}
	}
	// Ни одна полоса не пересекает не-floor коллайдер (пол под полосой —
	// опора, пересечение ожидаемо; boundary-touch не считается, boxesOverlap
	// строгая).
	for _, p := range m.props {
		if p.Kind != "fire" {
			continue
		}
		box := aabb{
			min: vec3{p.Pos[0] - p.Size[0]/2, p.Pos[1] - p.Size[1]/2, p.Pos[2] - p.Size[2]/2},
			max: vec3{p.Pos[0] + p.Size[0]/2, p.Pos[1] + p.Size[1]/2, p.Pos[2] + p.Size[2]/2},
		}
		for _, c := range m.Colliders {
			if c.Kind == "floor" {
				continue
			}
			if boxesOverlap(box, aabb{vec3(c.Min), vec3(c.Max)}) {
				t.Fatalf("fire %s intersects %s collider %v..%v", p.ID, c.Kind, c.Min, c.Max)
			}
		}
	}
}

// boxOverlapPoint — AABB против точки с допуском pad по всем осям.
func boxOverlapPoint(b aabb, p vec3, pad float64) bool {
	return p[0] >= b.min[0]-pad && p[0] <= b.max[0]+pad &&
		p[1] >= b.min[1]-pad && p[1] <= b.max[1]+pad &&
		p[2] >= b.min[2]-pad && p[2] <= b.max[2]+pad
}

// TestMapStairsAutostepable — все ступени не выше 0.5 (autostep 0.55).
func TestMapStairsAutostepable(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	stairs := 0
	for _, c := range m.Colliders {
		if c.Kind != "stair" {
			continue
		}
		stairs++
		if h := c.Max[1] - c.Min[1]; h > 0.5+1e-9 {
			t.Fatalf("stair %v..%v height %v > 0.5", c.Min, c.Max, h)
		}
	}
	if stairs < 4 { // минимум 2 лестницы по несколько ступеней
		t.Fatalf("want >=2 staircases, got %d stair boxes", stairs)
	}
}

// TestStaircasesComplete — все 4 лестницы (угловые шахты, зеркальная симметрия
// §8; СЗ/ЮЮВ были в M1, СВ/ЮЗ добавлены под M4/M5) собраны целиком в своих
// шахтах и с непрерывной лестницей высот. Регрессия: генератор карты однажды
// расщепил SE-лестницу, отправив половину ступеней зеркальной копией не в тот
// угол — лестница обрывалась на 7.5 и была непроходима.
func TestStaircasesComplete(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	type shaft struct{ x0, x1, z0, z1 float64 }
	shafts := map[string]shaft{
		"NW": {6.0, 15.8, 2.0, 4.0},
		"NE": {48.2, 58.0, 2.0, 4.0},
		"SW": {6.0, 15.8, 60.0, 62.0},
		"SE": {48.2, 58.0, 60.0, 62.0},
	}
	byShaft := map[string]map[float64]int{} // top height -> count
	for _, c := range m.Colliders {
		if c.Kind != "stair" {
			continue
		}
		matched := ""
		for name, s := range shafts {
			if c.Min[0] >= s.x0-1e-6 && c.Max[0] <= s.x1+1e-6 &&
				c.Min[2] >= s.z0-1e-6 && c.Max[2] <= s.z1+1e-6 {
				matched = name
				break
			}
		}
		if matched == "" {
			t.Fatalf("stair outside both shafts: %v..%v", c.Min, c.Max)
		}
		if byShaft[matched] == nil {
			byShaft[matched] = map[float64]int{}
		}
		byShaft[matched][math.Round(c.Max[1]*1000)/1000]++
	}
	for name := range shafts {
		tops := byShaft[name]
		if len(tops) != 14 {
			t.Fatalf("%s staircase: want 14 steps, got %d (%v)", name, len(tops), tops)
		}
		for i := 0; i < 14; i++ {
			h := 1.5 + 0.5*float64(i)
			if tops[math.Round(h*1000)/1000] != 1 {
				t.Fatalf("%s staircase: missing/duplicate step at height %v", name, h)
			}
		}
	}
}

// TestMapConnectivity — грубая BFS по колонкам 1×1: переход между соседними
// колонками разрешён при перепаде высот опоры <= autostep. Проверяем, что
// с базы команды 0 достижимы база команды 1 и второй этаж (опора >= 8).
func TestMapConnectivity(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	const n = 64
	// tops[x][z] — высоты опор в колонке: бокс считается опорой колонки,
	// если пересекает её квадрант [x..x+1]×[z..z+1] (аппроксимация опоры
	// игрока AABB 0.6 — ступени глубиной 0.7 не оставляют пустых колонок).
	tops := make([][][]float64, n)
	for x := 0; x < n; x++ {
		tops[x] = make([][]float64, n)
		for z := 0; z < n; z++ {
			for _, c := range m.Colliders {
				if c.Min[0] < float64(x+1) && c.Max[0] > float64(x) &&
					c.Min[2] < float64(z+1) && c.Max[2] > float64(z) {
					tops[x][z] = append(tops[x][z], c.Max[1])
				}
			}
		}
	}
	start := m.teamSpawns(0)[0]
	sx, sz := int(start[0]), int(start[2])

	type node struct{ x, z, i int }
	seen := map[node]bool{}
	queue := []node{}
	for i, top := range tops[sx][sz] {
		if math.Abs(top-start[1]) < 0.01 {
			n0 := node{sx, sz, i}
			seen[n0] = true
			queue = append(queue, n0)
		}
	}
	if len(queue) == 0 {
		t.Fatalf("spawn column has no support at spawn height")
	}

	reachSpawn1, reachFloor2 := false, false
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		h := tops[cur.x][cur.z][cur.i]
		if h >= 8 {
			reachFloor2 = true
		}
		for _, d := range [4][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			nx, nz := cur.x+d[0], cur.z+d[1]
			if nx < 0 || nz < 0 || nx >= n || nz >= n {
				continue
			}
			for i, top := range tops[nx][nz] {
				nn := node{nx, nz, i}
				if seen[nn] || math.Abs(top-h) > autostepHeight {
					continue
				}
				seen[nn] = true
				queue = append(queue, nn)
			}
		}
	}
	for _, s := range m.teamSpawns(1) {
		x, z := int(s[0]), int(s[1])
		for _, top := range tops[x][z] {
			if math.Abs(top-s[1]) < 0.01 && seen[node{x, z, indexOf(tops[x][z], top)}] {
				reachSpawn1 = true
			}
		}
	}
	if !reachSpawn1 {
		t.Fatalf("team 1 spawns unreachable from team 0 spawn")
	}
	if !reachFloor2 {
		t.Fatalf("second floor (support >= 8) unreachable — stairs broken")
	}
}

func indexOf(vals []float64, v float64) int {
	for i, x := range vals {
		if x == v {
			return i
		}
	}
	return -1
}

// TestAPIMapServesEmbedded — /api/map отдаёт ровно встроенные байты
// (единый источник геометрии для клиента и сервера). M2: пропсы типизируются
// при парсинге (§12.3).
func TestAPIMapServesEmbedded(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	if m.Name != "h2dm1" || len(m.Colliders) == 0 {
		t.Fatalf("unexpected embedded map: %+v", m)
	}
	if len(m.Props) == 0 || len(m.props) != len(m.Props) {
		t.Fatalf("M2 props must parse: raw=%d typed=%d", len(m.Props), len(m.props))
	}
	if len(h2dm1JSON) == 0 {
		t.Fatalf("embedded map bytes are empty")
	}
}
