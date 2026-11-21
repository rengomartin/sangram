package game

import (
	"math"
	"testing"
	"time"
)

func testConfig() Config {
	cfg := DefaultConfig()
	cfg.Countdown = time.Second
	cfg.DisconnectGrace = time.Second
	cfg.InputTimeout = time.Hour
	return cfg
}

func setMove(m *Match, slot int, seq uint64, mx, my float64) {
	m.SetInput(slot, Input{Seq: seq, MX: mx, MY: my})
}

func advance(m *Match, ticks int) {
	for i := 0; i < ticks; i++ {
		m.Step()
	}
}

func snapshotPlayer(t *testing.T, m *Match, slot int) FighterSnapshot {
	t.Helper()
	for _, p := range m.Snapshot().Fighters {
		if p.Slot == slot {
			return p
		}
	}
	t.Fatalf("slot %d missing", slot)
	return FighterSnapshot{}
}

func TestMovementIsNormalizedAndClamped(t *testing.T) {
	cfg := testConfig()
	m := NewMatch(cfg, [2]string{"knight", "knight"})
	startX, startY := m.fighters[0].X, m.fighters[0].Y
	setMove(m, 0, 1, 1, 1)
	m.Step()
	dx := m.fighters[0].X - startX
	dy := m.fighters[0].Y - startY
	dist := math.Hypot(dx, dy)
	expected := cfg.BaseSpeed / float64(cfg.TickRate)
	if math.Abs(dist-expected) > 0.001 {
		t.Fatalf("diagonal speed = %.4f, want %.4f", dist, expected)
	}
	if math.Abs(m.fighters[0].Facing-math.Pi/4) > 0.001 {
		t.Fatalf("facing = %.4f, want pi/4", m.fighters[0].Facing)
	}
	setMove(m, 0, 2, -1, -1)
	advance(m, 2000)
	p := snapshotPlayer(t, m, 0)
	if p.X < cfg.PlayerRadius-0.01 || p.Y < cfg.PlayerRadius-0.01 {
		t.Fatalf("fighter escaped arena: %+v", p)
	}
	if p.X != cfg.PlayerRadius || p.Y != cfg.PlayerRadius {
		t.Fatalf("expected corner clamp, got %+v", p)
	}
}

func TestFacingRetainedWhenIdle(t *testing.T) {
	cfg := testConfig()
	m := NewMatch(cfg, [2]string{"knight", "knight"})
	setMove(m, 0, 1, 0, 1)
	m.Step()
	facing := m.fighters[0].Facing
	setMove(m, 0, 2, 0, 0)
	advance(m, 30)
	if math.Abs(m.fighters[0].Facing-facing) > 0.0001 {
		t.Fatalf("facing changed while idle: %.3f -> %.3f", facing, m.fighters[0].Facing)
	}
}

func TestAttackDealsDamageOnceAndRespectsCooldown(t *testing.T) {
	cfg := testConfig()
	m := NewMatch(cfg, [2]string{"knight", "knight"})
	m.fighters[0].X, m.fighters[0].Y = 500, 550
	m.fighters[0].Facing = 0
	m.fighters[1].X, m.fighters[1].Y = 575, 550
	m.fighters[1].Facing = math.Pi
	m.SetInput(0, Input{Seq: 1, AttackSeq: 1})
	advance(m, 8)
	if hp := m.fighters[1].Health; hp != 85 {
		t.Fatalf("health after one hit = %.1f, want 85", hp)
	}
	// Attack again while the 500ms cooldown is still running.
	m.SetInput(0, Input{Seq: 2, AttackSeq: 2})
	advance(m, 12)
	if hp := m.fighters[1].Health; hp != 85 {
		t.Fatalf("cooldown failed: health = %.1f", hp)
	}
	// Wait for the cooldown, then land a second hit.
	advance(m, 25)
	m.fighters[0].X, m.fighters[0].Y = 500, 550
	m.fighters[1].X, m.fighters[1].Y = 575, 550
	m.fighters[0].Facing = 0
	m.SetInput(0, Input{Seq: 3, AttackSeq: 3})
	advance(m, 40)
	if hp := m.fighters[1].Health; hp != 70 {
		t.Fatalf("second hit health = %.1f, want 70", hp)
	}
}

func TestAttackArcRejectsTargetBehind(t *testing.T) {
	cfg := testConfig()
	m := NewMatch(cfg, [2]string{"knight", "knight"})
	m.fighters[0].X, m.fighters[0].Y = 500, 550
	m.fighters[0].Facing = 0
	m.fighters[1].X, m.fighters[1].Y = 425, 550
	m.SetInput(0, Input{Seq: 1, AttackSeq: 1})
	advance(m, 40)
	if m.fighters[1].Health != 100 {
		t.Fatalf("target behind was hit")
	}
}

func TestDirectionalBlock(t *testing.T) {
	cfg := testConfig()
	m := NewMatch(cfg, [2]string{"knight", "knight"})
	m.fighters[0].X, m.fighters[0].Y = 500, 550
	m.fighters[0].Facing = 0
	m.fighters[1].X, m.fighters[1].Y = 580, 550
	m.fighters[1].Facing = math.Pi
	m.SetInput(1, Input{Seq: 1, Block: true})
	m.SetInput(0, Input{Seq: 1, AttackSeq: 1})
	advance(m, 40)
	if m.fighters[1].Health != 100 {
		t.Fatalf("frontal block failed: hp=%.1f", m.fighters[1].Health)
	}
	found := false
	for _, e := range m.DrainEvents() {
		if e.Kind == "block" {
			found = true
		}
	}
	if !found {
		t.Fatal("block event missing")
	}

	// Same attack, but the defender faces away.
	m2 := NewMatch(cfg, [2]string{"knight", "knight"})
	m2.fighters[0].X, m2.fighters[0].Y = 500, 550
	m2.fighters[0].Facing = 0
	m2.fighters[1].X, m2.fighters[1].Y = 580, 550
	m2.fighters[1].Facing = 0
	m2.SetInput(1, Input{Seq: 1, Block: true})
	m2.SetInput(0, Input{Seq: 1, AttackSeq: 1})
	advance(m2, 40)
	if m2.fighters[1].Health != 85 {
		t.Fatalf("back block should fail, hp=%.1f", m2.fighters[1].Health)
	}
}

func TestDodgeInvulnerabilityAndCooldown(t *testing.T) {
	cfg := testConfig()
	m := NewMatch(cfg, [2]string{"knight", "knight"})
	m.fighters[0].X, m.fighters[0].Y = 500, 550
	m.fighters[0].Facing = 0
	m.fighters[1].X, m.fighters[1].Y = 575, 550
	m.fighters[1].Facing = math.Pi
	m.SetInput(1, Input{Seq: 1, DodgeSeq: 1, MX: -1, MY: 0})
	m.SetInput(0, Input{Seq: 1, AttackSeq: 1})
	// Inside the i-frame window the hit window is open but damage is avoided.
	advance(m, 8)
	if m.fighters[1].Health != 100 {
		t.Fatalf("dodge i-frames failed: hp=%.1f", m.fighters[1].Health)
	}
	if !m.fighters[1].dodging() {
		t.Fatal("dodge ended too early")
	}
	if m.fighters[1].DodgeCooldown <= 0 {
		t.Fatal("dodge cooldown not applied")
	}
	// Another dodge request during cooldown is consumed without a dash.
	advance(m, 20)
	m.SetInput(1, Input{Seq: 2, DodgeSeq: 2})
	advance(m, 1)
	if m.fighters[1].dodging() {
		t.Fatal("dodge started during cooldown")
	}
}

func TestBlockPreventsDodgeAndAttack(t *testing.T) {
	cfg := testConfig()
	m := NewMatch(cfg, [2]string{"knight", "knight"})
	m.SetInput(0, Input{Seq: 1, Block: true, DodgeSeq: 1, AttackSeq: 1})
	advance(m, 2)
	if m.fighters[0].dodging() || m.fighters[0].attacking() {
		t.Fatal("actions started while blocking")
	}
	if !m.fighters[0].Blocking {
		t.Fatal("block should be active")
	}
}

func TestMatchEndsAtZeroHealth(t *testing.T) {
	cfg := testConfig()
	m := NewMatch(cfg, [2]string{"berserker", "berserker"})
	m.fighters[1].Health = 10
	m.fighters[0].X, m.fighters[0].Y = 500, 550
	m.fighters[0].Facing = 0
	m.fighters[1].X, m.fighters[1].Y = 570, 550
	m.SetInput(0, Input{Seq: 1, AttackSeq: 1})
	advance(m, 40)
	if !m.Finished() || m.Winner() != 0 {
		t.Fatalf("match should end with slot 0 winner, finished=%v winner=%d", m.Finished(), m.Winner())
	}
	if m.fighters[1].Health != 0 {
		t.Fatalf("health should clamp to 0, got %.1f", m.fighters[1].Health)
	}
}

func TestCharacterConfigIsApplied(t *testing.T) {
	cfg := testConfig()
	m := NewMatch(cfg, [2]string{"duelist", "guardian"})
	if m.fighters[0].Character.SpeedMultiplier != 1.2 {
		t.Fatalf("duelist speed not applied")
	}
	if m.fighters[1].Character.Range != 124 {
		t.Fatalf("guardian range not applied")
	}
}
