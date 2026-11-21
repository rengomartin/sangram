package room

import (
	"errors"
	"sync"
	"testing"
	"time"

	"arena/internal/game"
)

type fakePeer struct {
	id     string
	mu     sync.Mutex
	msgs   []any
	closed bool
}

func (f *fakePeer) ID() string { return f.id }
func (f *fakePeer) SendJSON(v any) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return false
	}
	f.msgs = append(f.msgs, v)
	return true
}
func (f *fakePeer) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
}
func (f *fakePeer) last() any {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.msgs) == 0 {
		return nil
	}
	return f.msgs[len(f.msgs)-1]
}
func (f *fakePeer) state() *StateView {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.msgs) - 1; i >= 0; i-- {
		if msg, ok := f.msgs[i].(*stateMessage); ok {
			return msg.State
		}
	}
	return nil
}
func (f *fakePeer) view() *RoomView {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.msgs) - 1; i >= 0; i-- {
		if msg, ok := f.msgs[i].(*roomMessage); ok {
			return msg.Room
		}
	}
	return nil
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}
func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newTestRoom(t *testing.T) (*Room, *fakeClock, *Player, *fakePeer, *Player, *fakePeer) {
	t.Helper()
	cfg := game.DefaultConfig()
	cfg.InputTimeout = time.Hour
	clock := &fakeClock{t: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
	r := newRoom(cfg, "ABC234", clock.Now)
	peer1 := &fakePeer{id: "conn-one"}
	peer2 := &fakePeer{id: "conn-two"}
	p1, err := r.AddPlayer("Aldric", peer1)
	if err != nil {
		t.Fatal(err)
	}
	p2, err := r.AddPlayer("Bryn", peer2)
	if err != nil {
		t.Fatal(err)
	}
	return r, clock, p1, peer1, p2, peer2
}

func selectAndReady(t *testing.T, r *Room, p *Player, peer *fakePeer, character string) {
	t.Helper()
	if err := r.SelectCharacter(p.ID, peer.ID(), character); err != nil {
		t.Fatal(err)
	}
	if err := r.ConfirmCharacter(p.ID, peer.ID(), true); err != nil {
		t.Fatal(err)
	}
	if err := r.SetReady(p.ID, peer.ID(), true); err != nil {
		t.Fatal(err)
	}
}

func beginMatch(t *testing.T, r *Room, clock *fakeClock, p1 *Player, peer1 *fakePeer, p2 *Player, peer2 *fakePeer) {
	t.Helper()
	selectAndReady(t, r, p1, peer1, "knight")
	selectAndReady(t, r, p2, peer2, "guardian")
	if r.phase != PhaseCountdown {
		t.Fatalf("phase = %s, want countdown", r.phase)
	}
	clock.Advance(r.cfg.Countdown + 10*time.Millisecond)
	r.tickLocked(clock.Now())
	if r.phase != PhasePlaying {
		t.Fatalf("phase = %s, want playing", r.phase)
	}
}

func TestLobbyReadyCountdownAndPlaying(t *testing.T) {
	r, clock, p1, peer1, p2, peer2 := newTestRoom(t)
	selectAndReady(t, r, p1, peer1, "knight")
	selectAndReady(t, r, p2, peer2, "duelist")
	if r.phase != PhaseCountdown || r.match == nil {
		t.Fatalf("expected countdown with a fresh match, got %s", r.phase)
	}
	if ms := r.countdownRemainingMs(clock.Now()); ms < 2900 || ms > 3000 {
		t.Fatalf("countdown remaining = %d", ms)
	}
	view := peer2.view()
	if view == nil || view.Phase != PhaseCountdown || view.YourSlot != 1 {
		t.Fatalf("bad room view: %+v", view)
	}
	clock.Advance(2 * time.Second)
	r.tickLocked(clock.Now())
	if r.phase != PhaseCountdown {
		t.Fatalf("started too early: %s", r.phase)
	}
	clock.Advance(1100 * time.Millisecond)
	r.tickLocked(clock.Now())
	if r.phase != PhasePlaying {
		t.Fatalf("phase = %s, want playing", r.phase)
	}
	st := peer1.state()
	if st == nil || st.Phase != PhasePlaying || st.Match == nil {
		t.Fatalf("missing playing state: %+v", st)
	}
	if len(st.Match.Fighters) != 2 {
		t.Fatalf("expected two fighters")
	}
}

func TestInputMovesOnlyAuthoritativeSlot(t *testing.T) {
	r, clock, p1, peer1, p2, peer2 := newTestRoom(t)
	beginMatch(t, r, clock, p1, peer1, p2, peer2)
	before := peer1.state().Match.Fighters[0].X
	r.SubmitInput(p1.ID, peer1.ID(), game.Input{Seq: 1, MX: 1})
	for i := 0; i < 20; i++ {
		clock.Advance(time.Second / 60)
		r.tickLocked(clock.Now())
	}
	st := peer1.state()
	if st == nil || st.Match == nil {
		t.Fatal("no state")
	}
	if st.Match.Fighters[0].X <= before {
		t.Fatalf("player did not move: %.1f -> %.1f", before, st.Match.Fighters[0].X)
	}
	// A socket that does not own player two cannot move them.
	beforeTwo := st.Match.Fighters[1].Y
	r.SubmitInput(p2.ID, peer1.ID(), game.Input{Seq: 99, MY: 1})
	for i := 0; i < 5; i++ {
		clock.Advance(time.Second / 60)
		r.tickLocked(clock.Now())
	}
	st = peer1.state()
	if st.Match.Fighters[1].Y != beforeTwo {
		t.Fatal("unauthorised connection moved player two")
	}
}

func TestDisconnectCancelsCountdownAndReconnectRestoresLobby(t *testing.T) {
	r, _, p1, peer1, p2, peer2 := newTestRoom(t)
	selectAndReady(t, r, p1, peer1, "knight")
	selectAndReady(t, r, p2, peer2, "berserker")
	if r.phase != PhaseCountdown {
		t.Fatal("not in countdown")
	}
	r.Disconnect(p1.ID, peer1.ID())
	if r.phase != PhaseLobby || r.match != nil {
		t.Fatalf("countdown not cancelled: phase=%s matchNil=%v", r.phase, r.match == nil)
	}
	view := peer2.view()
	if view == nil || view.Players[0].Connected {
		t.Fatal("room view did not expose disconnected player")
	}
	replacement := &fakePeer{id: "conn-one-b"}
	p, err := r.Reconnect(p1.Token, replacement)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Connected || p.ConnID != replacement.ID() {
		t.Fatal("reconnect did not attach peer")
	}
	if r.phase != PhaseLobby {
		t.Fatal("reconnect should return to cancelled lobby")
	}
}

func TestCombatDisconnectGraceAndWinner(t *testing.T) {
	r, clock, p1, peer1, p2, peer2 := newTestRoom(t)
	beginMatch(t, r, clock, p1, peer1, p2, peer2)

	r.Disconnect(p1.ID, peer1.ID())
	if !r.paused || r.phase != PhasePlaying {
		t.Fatalf("match should pause during grace: paused=%v phase=%s", r.paused, r.phase)
	}
	st := peer2.state()
	if st == nil || !st.Paused || st.GraceMs <= 0 {
		t.Fatalf("expected paused state with grace, got %+v", st)
	}
	// Reconnect within grace resumes instead of awarding a win.
	replacement := &fakePeer{id: "conn-one-c"}
	if _, err := r.Reconnect(p1.Token, replacement); err != nil {
		t.Fatal(err)
	}
	if r.paused || r.phase != PhasePlaying {
		t.Fatal("reconnect did not resume match")
	}
	// Drop again and let the grace period expire. The surviving client keeps
	// heartbeating, as the browser does.
	r.Disconnect(p1.ID, replacement.ID())
	clock.Advance(r.cfg.DisconnectGrace + time.Second)
	r.Touch(p2.ID, peer2.ID())
	r.tickLocked(clock.Now())
	if r.phase != PhaseEnded {
		t.Fatalf("phase = %s, want ended", r.phase)
	}
	if r.winner != p2.Slot || r.endReason != "opponent_disconnected" {
		t.Fatalf("wrong result: winner=%d reason=%s", r.winner, r.endReason)
	}
	if _, err := r.Reconnect(p1.Token, &fakePeer{id: "late"}); err == nil {
		t.Fatal("expired seat should not reconnect")
	}
}

func TestRematchRequiresBothAndResetsMatch(t *testing.T) {
	r, clock, p1, peer1, p2, peer2 := newTestRoom(t)
	selectAndReady(t, r, p1, peer1, "knight")
	selectAndReady(t, r, p2, peer2, "berserker")
	r.mu.Lock()
	r.phase = PhaseEnded
	r.winner = 0
	r.endReason = "knockout"
	r.mu.Unlock()

	if err := r.Rematch(p1.ID, peer1.ID(), true); err != nil {
		t.Fatal(err)
	}
	if r.phase != PhaseEnded {
		t.Fatal("rematch started with one acceptance")
	}
	if err := r.Rematch(p2.ID, peer2.ID(), true); err != nil {
		t.Fatal(err)
	}
	if r.phase != PhaseCountdown || r.match == nil {
		t.Fatalf("rematch did not start countdown: %s", r.phase)
	}
	if r.winner != -1 {
		t.Fatal("winner not reset")
	}
	clock.Advance(r.cfg.Countdown + 10*time.Millisecond)
	r.tickLocked(clock.Now())
	if r.phase != PhasePlaying {
		t.Fatal("rematch did not start play")
	}
	if st := peer2.state(); st == nil || st.Match == nil || st.Match.Fighters[0].Health != 100 {
		t.Fatal("rematch did not restore health")
	}

	// A decline returns both warriors to the lobby.
	r.mu.Lock()
	r.phase = PhaseEnded
	r.winner = 1
	r.mu.Unlock()
	if err := r.Rematch(p1.ID, peer1.ID(), false); err != nil {
		t.Fatal(err)
	}
	if r.phase != PhaseLobby || r.match != nil {
		t.Fatalf("decline did not return to lobby: %s", r.phase)
	}
}

func TestManagerJoinValidation(t *testing.T) {
	cfg := game.DefaultConfig()
	m := NewManager(cfg)
	peer1 := &fakePeer{id: "m-one"}
	peer2 := &fakePeer{id: "m-two"}
	peer3 := &fakePeer{id: "m-three"}
	r, p1, err := m.Create("  Aldric  ", peer1)
	if err != nil {
		t.Fatal(err)
	}
	if p1.Nickname != "Aldric" {
		t.Fatalf("nickname = %q", p1.Nickname)
	}
	if len(r.Code()) != 6 {
		t.Fatalf("room code %q", r.Code())
	}
	if _, _, err := m.Join("NOPE", "Bryn", peer2); err == nil {
		t.Fatal("invalid code accepted")
	}
	_, p2, err := m.Join(r.Code(), "Bryn", peer2)
	if err != nil {
		t.Fatal(err)
	}
	if p2.Slot != 1 {
		t.Fatalf("slot = %d", p2.Slot)
	}
	if _, _, err := m.Join(r.Code(), "Cedric", peer3); err == nil {
		t.Fatal("third player accepted")
	} else {
		var re *Error
		if !errors.As(err, &re) || re.Code != "room_full" {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	// Resume with the correct secret, reject the wrong one.
	if _, _, err := m.Reconnect(r.Code(), "wrong", &fakePeer{id: "bad"}); err == nil {
		t.Fatal("bad token accepted")
	}
	replacement := &fakePeer{id: "m-one-b"}
	if _, _, err := m.Reconnect(r.Code(), p1.Token, replacement); err != nil {
		t.Fatal(err)
	}
}

func TestNicknameAndRoomCodeValidation(t *testing.T) {
	if _, err := CleanNickname("   "); err == nil {
		t.Fatal("empty nickname accepted")
	}
	nick, err := CleanNickname("  Sir   Robin \n of Locksley  ")
	if err != nil {
		t.Fatal(err)
	}
	if nick != "Sir Robin of Locksley" {
		t.Fatalf("nickname = %q", nick)
	}
	if _, err := NormalizeRoomCode("abc234"); err != nil {
		t.Fatalf("lowercase code rejected: %v", err)
	}
	if _, err := NormalizeRoomCode("ABC10O"); err == nil {
		t.Fatal("ambiguous invalid code accepted")
	}
}
