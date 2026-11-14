package main

import (
	"math"
	"testing"
	"time"
)

// aimLevelY — высота ног цели, при которой центр её AABB совпадает
// с высотой глаз стрелка, стоящего на полу (y=1).
const aimLevelY = 1 + eyeHeight - playerHeight/2

// Боевая мини-арена: только пол, цель ставим руками. Глаза стрелка на
// y = 1 + 1.6 = 2.6; цель ставим так, чтобы центр её AABB (ноги + 0.9)
// был на высоте глаз — тогда угол к цели определяется только смещением по X.
func combatWorld(t *testing.T) (*world, *player, *player, *time.Time) {
	t.Helper()
	m := &gameMap{
		Name:   "t",
		Bounds: [3]float64{40, 8, 40},
		Colliders: []collider{
			{Min: [3]float64{0, 0, 0}, Max: [3]float64{40, 1, 40}, Kind: "floor"},
		},
	}
	w := newWorld(m)
	clock := time.UnixMilli(1_700_000_000_000)
	w.now = func() time.Time { return clock }

	shooter := w.addPlayer(1, "shooter", "sniper")
	victim := w.addPlayer(2, "victim", "assault")
	shooter.team, victim.team = 0, 0 // союзники: friendly fire ON
	shooter.pos = vec3{0, 1, 0}
	victim.pos = vec3{0, aimLevelY, 10} // центр AABB на высоте глаз
	victim.hp = 125
	w.takeOut() // сбросить welcome
	return w, shooter, victim, &clock
}

func shots(w *world) []message {
	var res []message
	for _, om := range w.takeOut() {
		if om.msg["t"] == "shot" {
			res = append(res, om.msg)
		}
	}
	return res
}

// Конус ~2°: смещение 0.25 м на 10 м (~1.4°) — попадание, 0.6 м (~3.4°) — мимо.
func TestFireCone(t *testing.T) {
	w, shooter, victim, _ := combatWorld(t)

	// Внутри конуса.
	victim.pos = vec3{0.25, aimLevelY, 10}
	w.fire(shooter, 0, 0)
	s := shots(w)
	if len(s) != 1 || s[0]["hit"] != victim.id {
		t.Fatalf("target 1.4° off-axis must be hit, got %+v", s)
	}
	if want := 125 - 80; victim.hp != want {
		t.Fatalf("sniper damage: victim hp = %d, want %d", victim.hp, want)
	}
	// Точка попадания — на луче, близко к цели.
	to := s[0]["to"].(vec3)
	if math.Abs(to[2]-10) > 1.0 || math.Abs(to[0]) > 0.3 {
		t.Fatalf("hit point %v should be near the target", to)
	}

	// Вне конуса.
	victim.pos = vec3{0.6, aimLevelY, 10}
	w.fire(shooter, 0, 0)
	s = shots(w)
	if len(s) != 1 || s[0]["hit"] != nil {
		t.Fatalf("target 3.4° off-axis must be missed, got %+v", s)
	}
	if victim.hp != 45 {
		t.Fatalf("miss must not deal damage, hp=%d", victim.hp)
	}
}

// LOS: цель точно по оси, но за стеной — попадания нет.
func TestFireLOSBlocked(t *testing.T) {
	w, shooter, victim, _ := combatWorld(t)
	w.m.Colliders = append(w.m.Colliders,
		collider{Min: [3]float64{-1, 1, 5}, Max: [3]float64{1, 3, 6}, Kind: "wall"})
	victim.pos = vec3{0, aimLevelY, 10}

	w.fire(shooter, 0, 0)
	s := shots(w)
	if len(s) != 1 || s[0]["hit"] != nil {
		t.Fatalf("target behind a wall must not be hit, got %+v", s)
	}
	if victim.hp != 125 {
		t.Fatalf("no damage through a wall, hp=%d", victim.hp)
	}
}

// Friendly fire ON: союзник получает урон и может быть убит.
func TestFriendlyFire(t *testing.T) {
	w, shooter, victim, clock := combatWorld(t)
	if shooter.team != victim.team {
		t.Fatalf("setup: same team expected")
	}
	victim.pos = vec3{0, aimLevelY, 10}

	w.fire(shooter, 0, 0) // 80 урона
	if victim.hp != 45 || !victim.alive {
		t.Fatalf("after first shot: hp=%d alive=%v", victim.hp, victim.alive)
	}
	*clock = clock.Add(2 * time.Second)
	w.fire(shooter, 0, 0) // добил
	if victim.alive || victim.hp != 0 {
		t.Fatalf("teammate must die: hp=%d alive=%v", victim.hp, victim.alive)
	}
	foundDeath, foundShot := false, false
	for _, om := range w.takeOut() {
		if om.msg["t"] == "death" && om.to == victim.id {
			foundDeath = true
			if om.msg["by"] != shooter.id {
				t.Fatalf("death.by = %v", om.msg["by"])
			}
		}
		if om.msg["t"] == "shot" && om.msg["hit"] == victim.id {
			foundShot = true
		}
	}
	if !foundDeath || !foundShot {
		t.Fatalf("want death to victim and broadcast shot, death=%v shot=%v", foundDeath, foundShot)
	}
	if w.scores != [2]int{1, 0} {
		t.Fatalf("killer team score = %v, want [1 0]", w.scores)
	}
}

// Рейт-лимит огня: темп валидируется по оружию (снайпер 1 выстрел / 1.2 с).
func TestFireRateLimit(t *testing.T) {
	w, shooter, victim, clock := combatWorld(t)
	victim.pos = vec3{0, aimLevelY, 10}

	// Первый выстрел — принят.
	w.handleFire(shooter, message{"t": "fire", "yaw": 0.0, "pitch": 0.0})
	if hp := victim.hp; hp != 45 {
		t.Fatalf("first shot must land, hp=%d", hp)
	}

	// Слишком рано (интервал 1.2 с, допуск 15 мс) — отброшен.
	*clock = clock.Add(1100 * time.Millisecond)
	w.handleFire(shooter, message{"t": "fire", "yaw": 0.0, "pitch": 0.0})
	if victim.hp != 45 {
		t.Fatalf("shot inside weapon cooldown must be rejected, hp=%d", victim.hp)
	}

	// По истечении интервала — принят.
	*clock = clock.Add(120 * time.Millisecond) // итого 1.22 с
	w.handleFire(shooter, message{"t": "fire", "yaw": 0.0, "pitch": 0.0})
	if victim.alive {
		t.Fatalf("second sniper shot must kill (125-80-80<0), hp=%d", victim.hp)
	}
	w.takeOut()

	// Мёртвый не стреляет: убиваем самого стрелка.
	shooter.hp = 1
	w.damage(victim, shooter)
	if shooter.alive {
		t.Fatalf("setup: shooter must be dead")
	}
	*clock = clock.Add(2 * time.Second)
	w.handleFire(shooter, message{"t": "fire", "yaw": 0.0, "pitch": 0.0})
	if n := len(shots(w)); n != 0 {
		t.Fatalf("dead player must not fire, got %d shots", n)
	}

	// Бёрст в один момент времени: принят только первый.
	reviver := w.addPlayer(3, "r", "sniper")
	reviver.pos = vec3{0, 1, 5}
	w.takeOut()
	for i := 0; i < 5; i++ {
		w.handleFire(reviver, message{"t": "fire", "yaw": 0.0, "pitch": 0.0})
	}
	if n := len(shots(w)); n != 1 {
		t.Fatalf("burst of 5 fires at one instant: want 1 accepted, got %d", n)
	}
}

// Ближайшая цель вдоль луча: два врага в конусе, засчитывается ближний.
func TestNearestTargetAlongRay(t *testing.T) {
	w, shooter, _, _ := combatWorld(t)
	near := w.addPlayer(3, "near", "assault")
	far := w.addPlayer(4, "far", "assault")
	w.takeOut()
	near.pos = vec3{0, aimLevelY, 8}
	far.pos = vec3{0, aimLevelY, 20}

	w.fire(shooter, 0, 0)
	s := shots(w)
	if len(s) != 1 || s[0]["hit"] != near.id {
		t.Fatalf("nearest target must be hit, got %+v", s)
	}
	if far.hp != 125 {
		t.Fatalf("far target must be untouched, hp=%d", far.hp)
	}
}
