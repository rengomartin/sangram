package room

import (
	"crypto/subtle"
	"sync"
	"time"

	"arena/internal/game"
)

type Room struct {
	mu  sync.Mutex
	cfg game.Config

	code    string
	now     func() time.Time
	phase   string
	players [2]*Player
	match   *game.Match

	countdownEnd time.Time
	winner       int
	endReason    string
	paused       bool

	tickCount uint64
	closed    bool
	stop      chan struct{}
	stopOnce  sync.Once
}

func newRoom(cfg game.Config, code string, now func() time.Time) *Room {
	if now == nil {
		now = time.Now
	}
	return &Room{
		cfg: cfg, code: code, now: now, phase: PhaseLobby,
		winner: -1, stop: make(chan struct{}),
	}
}

func (r *Room) Code() string { return r.code }

func (r *Room) Config() game.Config { return r.cfg }

func (r *Room) Closed() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.closed
}

func (r *Room) playerByIDLocked(id string) *Player {
	for _, p := range r.players {
		if p != nil && p.ID == id {
			return p
		}
	}
	return nil
}

func (r *Room) otherPlayerLocked(p *Player) *Player {
	return r.players[1-p.Slot]
}

func (r *Room) bothPresentLocked() bool {
	return r.players[0] != nil && r.players[1] != nil
}

func (r *Room) bothConnectedLocked() bool {
	return r.bothPresentLocked() && r.players[0].Connected && r.players[1].Connected
}

func (r *Room) authorizeLocked(playerID, connID string) (*Player, error) {
	p := r.playerByIDLocked(playerID)
	if p == nil || !p.Connected || p.Peer == nil || p.ConnID == "" ||
		p.ConnID != connID || p.Peer.ID() != connID {
		return nil, roomErr("not_member", "Your arena session is no longer active.")
	}
	p.LastSeen = r.now()
	return p, nil
}

// AddPlayer reserves a free slot in the lobby. It deliberately does not
// broadcast; the session layer sends the credential-bearing welcome first.
func (r *Room) AddPlayer(nickname string, peer Peer) (*Player, error) {
	nick, err := CleanNickname(nickname)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, roomErr("room_closed", "That arena has closed.")
	}
	if r.phase != PhaseLobby {
		return nil, roomErr("match_in_progress", "That arena is already in a match.")
	}
	slot := -1
	for i, p := range r.players {
		if p == nil {
			slot = i
			break
		}
	}
	if slot < 0 {
		return nil, roomErr("room_full", "That arena already has two warriors.")
	}
	now := r.now()
	p := &Player{
		ID: newPlayerID(), Token: newToken(), Nickname: nick, Slot: slot,
		Peer: peer, ConnID: peer.ID(), Connected: true, LastSeen: now,
	}
	r.players[slot] = p
	// A new challenger changes the readiness equation.
	for _, q := range r.players {
		if q != nil {
			q.Ready = false
		}
	}
	return p, nil
}

// Reconnect attaches a fresh socket using the secret issued at join time.
func (r *Room) Reconnect(token string, peer Peer) (*Player, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, roomErr("room_closed", "That arena has closed.")
	}
	var p *Player
	for _, candidate := range r.players {
		if candidate == nil || len(candidate.Token) != len(token) {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(candidate.Token), []byte(token)) == 1 {
			p = candidate
			break
		}
	}
	if p == nil {
		return nil, roomErr("bad_resume", "This arena seat has expired. Create or join a new room.")
	}
	oldPeer := p.Peer
	p.Peer = peer
	p.ConnID = peer.ID()
	p.Connected = true
	p.DisconnectAt = time.Time{}
	p.LastSeen = r.now()
	if r.match != nil {
		r.match.ResetInputTracking(p.Slot)
	}
	r.paused = r.phase == PhasePlaying && !r.bothConnectedLocked()
	if oldPeer != nil && oldPeer.ID() != peer.ID() {
		go oldPeer.Close()
	}
	return p, nil
}

func (r *Room) Touch(playerID, connID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, err := r.authorizeLocked(playerID, connID); err == nil {
		// authorize already updates LastSeen.
	}
}

func (r *Room) SelectCharacter(playerID, connID, character string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, err := r.authorizeLocked(playerID, connID)
	if err != nil {
		return err
	}
	if r.phase != PhaseLobby {
		return roomErr("not_lobby", "Character choices are locked once the countdown begins.")
	}
	if _, ok := r.cfg.Characters[character]; !ok {
		return roomErr("invalid_character", "Unknown warrior.")
	}
	p.Character = character
	p.Confirmed = false
	p.Ready = false
	p.Rematch = false
	r.broadcastRoomLocked()
	return nil
}

func (r *Room) ConfirmCharacter(playerID, connID string, confirmed bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, err := r.authorizeLocked(playerID, connID)
	if err != nil {
		return err
	}
	if r.phase != PhaseLobby {
		return roomErr("not_lobby", "Character choices are locked once the countdown begins.")
	}
	if confirmed && p.Character == "" {
		return roomErr("choose_character", "Select a warrior before confirming.")
	}
	p.Confirmed = confirmed
	if !confirmed {
		p.Ready = false
	}
	r.broadcastRoomLocked()
	return nil
}

func (r *Room) SetReady(playerID, connID string, ready bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, err := r.authorizeLocked(playerID, connID)
	if err != nil {
		return err
	}
	if !ready {
		if r.phase == PhaseCountdown {
			r.cancelCountdownLocked("Countdown cancelled — a warrior stood down.", "warning")
			return nil
		}
		if r.phase != PhaseLobby {
			return roomErr("not_lobby", "Readiness is only changed in the lobby.")
		}
		p.Ready = false
		r.broadcastRoomLocked()
		return nil
	}
	if r.phase != PhaseLobby {
		return nil
	}
	if p.Character == "" || !p.Confirmed {
		return roomErr("confirm_first", "Choose and confirm your warrior before readying up.")
	}
	if !r.bothConnectedLocked() {
		return roomErr("opponent_missing", "Waiting for a second warrior.")
	}
	p.Ready = true
	r.broadcastRoomLocked()
	r.maybeStartCountdownLocked()
	return nil
}

func (r *Room) SubmitInput(playerID, connID string, in game.Input) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, err := r.authorizeLocked(playerID, connID)
	if err != nil {
		return
	}
	if r.phase != PhasePlaying || r.match == nil {
		return
	}
	r.match.SetInput(p.Slot, in)
}

func (r *Room) Rematch(playerID, connID string, accept bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, err := r.authorizeLocked(playerID, connID)
	if err != nil {
		return err
	}
	if r.phase != PhaseEnded {
		return roomErr("not_ended", "The duel is not over.")
	}
	if !accept {
		r.returnToLobbyLocked("The rematch was declined.", "info")
		return nil
	}
	other := r.otherPlayerLocked(p)
	if other == nil || !other.Connected {
		return roomErr("opponent_missing", "Your opponent is no longer connected.")
	}
	p.Rematch = true
	if r.bothPresentLocked() && r.players[0].Rematch && r.players[1].Rematch {
		r.startCountdownLocked()
		return nil
	}
	r.broadcastRoomLocked()
	r.broadcastStateLocked(r.now(), false)
	return nil
}

func (r *Room) ReturnToLobby(playerID, connID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, err := r.authorizeLocked(playerID, connID); err != nil {
		return err
	}
	if r.phase != PhaseEnded {
		return roomErr("not_ended", "The duel is not over.")
	}
	r.returnToLobbyLocked("", "")
	return nil
}

// Leave is an explicit departure, distinct from a network interruption.
func (r *Room) Leave(playerID, connID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	p, err := r.authorizeLocked(playerID, connID)
	if err != nil {
		return err
	}
	other := r.otherPlayerLocked(p)
	wasPlaying := r.phase == PhasePlaying
	r.players[p.Slot] = nil
	p.Connected = false
	p.Peer = nil

	if r.players[0] == nil && r.players[1] == nil {
		r.closeLocked()
		return nil
	}
	// Explicit departures reset the room so a remaining warrior can wait for
	// a new challenger. A duel in progress is awarded immediately.
	if wasPlaying && other != nil && other.Connected {
		r.phase = PhaseEnded
		r.winner = other.Slot
		r.endReason = "opponent_left"
		r.paused = false
		other.Ready = false
		other.Rematch = false
		r.broadcastRoomLocked()
		r.broadcastStateLocked(r.now(), true)
		r.notifyLocked(other, "warning", "Your opponent left the arena.")
		return nil
	}
	if r.phase == PhaseCountdown {
		r.phase = PhaseLobby
		r.match = nil
		r.countdownEnd = time.Time{}
	}
	if r.phase == PhaseEnded {
		r.phase = PhaseLobby
		r.match = nil
		r.winner = -1
		r.endReason = ""
	}
	for _, q := range r.players {
		if q != nil {
			q.Ready = false
			q.Rematch = false
		}
	}
	r.paused = false
	if other != nil {
		r.notifyLocked(other, "info", "Your opponent left the arena. The room is open again.")
	}
	r.broadcastRoomLocked()
	return nil
}

func (r *Room) Disconnect(playerID, connID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.playerByIDLocked(playerID)
	if p == nil || p.ConnID != connID || !p.Connected {
		return
	}
	r.markDisconnectedLocked(p, false)
}

func (r *Room) markDisconnectedLocked(p *Player, closeSocket bool) {
	if !p.Connected {
		return
	}
	oldPeer := p.Peer
	p.Connected = false
	p.Peer = nil
	p.ConnID = ""
	p.DisconnectAt = r.now()
	p.LastSeen = r.now()
	p.Ready = false
	p.Rematch = false

	if r.phase == PhaseCountdown {
		r.cancelCountdownLocked(p.Nickname+" lost connection — countdown cancelled.", "warning")
	}
	if r.phase == PhasePlaying {
		r.paused = true
	}
	other := r.otherPlayerLocked(p)
	if other != nil && other.Connected {
		r.notifyLocked(other, "warning", "Opponent connection lost. Waiting for them to reconnect…")
	}
	r.broadcastRoomLocked()
	if r.match != nil && (r.phase == PhasePlaying || r.phase == PhaseEnded) {
		r.broadcastStateLocked(r.now(), false)
	}
	if closeSocket && oldPeer != nil {
		go oldPeer.Close()
	}
}

// BroadcastRoom is called after the welcome for a new or returning player.
func (r *Room) BroadcastRoom() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.broadcastRoomLocked()
}

// SendStateTo sends an immediate, non-draining state (used on reconnect so a
// returning player catches up without consuming effects meant for everyone).
func (r *Room) SendStateTo(playerID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p := r.playerByIDLocked(playerID)
	if p == nil || !p.Connected || p.Peer == nil || r.match == nil {
		return
	}
	now := r.now()
	snap := r.match.Snapshot()
	if r.winner >= 0 && r.phase == PhaseEnded {
		snap.Winner = r.winner
		snap.Finished = true
	}
	r.sendStateLocked(p, now, &snap, nil)
}

func (r *Room) maybeStartCountdownLocked() {
	if r.phase != PhaseLobby || !r.bothConnectedLocked() {
		return
	}
	for _, p := range r.players {
		if p == nil || !p.Connected || p.Character == "" || !p.Confirmed || !p.Ready {
			return
		}
	}
	r.startCountdownLocked()
}

func (r *Room) startCountdownLocked() {
	if !r.bothConnectedLocked() {
		return
	}
	chars := [2]string{r.players[0].Character, r.players[1].Character}
	r.match = game.NewMatch(r.cfg, chars)
	r.phase = PhaseCountdown
	r.countdownEnd = r.now().Add(r.cfg.Countdown)
	r.winner = -1
	r.endReason = ""
	r.paused = false
	for _, p := range r.players {
		p.Ready = true
		p.Rematch = false
	}
	r.broadcastRoomLocked()
	r.broadcastStateLocked(r.now(), false)
}

func (r *Room) cancelCountdownLocked(message, kind string) {
	if r.phase != PhaseCountdown {
		return
	}
	r.phase = PhaseLobby
	r.match = nil
	r.countdownEnd = time.Time{}
	r.winner = -1
	r.paused = false
	for _, p := range r.players {
		if p != nil {
			p.Ready = false
		}
	}
	if message != "" {
		r.broadcastNoticeLocked(kind, message)
	}
	r.broadcastRoomLocked()
}

func (r *Room) returnToLobbyLocked(message, kind string) {
	if message != "" {
		r.broadcastNoticeLocked(kind, message)
	}
	r.phase = PhaseLobby
	r.match = nil
	r.countdownEnd = time.Time{}
	r.winner = -1
	r.endReason = ""
	r.paused = false
	for _, p := range r.players {
		if p != nil {
			p.Ready = false
			p.Rematch = false
		}
	}
	r.broadcastRoomLocked()
}

func (r *Room) finishMatchLocked(now time.Time) {
	r.phase = PhaseEnded
	r.winner = r.match.Winner()
	r.endReason = "knockout"
	r.paused = false
	for _, p := range r.players {
		if p != nil {
			p.Ready = false
			p.Rematch = false
		}
	}
	r.broadcastRoomLocked()
	r.broadcastStateLocked(now, true)
}

func (r *Room) run() {
	interval := time.Second / time.Duration(r.cfg.TickRate)
	if interval < time.Millisecond {
		interval = time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-r.stop:
			return
		case now := <-ticker.C:
			r.mu.Lock()
			if r.closed {
				r.mu.Unlock()
				return
			}
			r.tickLocked(now)
			r.mu.Unlock()
		}
	}
}

func (r *Room) tickLocked(now time.Time) {
	// Application-level heartbeats cover silent network failure, not just
	// orderly socket closes. Brief hiccups below the timeout are tolerated.
	timeout := r.cfg.HeartbeatTimeout
	if timeout > 0 {
		for _, p := range r.players {
			if p != nil && p.Connected && now.Sub(p.LastSeen) > timeout {
				r.markDisconnectedLocked(p, true)
				if r.closed {
					return
				}
			}
		}
	}
	r.expireDisconnectsLocked(now)
	if r.closed {
		return
	}

	r.tickCount++
	every := r.cfg.TickRate / r.cfg.SnapshotRate
	if every < 1 {
		every = 1
	}
	stateDue := r.tickCount%uint64(every) == 0

	switch r.phase {
	case PhaseCountdown:
		for _, p := range r.players {
			if p == nil || !p.Connected || !p.Ready {
				r.cancelCountdownLocked("Countdown cancelled.", "warning")
				return
			}
		}
		if !now.Before(r.countdownEnd) {
			r.phase = PhasePlaying
			r.paused = false
			r.broadcastRoomLocked()
			r.broadcastStateLocked(now, true)
			return
		}
		if stateDue {
			r.broadcastStateLocked(now, false)
		}
	case PhasePlaying:
		r.paused = !r.bothConnectedLocked()
		if r.paused {
			if stateDue {
				r.broadcastStateLocked(now, false)
			}
			return
		}
		r.match.Step()
		if r.match.Finished() {
			r.finishMatchLocked(now)
			return
		}
		if stateDue {
			r.broadcastStateLocked(now, true)
		}
	case PhaseEnded:
		// State changes while ended are pushed immediately.
	}
}

func (r *Room) expireDisconnectsLocked(now time.Time) {
	for slot := 0; slot < 2; slot++ {
		p := r.players[slot]
		if p == nil || p.Connected || p.DisconnectAt.IsZero() {
			continue
		}
		if now.Before(p.DisconnectAt.Add(r.cfg.DisconnectGrace)) {
			continue
		}
		other := r.players[1-slot]
		r.players[slot] = nil
		p.Peer = nil

		if r.phase == PhasePlaying {
			if other != nil && other.Connected {
				r.phase = PhaseEnded
				r.winner = other.Slot
				r.endReason = "opponent_disconnected"
				r.paused = false
				other.Ready = false
				other.Rematch = false
				r.notifyLocked(other, "warning", "Your opponent did not reconnect. Victory is yours.")
				r.broadcastRoomLocked()
				r.broadcastStateLocked(now, true)
				return
			}
			r.closeLocked()
			return
		}

		if r.phase == PhaseCountdown {
			r.phase = PhaseLobby
			r.match = nil
			r.countdownEnd = time.Time{}
		}
		for _, q := range r.players {
			if q != nil {
				q.Ready = false
				q.Rematch = false
			}
		}
		if r.players[0] == nil && r.players[1] == nil {
			r.closeLocked()
			return
		}
		if other != nil && other.Connected {
			r.notifyLocked(other, "info", p.Nickname+" left the arena. The room is open for a new challenger.")
		}
		r.broadcastRoomLocked()
		if r.phase == PhaseEnded && r.match != nil {
			r.broadcastStateLocked(now, false)
		}
	}
}

func (r *Room) closeLocked() {
	if r.closed {
		return
	}
	r.closed = true
	r.stopOnce.Do(func() { close(r.stop) })
	for _, p := range r.players {
		if p == nil {
			continue
		}
		if p.Peer != nil {
			peer := p.Peer
			go peer.Close()
		}
		p.Peer = nil
		p.Connected = false
	}
}

func (r *Room) broadcastRoomLocked() {
	for _, p := range r.players {
		if p == nil || !p.Connected || p.Peer == nil {
			continue
		}
		p.Peer.SendJSON(&roomMessage{Type: "room", Room: r.roomViewLocked(p)})
	}
}

func (r *Room) broadcastStateLocked(now time.Time, drain bool) {
	if r.match == nil {
		return
	}
	var events []game.Event
	if drain {
		events = r.match.DrainEvents()
	}
	snap := r.match.Snapshot()
	if r.winner >= 0 && r.phase == PhaseEnded {
		snap.Winner = r.winner
		snap.Finished = true
	}
	for _, p := range r.players {
		if p == nil || !p.Connected || p.Peer == nil {
			continue
		}
		r.sendStateLocked(p, now, &snap, events)
	}
}

func (r *Room) stateViewLocked(p *Player, now time.Time, snap *game.Snapshot, events []game.Event) *StateView {
	return &StateView{
		Phase: r.phase, YourSlot: p.Slot, ServerTime: now.UnixMilli(),
		CountdownMs: r.countdownRemainingMs(now),
		Paused:      r.phase == PhasePlaying && r.paused,
		GraceMs:     r.graceRemainingMs(now),
		Winner:      r.winner, EndReason: r.endReason,
		Players: r.playerViewsLocked(), Match: snap, Events: events,
	}
}

func (r *Room) sendStateLocked(p *Player, now time.Time, snap *game.Snapshot, events []game.Event) {
	if p.Peer == nil {
		return
	}
	p.Peer.SendJSON(&stateMessage{Type: "state", State: r.stateViewLocked(p, now, snap, events)})
}

func (r *Room) notifyLocked(p *Player, kind, message string) {
	if p == nil || !p.Connected || p.Peer == nil {
		return
	}
	p.Peer.SendJSON(&noticeMessage{Type: "notice", Kind: kind, Message: message})
}

func (r *Room) broadcastNoticeLocked(kind, message string) {
	for _, p := range r.players {
		r.notifyLocked(p, kind, message)
	}
}
