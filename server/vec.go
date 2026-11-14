package main

import "math"

// vec3 — точка/вектор в мире; y — вверх. Позиция игрока — точка у ног.
type vec3 [3]float64

func (a vec3) add(b vec3) vec3       { return vec3{a[0] + b[0], a[1] + b[1], a[2] + b[2]} }
func (a vec3) sub(b vec3) vec3       { return vec3{a[0] - b[0], a[1] - b[1], a[2] - b[2]} }
func (a vec3) scaled(s float64) vec3 { return vec3{a[0] * s, a[1] * s, a[2] * s} }
func (a vec3) dot(b vec3) float64    { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }
func (a vec3) length() float64       { return math.Sqrt(a.dot(a)) }

// norm — единичный вектор; нулевой вектор остаётся нулевым.
func (a vec3) norm() vec3 {
	l := a.length()
	if l < 1e-9 {
		return vec3{}
	}
	return a.scaled(1 / l)
}

// round2 — координаты в снапшотах с точностью до сантиметра (меньше трафика).
func (a vec3) round2() vec3 {
	r := func(v float64) float64 { return math.Round(v*100) / 100 }
	return vec3{r(a[0]), r(a[1]), r(a[2])}
}
