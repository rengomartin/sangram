package room

type roomMessage struct {
	Type string    `json:"type"`
	Room *RoomView `json:"room"`
}

type stateMessage struct {
	Type  string     `json:"type"`
	State *StateView `json:"state"`
}

type noticeMessage struct {
	Type    string `json:"type"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

type leftMessage struct {
	Type string `json:"type"`
}
