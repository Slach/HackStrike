package main

import (
	"math"
	"testing"
)

// Мини-арена: пол 10×10, платформа-ступень 0.5 м (x 4..6.5), стена 2 м (x 7..8),
// северная стена (z 9..10).
func physTestMap() *gameMap {
	return &gameMap{
		Name:   "t",
		Bounds: [3]float64{10, 8, 10},
		Colliders: []collider{
			{Min: [3]float64{0, 0, 0}, Max: [3]float64{10, 1, 10}, Kind: "floor"},
			{Min: [3]float64{4, 1, 3}, Max: [3]float64{6.5, 1.5, 6}, Kind: "stair"},
			{Min: [3]float64{7, 1, 0}, Max: [3]float64{8, 3, 10}, Kind: "wall"},
			{Min: [3]float64{5, 1, 9}, Max: [3]float64{10, 3, 10}, Kind: "wall"},
		},
	}
}

func runTicks(m *gameMap, pl *player, n int) {
	for i := 0; i < n; i++ {
		m.movePlayer(pl, tickDT)
	}
}

// Автостеп: игрок взбирается на ступень 0.5 и упирается в стену 2 м,
// не проходя сквозь неё.
func TestMoveAutostepAndWall(t *testing.T) {
	m := physTestMap()
	pl := &player{cls: "assault", pos: vec3{2, 1, 4.5}, grounded: true}
	pl.yaw = math.Pi / 2 // forward = +X
	pl.keys.w = true

	runTicks(m, pl, 150)

	if got := pl.pos[1]; math.Abs(got-1.5) > 0.01 {
		t.Fatalf("autostep: want y=1.5 on the stair, got %v", got)
	}
	if got := pl.pos[0]; got > 7-playerHalf+0.01 {
		t.Fatalf("walked through the wall: x=%v", got)
	}
	if got := pl.pos[0]; got < 6.2 {
		t.Fatalf("stopped too early before the wall: x=%v", got)
	}
}

// Стена блокирует движение по Z; за карту не выйти.
func TestMoveBlockedByWall(t *testing.T) {
	m := physTestMap()
	pl := &player{cls: "assault", pos: vec3{5, 1.5, 7.5}, grounded: true}
	pl.yaw = 0 // forward = +Z
	pl.keys.w = true

	runTicks(m, pl, 60)

	if got := pl.pos[2]; got > 9-playerHalf+0.01 {
		t.Fatalf("walked through the wall: z=%v", got)
	}
	if got := pl.pos[2]; got < 8.4 {
		t.Fatalf("should have walked north up to the wall, z=%v", got)
	}
}

// Гравитация 20 м/с²: свободное падение останавливается на полу.
func TestGravityLandsOnFloor(t *testing.T) {
	m := physTestMap()
	pl := &player{cls: "assault", pos: vec3{2, 5, 2}}

	runTicks(m, pl, 60)

	if got := pl.pos[1]; math.Abs(got-1) > 0.01 {
		t.Fatalf("want y=1 on the floor, got %v", got)
	}
	if !pl.grounded {
		t.Fatalf("should be grounded after landing")
	}
	if pl.vy != 0 {
		t.Fatalf("vy should be zero after landing, got %v", pl.vy)
	}
}

// Препятствие ниже autostep проходится подъёмом, выше — блокирует.
func TestStepThreshold(t *testing.T) {
	m := &gameMap{
		Name:   "t",
		Bounds: [3]float64{20, 8, 10},
		Colliders: []collider{
			{Min: [3]float64{0, 0, 0}, Max: [3]float64{20, 1, 10}, Kind: "floor"},
			{Min: [3]float64{4, 1, 0}, Max: [3]float64{11, 1.5, 10}, Kind: "stair"},   // платформа 0.5 над полом
			{Min: [3]float64{11, 1.5, 0}, Max: [3]float64{16, 2.2, 10}, Kind: "wall"}, // бордюр 0.7 над ней
		},
	}
	pl := &player{cls: "assault", pos: vec3{1, 1, 5}, grounded: true}
	pl.yaw = math.Pi / 2
	pl.keys.w = true

	runTicks(m, pl, 40) // ~8.7 м пути: подъём и прогулка по платформе
	if got := pl.pos[1]; math.Abs(got-1.5) > 0.01 {
		t.Fatalf("should step onto the 0.5 platform, y=%v pos=%v", got, pl.pos)
	}
	if pl.pos[0] < 8 || pl.pos[0] > 11 {
		t.Fatalf("should be on the platform, pos=%v", pl.pos)
	}

	runTicks(m, pl, 60)
	if got := pl.pos[0]; got > 11-playerHalf+0.01 {
		t.Fatalf("0.7 ledge must block (autostep is 0.55), x=%v", got)
	}
	if got := pl.pos[1]; math.Abs(got-1.5) > 0.01 {
		t.Fatalf("must stay on the platform at y=1.5, y=%v", got)
	}
}

// Встроенная карта: игрок поднимается по лестнице NW (ступени 0.5 м с y=1
// до y=8) простым движением вперёд — autostep на каждой ступени.
func TestClimbEmbeddedStaircase(t *testing.T) {
	m, err := parseGameMap(map1JSON)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	pl := &player{cls: "assault", pos: vec3{4.5, 1, 3}, grounded: true}
	pl.yaw = math.Pi / 2 // вперёд = +X, к лестнице
	pl.keys.w = true

	runTicks(m, pl, 150) // 5 секунд при 30 Гц

	if got := pl.pos[1]; math.Abs(got-8) > 0.01 {
		t.Fatalf("should reach the 2nd floor (y=8) via stairs, y=%v pos=%v", got, pl.pos)
	}
	// Вышел с лестницы и идёт по террасе 2-го этажа (упирается в N-надстройку).
	if got := pl.pos[0]; got < 16 {
		t.Fatalf("should have left the stairwell onto the terrace, x=%v", got)
	}
}

// Зеркальный (180°) подъём по SE-лестнице: до фикса карты её верхняя ступень
// лежала в NE-углу, и лестница обрывалась на y=7.5.
func TestClimbSEStaircase(t *testing.T) {
	m, err := parseGameMap(map1JSON)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	pl := &player{cls: "assault", pos: vec3{59.5, 1, 61}, grounded: true}
	pl.yaw = -math.Pi / 2 // вперёд = -X, к лестнице
	pl.keys.w = true

	runTicks(m, pl, 150)

	if got := pl.pos[1]; math.Abs(got-8) > 0.01 {
		t.Fatalf("should reach the 2nd floor (y=8) via SE stairs, y=%v pos=%v", got, pl.pos)
	}
	if got := pl.pos[0]; got > 48 {
		t.Fatalf("should have left the stairwell onto the terrace, x=%v", got)
	}
}

// Проходимость СВ-лестницы (M4/M5, развёртка карты): ступени 0.5 м, подъём
// к -X (зеркало SE по z=32), проём в плите террасы x48.2..53.5/z2..4.
func TestClimbNEStaircase(t *testing.T) {
	m, err := parseGameMap(map1JSON)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	pl := &player{cls: "assault", pos: vec3{59.5, 1, 3}, grounded: true}
	pl.yaw = -math.Pi / 2 // вперёд = -X, к лестнице
	pl.keys.w = true

	runTicks(m, pl, 150)

	if got := pl.pos[1]; math.Abs(got-8) > 0.01 {
		t.Fatalf("should reach the 2nd floor (y=8) via NE stairs, y=%v pos=%v", got, pl.pos)
	}
	if got := pl.pos[0]; got > 48 {
		t.Fatalf("should have left the stairwell onto the terrace, x=%v", got)
	}
}

// Проходимость ЮЗ-лестницы (зеркало NW по z=32): подъём к +X, проём
// x10.5..15.8/z60..62.
func TestClimbSWStaircase(t *testing.T) {
	m, err := parseGameMap(map1JSON)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	pl := &player{cls: "assault", pos: vec3{4.5, 1, 61}, grounded: true}
	pl.yaw = math.Pi / 2 // вперёд = +X, к лестнице
	pl.keys.w = true

	runTicks(m, pl, 150)

	if got := pl.pos[1]; math.Abs(got-8) > 0.01 {
		t.Fatalf("should reach the 2nd floor (y=8) via SW stairs, y=%v pos=%v", got, pl.pos)
	}
	if got := pl.pos[0]; got < 16 {
		t.Fatalf("should have left the stairwell onto the terrace, x=%v", got)
	}
}

// wishDir: WASD относительно yaw (LH: yaw 0 = +Z, yaw pi/2 = +X).
func TestWishDir(t *testing.T) {
	cases := []struct {
		yaw  float64
		keys keysState
		want vec3
	}{
		{0, keysState{w: true}, vec3{0, 0, 1}},
		{0, keysState{s: true}, vec3{0, 0, -1}},
		{math.Pi / 2, keysState{w: true}, vec3{1, 0, 0}},
		{0, keysState{d: true}, vec3{1, 0, 0}},
		{0, keysState{a: true}, vec3{-1, 0, 0}},
		{0, keysState{w: true, d: true}, vec3{math.Sqrt2 / 2, 0, math.Sqrt2 / 2}},
		{0, keysState{w: true, s: true}, vec3{0, 0, 0}},
	}
	for _, c := range cases {
		got := wishDir(c.yaw, c.keys)
		if math.Abs(got.sub(c.want).length()) > 1e-9 {
			t.Fatalf("wishDir(yaw=%v, keys=%+v) = %v, want %v", c.yaw, c.keys, got, c.want)
		}
	}
}
