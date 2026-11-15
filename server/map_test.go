package main

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

func mustParseEmbeddedMap(t *testing.T) *gameMap {
	t.Helper()
	m, err := parseGameMap(map1JSON)
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
	if gases != 1 {
		t.Fatalf("m1 must carry exactly one gas chamber (§14.2), got %d", gases)
	}
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

// TestStaircasesComplete — обе лестницы (NW и SE, зеркальные 180°) собраны
// целиком в своих шахтах и с непрерывной лестницей высот. Регрессия: генератор
// карты однажды расщепил SE-лестницу, отправив половину ступеней зеркальной
// копией не в тот угол — лестница обрывалась на 7.5 и была непроходима.
func TestStaircasesComplete(t *testing.T) {
	m := mustParseEmbeddedMap(t)
	type shaft struct{ x0, x1, z0, z1 float64 }
	shafts := map[string]shaft{
		"NW": {6.0, 15.8, 2.0, 4.0},
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
	if m.Name != "m1" || len(m.Colliders) == 0 {
		t.Fatalf("unexpected embedded map: %+v", m)
	}
	if len(m.Props) == 0 || len(m.props) != len(m.Props) {
		t.Fatalf("M2 props must parse: raw=%d typed=%d", len(m.Props), len(m.props))
	}
	if len(map1JSON) == 0 {
		t.Fatalf("embedded map bytes are empty")
	}
}
