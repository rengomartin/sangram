package game

import (
	"math"
	"sort"
)

// Input is one sequenced client input frame. AttackSeq and DodgeSeq are
// edge-trigger counters, so a lost packet cannot silently repeat an attack.
type Input struct {
	Seq       uint64  `json:"seq"`
	MX        float64 `json:"mx"`
	MY        float64 `json:"my"`
	Block     bool    `json:"block"`
	AttackSeq uint64  `json:"attackSeq"`
	DodgeSeq  uint64  `json:"dodgeSeq"`
}

type Fighter struct {
	Slot      int
	Character Character

	X, Y   float64
	Facing float64
	Health float64

	Input        Input
	lastSeq      uint64
	lastAttack   uint64
	lastDodge    uint64
	pendingAtk   bool
	pendingDodge bool
	lastInputAt  uint64

	AttackElapsed  float64
	AttackAngle    float64
	AttackHit      bool
	AttackCooldown float64

	DodgeElapsed  float64
	DodgeAngle    float64
	DodgeCooldown float64

	Blocking bool
	HitStun  float64
	KnockVX  float64
	KnockVY  float64
}

func (f *Fighter) attacking() bool { return f.AttackElapsed >= 0 }
func (f *Fighter) dodging() bool   { return f.DodgeElapsed >= 0 }

func (f *Fighter) invulnerable(cfg Config) bool {
	return f.dodging() && f.DodgeElapsed < cfg.dodgeInvulnerable()
}

// Event is emitted for client visuals and audio. It is informational only;
// clients must never derive health from it.
type Event struct {
	Kind   string  `json:"kind"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Slot   int     `json:"slot"`
	Target int     `json:"target"`
	Amount float64 `json:"amount,omitempty"`
	Angle  float64 `json:"angle,omitempty"`
}

// ArenaSnapshot carries dimensions that the camera and renderer need.
type ArenaSnapshot struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type FighterSnapshot struct {
	Slot           int     `json:"slot"`
	Character      string  `json:"character"`
	X              float64 `json:"x"`
	Y              float64 `json:"y"`
	Facing         float64 `json:"facing"`
	Health         float64 `json:"health"`
	MaxHealth      float64 `json:"maxHealth"`
	Blocking       bool    `json:"blocking"`
	Attacking      bool    `json:"attacking"`
	AttackProgress float64 `json:"attackProgress"`
	AttackAngle    float64 `json:"attackAngle"`
	AttackCooldown float64 `json:"attackCooldown"`
	Dashing        bool    `json:"dashing"`
	DodgeProgress  float64 `json:"dodgeProgress"`
	DodgeAngle     float64 `json:"dodgeAngle"`
	DodgeCooldown  float64 `json:"dodgeCooldown"`
	Invulnerable   bool    `json:"invulnerable"`
	Hurt           bool    `json:"hurt"`
	InputSeq       uint64  `json:"inputSeq"`
}

type Snapshot struct {
	Tick     uint64            `json:"tick"`
	Arena    ArenaSnapshot     `json:"arena"`
	Fighters []FighterSnapshot `json:"fighters"`
	Winner   int               `json:"winner"`
	Finished bool              `json:"finished"`
}

// Match is a single duel. The room layer invokes Step at a fixed tick rate.
type Match struct {
	cfg      Config
	fighters [2]*Fighter
	tick     uint64
	winner   int
	finished bool
	events   []Event
}

func NewMatch(cfg Config, characters [2]string) *Match {
	m := &Match{cfg: cfg, winner: -1}
	spawnY := cfg.ArenaHeight / 2
	specs := [2]struct {
		x      float64
		facing float64
	}{
		{cfg.SpawnInset, 0},
		{cfg.ArenaWidth - cfg.SpawnInset, math.Pi},
	}
	for i := 0; i < 2; i++ {
		ch := cfg.Character(characters[i])
		m.fighters[i] = &Fighter{
			Slot: i, Character: ch, X: specs[i].x, Y: spawnY,
			Facing: specs[i].facing, Health: ch.Health,
			AttackElapsed: -1, DodgeElapsed: -1,
		}
	}
	return m
}

// SetInput accepts the latest sequenced input for a player. Identity and room
// membership are enforced before this is called.
func (m *Match) SetInput(slot int, in Input) {
	if slot < 0 || slot > 1 || m.finished {
		return
	}
	f := m.fighters[slot]
	if in.Seq <= f.lastSeq {
		return
	}
	f.lastSeq = in.Seq
	f.lastInputAt = m.tick
	in.MX = clamp(in.MX, -1, 1)
	in.MY = clamp(in.MY, -1, 1)
	if math.IsNaN(in.MX) || math.IsNaN(in.MY) {
		in.MX, in.MY = 0, 0
	}
	if l := math.Hypot(in.MX, in.MY); l > 1 {
		in.MX /= l
		in.MY /= l
	}
	f.Input = in
	if in.AttackSeq > f.lastAttack {
		f.lastAttack = in.AttackSeq
		f.pendingAtk = true
	}
	if in.DodgeSeq > f.lastDodge {
		f.lastDodge = in.DodgeSeq
		f.pendingDodge = true
	}
}

// ResetInputTracking is used after a reconnect. The old socket is already
// detached, so accepting the new session's counters is safe.
func (m *Match) ResetInputTracking(slot int) {
	if slot < 0 || slot > 1 {
		return
	}
	f := m.fighters[slot]
	f.lastSeq = 0
	f.lastAttack = 0
	f.lastDodge = 0
	f.Input = Input{}
	f.lastInputAt = m.tick
	f.pendingAtk = false
	f.pendingDodge = false
}

// Step advances exactly one simulation tick.
func (m *Match) Step() {
	if m.finished {
		return
	}
	m.tick++
	dt := m.cfg.tickDuration()
	staleTicks := uint64(math.Ceil(m.cfg.InputTimeout.Seconds() / dt))

	for _, f := range m.fighters {
		f.AttackCooldown = math.Max(0, f.AttackCooldown-dt)
		f.DodgeCooldown = math.Max(0, f.DodgeCooldown-dt)
		f.HitStun = math.Max(0, f.HitStun-dt)
		if f.lastInputAt > 0 && m.tick-f.lastInputAt > staleTicks {
			f.Input.MX, f.Input.MY, f.Input.Block = 0, 0, false
		}

		// Face valid movement immediately, before an action can lock the angle.
		if !f.attacking() && !f.dodging() && f.HitStun <= 0 {
			if l := math.Hypot(f.Input.MX, f.Input.MY); l > 0.01 {
				f.Facing = normalizeAngle(math.Atan2(f.Input.MY, f.Input.MX))
			}
		}

		// A raised guard prevents new attacks and dodges. Actions are consumed
		// even when unavailable, so a held key cannot queue a burst.
		if f.pendingDodge {
			f.pendingDodge = false
			if !f.Input.Block && !f.attacking() && !f.dodging() &&
				f.DodgeCooldown <= 0 && f.HitStun <= 0 {
				dir := f.Facing
				if l := math.Hypot(f.Input.MX, f.Input.MY); l > 0.1 {
					dir = math.Atan2(f.Input.MY, f.Input.MX)
				}
				f.DodgeElapsed = 0
				f.DodgeAngle = normalizeAngle(dir)
				f.Facing = f.DodgeAngle
				f.DodgeCooldown = m.cfg.dodgeCooldown()
				m.events = append(m.events, Event{
					Kind: "dodge", X: f.X, Y: f.Y, Slot: f.Slot, Angle: f.DodgeAngle,
				})
			}
		}
		if f.pendingAtk {
			f.pendingAtk = false
			if !f.Input.Block && !f.attacking() && !f.dodging() &&
				f.AttackCooldown <= 0 && f.HitStun <= 0 {
				f.AttackElapsed = 0
				f.AttackAngle = f.Facing
				f.AttackHit = false
				f.AttackCooldown = m.cfg.attackCooldown(f.Character)
				m.events = append(m.events, Event{
					Kind: "swing", X: f.X, Y: f.Y, Slot: f.Slot, Angle: f.AttackAngle,
				})
			}
		}

		f.Blocking = f.Input.Block && !f.attacking() && !f.dodging() && f.HitStun <= 0
	}

	for _, f := range m.fighters {
		m.moveFighter(f, dt)
	}
	m.resolvePlayerCollision()

	for _, f := range m.fighters {
		if f.dodging() {
			f.DodgeElapsed += dt
			if f.DodgeElapsed >= m.cfg.dodgeDuration() {
				f.DodgeElapsed = -1
			}
		}
		if f.attacking() {
			f.AttackElapsed += dt
		}
	}
	m.resolveAttacks(dt)

	for _, f := range m.fighters {
		if f.attacking() && f.AttackElapsed >= m.cfg.attackDuration(f.Character) {
			f.AttackElapsed = -1
		}
		if f.Health <= 0 {
			m.finished = true
			if m.winner < 0 {
				m.winner = 1 - f.Slot
			}
		}
	}
}

func (m *Match) moveFighter(f *Fighter, dt float64) {
	if f.dodging() {
		f.X += math.Cos(f.DodgeAngle) * m.cfg.DodgeSpeed * dt
		f.Y += math.Sin(f.DodgeAngle) * m.cfg.DodgeSpeed * dt
	} else if f.HitStun <= 0 {
		speed := m.cfg.BaseSpeed * f.Character.SpeedMultiplier
		if f.Blocking {
			speed *= m.cfg.BlockMoveMultiplier
		} else if f.attacking() {
			speed *= m.cfg.AttackMoveMultiplier
		}
		f.X += f.Input.MX * speed * dt
		f.Y += f.Input.MY * speed * dt
	}
	f.X += f.KnockVX * dt
	f.Y += f.KnockVY * dt
	decay := math.Exp(-m.cfg.KnockbackDecay * dt)
	f.KnockVX *= decay
	f.KnockVY *= decay
	if math.Abs(f.KnockVX) < 1 {
		f.KnockVX = 0
	}
	if math.Abs(f.KnockVY) < 1 {
		f.KnockVY = 0
	}
	f.X = clamp(f.X, m.cfg.PlayerRadius, m.cfg.ArenaWidth-m.cfg.PlayerRadius)
	f.Y = clamp(f.Y, m.cfg.PlayerRadius, m.cfg.ArenaHeight-m.cfg.PlayerRadius)
}

func (m *Match) resolvePlayerCollision() {
	a, b := m.fighters[0], m.fighters[1]
	dx, dy := b.X-a.X, b.Y-a.Y
	dist := math.Hypot(dx, dy)
	minDist := m.cfg.PlayerRadius * 2
	if dist >= minDist {
		return
	}
	if dist < 0.001 {
		dx, dy, dist = 1, 0, 1
	}
	push := (minDist - dist) / 2
	nx, ny := dx/dist, dy/dist
	a.X -= nx * push
	a.Y -= ny * push
	b.X += nx * push
	b.Y += ny * push
	for _, f := range m.fighters {
		f.X = clamp(f.X, m.cfg.PlayerRadius, m.cfg.ArenaWidth-m.cfg.PlayerRadius)
		f.Y = clamp(f.Y, m.cfg.PlayerRadius, m.cfg.ArenaHeight-m.cfg.PlayerRadius)
	}
}

func (m *Match) resolveAttacks(dt float64) {
	for _, a := range m.fighters {
		if !a.attacking() || a.AttackHit {
			continue
		}
		dur := m.cfg.attackDuration(a.Character)
		if a.AttackElapsed < dur*m.cfg.AttackActiveStartFrac ||
			a.AttackElapsed > dur*m.cfg.AttackActiveEndFrac {
			continue
		}
		t := m.fighters[1-a.Slot]
		if t.Health <= 0 || t.invulnerable(m.cfg) {
			continue
		}
		dx, dy := t.X-a.X, t.Y-a.Y
		dist := math.Hypot(dx, dy)
		if dist > a.Character.Range+m.cfg.PlayerRadius {
			continue
		}
		toTarget := normalizeAngle(math.Atan2(dy, dx))
		if math.Abs(angleDiff(toTarget, a.AttackAngle)) > a.Character.ArcHalfDegrees*math.Pi/180 {
			continue
		}
		a.AttackHit = true
		hitX := (a.X + t.X) / 2
		hitY := (a.Y + t.Y) / 2

		toAttacker := normalizeAngle(math.Atan2(a.Y-t.Y, a.X-t.X))
		blocked := t.Blocking && math.Abs(angleDiff(toAttacker, t.Facing)) <= m.cfg.BlockArcHalfDegrees*math.Pi/180
		if blocked {
			m.events = append(m.events, Event{
				Kind: "block", X: hitX, Y: hitY, Slot: a.Slot, Target: t.Slot,
				Angle: toAttacker,
			})
			continue
		}

		t.Health = math.Max(0, t.Health-a.Character.Damage)
		t.HitStun = m.cfg.hitStun()
		t.Blocking = false
		t.AttackElapsed = -1
		t.pendingAtk = false
		if dist > 0.001 {
			t.KnockVX = dx / dist * m.cfg.KnockbackSpeed
			t.KnockVY = dy / dist * m.cfg.KnockbackSpeed
		}
		m.events = append(m.events, Event{
			Kind: "hit", X: hitX, Y: hitY, Slot: a.Slot, Target: t.Slot,
			Amount: a.Character.Damage, Angle: toTarget,
		})
		if t.Health <= 0 {
			m.finished = true
			m.winner = a.Slot
			return
		}
	}
}

// DrainEvents returns and clears pending visual/audio events.
func (m *Match) DrainEvents() []Event {
	if len(m.events) == 0 {
		return nil
	}
	out := m.events
	m.events = nil
	return out
}

func (m *Match) Snapshot() Snapshot {
	s := Snapshot{
		Tick: m.tick, Winner: m.winner, Finished: m.finished,
		Arena:    ArenaSnapshot{Width: m.cfg.ArenaWidth, Height: m.cfg.ArenaHeight},
		Fighters: make([]FighterSnapshot, 0, 2),
	}
	for _, f := range m.fighters {
		attackDuration := m.cfg.attackDuration(f.Character)
		dodgeDuration := m.cfg.dodgeDuration()
		ap, dp := 0.0, 0.0
		if f.attacking() && attackDuration > 0 {
			ap = clamp(f.AttackElapsed/attackDuration, 0, 1)
		}
		if f.dodging() && dodgeDuration > 0 {
			dp = clamp(f.DodgeElapsed/dodgeDuration, 0, 1)
		}
		s.Fighters = append(s.Fighters, FighterSnapshot{
			Slot: f.Slot, Character: f.Character.Key,
			X: round3(f.X), Y: round3(f.Y), Facing: round4(f.Facing),
			Health: round3(f.Health), MaxHealth: f.Character.Health,
			Blocking:  f.Blocking,
			Attacking: f.attacking(), AttackProgress: round3(ap),
			AttackAngle:    round4(f.AttackAngle),
			AttackCooldown: round3(f.AttackCooldown),
			Dashing:        f.dodging(), DodgeProgress: round3(dp),
			DodgeAngle:    round4(f.DodgeAngle),
			DodgeCooldown: round3(f.DodgeCooldown),
			Invulnerable:  f.invulnerable(m.cfg),
			Hurt:          f.HitStun > 0,
			InputSeq:      f.lastSeq,
		})
	}
	sort.Slice(s.Fighters, func(i, j int) bool { return s.Fighters[i].Slot < s.Fighters[j].Slot })
	return s
}

func (m *Match) Winner() int    { return m.winner }
func (m *Match) Finished() bool { return m.finished }
func (m *Match) Tick() uint64   { return m.tick }
func (m *Match) Config() Config { return m.cfg }

func normalizeAngle(a float64) float64 {
	for a > math.Pi {
		a -= 2 * math.Pi
	}
	for a < -math.Pi {
		a += 2 * math.Pi
	}
	return a
}

func angleDiff(a, b float64) float64 { return normalizeAngle(a - b) }

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }
func round4(v float64) float64 { return math.Round(v*10000) / 10000 }

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
