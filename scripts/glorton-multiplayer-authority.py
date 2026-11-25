"""Extend the installed Glorton authority with up to four human seats."""

from __future__ import annotations

import argparse
import asyncio
from contextvars import ContextVar
import re
import secrets
import time

from fastapi import FastAPI, WebSocket
from online import server as upstream
from online.protocol import (
    EDGE_FIELDS,
    PROTOCOL_VERSION,
    STAGES,
    TICK_MS,
    clean_name,
    controls_without_edges,
    decode_message,
    encode_message,
    normalize_controls,
    room_code,
    validate_lobby_patch,
    validate_settings_patch,
)
from online.room import RECONNECT_SECONDS, PlayerSlot, Room, RoomManager
from src.simulation import INPUT_FIELDS


MAX_PLAYERS = 4
MAX_INPUT_LEAD = 8
MAX_TICK_DEBT = 2 * TICK_MS / 1000
SNAPSHOT_FIELDS = {"match_start": "initial_snapshot", "snapshot": "snapshot", "match_end": "snapshot"}
ROUND_PACKETS = frozenset((*SNAPSHOT_FIELDS, "frame"))
BROWSER_ACTIONS = {"map_vote": "stage", "rematch": "ready"}
handshake = ContextVar("glorton_handshake")
SEAT_TOKEN = re.compile(r"[A-Za-z0-9_-]{32}")


def restore_checkpoint(snapshot, runtime):
    """Send full precision on recovery while retaining release checksums."""
    checkpoint = {**snapshot, "_runtime": {
        "fight_timer_accumulator_ms": runtime.fight_timer_accumulator_ms,
        "match_loading_elapsed_ms": runtime.match_loading_elapsed_ms,
        "countdown_focus_indices": list(runtime.countdown_focus_indices),
    }}
    for field in ("camera_view", "camera_target_view"):
        vector = getattr(runtime, field)
        checkpoint[field] = None if vector is None else list(vector)
    for field in ("fighters", "bullets", "rockets", "special_projectiles", "items"):
        checkpoint[field] = [
            {**entry, "pos": list(entity.pos), "prev_pos": list(getattr(entity, "prev_pos", entity.pos))}
            for entry, entity in zip(snapshot[field], getattr(runtime, field))
        ]
    for entry, item in zip(checkpoint["items"], runtime.items):
        if item.active_offset is not None:
            entry["active_offset"] = list(item.active_offset)
    checkpoint["explosions"] = [
        {**entry, "pos": list(effect.pos), "matter_offsets": [list(vector) for vector in effect.matter_offsets]}
        for entry, effect in zip(snapshot["explosions"], runtime.explosions)
    ]
    return checkpoint


class MultiplayerRoom(Room):
    def __init__(self, code, host_name, capacity, extended_snapshots):
        super().__init__(code, host_name)
        self.capacity = capacity
        self.extended_snapshots = extended_snapshots
        self.lifecycle = asyncio.Lock()
        self.broadcast_order = asyncio.Lock()
        self.round = 1
        self.map_votes = [None] * capacity
        self.rematch_votes = [False] * capacity
        self.result = None
        self.played_stage = None
        for index in range(1, capacity):
            self.slots[index] = PlayerSlot(index, "human", "等待玩家", "PeachPlayer", index, enabled=False)
        self.inputs = {index: {} for index in range(capacity)}
        self.last_inputs = {index: self.neutral_input() for index in range(capacity)}
        self.last_input_seq = dict.fromkeys(range(capacity), -1)
        self.acks = dict.fromkeys(range(capacity), -1)

    @staticmethod
    def neutral_input():
        return dict.fromkeys(INPUT_FIELDS, False)

    @property
    def humans(self):
        return self.slots[:self.capacity]

    def add_connection(self, token, slot, send):
        if not self.extended_snapshots:
            super().add_connection(token, slot, send)
            return

        async def send_with_runtime(packet):
            op = packet["op"]
            if op in ROUND_PACKETS and "round" not in packet:
                packet = {**packet, "round": self.round}
            key = SNAPSHOT_FIELDS.get(op)
            snapshot = packet.get(key)
            if (snapshot is not None and packet["round"] == self.round and self.simulation is not None
                    and snapshot["tick"] == self.simulation.tick_index):
                # Attach restore-only state after the release generates its canonical snapshot.
                packet = {**packet, key: restore_checkpoint(snapshot, self.simulation.runtime)}
            await send(packet)

        super().add_connection(token, slot, send_with_runtime)

    async def broadcast(self, message):
        # The installed endpoint also publishes on join/leave. Keep those sends
        # ordered with ready changes so all seats see the same latest state.
        if message["op"] == "match_start" and self.extended_snapshots:
            # Headless initialization uses the manifest's default stock. Apply
            # the room rule before sending the first checkpoint to any seat.
            stock = message["match_config"]["limit_value"]
            self.simulation.runtime.manifest["match"]["starting_lives"] = stock
            for fighter in self.simulation.fighters:
                fighter.lives = stock
            message = {**message, "initial_snapshot": self.simulation.snapshot()}
        if message["op"] in ROUND_PACKETS and self.extended_snapshots and "round" not in message:
            message = {**message, "round": self.round}
        async with self.broadcast_order:
            await super().broadcast(message)

    def join(self, player_name):
        if self.phase != "lobby":
            raise ValueError("match_already_started")
        requested = handshake.get({}).get("slot")
        if requested is not None:
            if type(requested) is not int or not 1 <= requested < self.capacity:
                raise ValueError("invalid_slot")
            slot = self.slots[requested]
            if slot.token:
                raise ValueError("room_full")
        else:
            slot = next((player for player in self.humans[1:] if not player.token), None)
            if slot is None:
                raise ValueError("room_full")
        requested_token = handshake.get({}).get("seat_token") if self.extended_snapshots else None
        if requested_token is not None:
            if not isinstance(requested_token, str) or not SEAT_TOKEN.fullmatch(requested_token):
                raise ValueError("invalid_seat_token")
            if any(player.token == requested_token for player in self.humans):
                raise ValueError("seat_token_in_use")
        slot.token = requested_token or secrets.token_urlsafe(24)
        slot.name = clean_name(player_name)
        slot.enabled = True
        self.updated_at = time.monotonic()
        return slot.token, slot.index

    def resume(self, token, send):
        slot = next((player for player in self.humans if player.token and player.token == token), None)
        if slot is None:
            raise ValueError("invalid_resume_token")
        if token in self.connections:
            raise ValueError("seat_connected")
        if slot.disconnected_at is not None and time.monotonic() - slot.disconnected_at > RECONNECT_SECONDS:
            raise ValueError("invalid_resume_token")
        self.add_connection(token, slot.index, send)
        return slot.index

    def disconnect(self, token):
        connection = self.connections.get(token)
        if connection is None:
            return
        super().disconnect(token)
        self.inputs[connection.slot].clear()
        self.last_inputs[connection.slot] = self.neutral_input()
        self.rematch_votes[connection.slot] = False

    async def release_guest(self, token):
        if not self.extended_snapshots:
            return False
        async with self.lifecycle:
            if self.phase != "lobby" and self.result is None:
                return False
            slot = next((player for player in self.humans[1:] if player.token and player.token == token), None)
            if slot is None:
                return False
            if self.result is not None:
                self.next_round()
            self.disconnect(token)
            self.slots[slot.index] = PlayerSlot(slot.index, "human", "等待玩家", "PeachPlayer", slot.index, enabled=False)
            self.map_votes[slot.index] = None
            self.reset_ready()
            self.updated_at = time.monotonic()
            await self.broadcast(self.public_state())
            return True

    def public_state(self):
        state = {**super().public_state(), "capacity": self.capacity}
        if self.extended_snapshots:
            if self.played_stage is not None:
                state["settings"]["stage"] = self.played_stage
            state.update(round=self.round, map_votes=self.map_votes.copy(),
                         rematch_votes=self.rematch_votes.copy(), result=self.result)
        return state

    def reset_ready(self):
        for human in self.humans:
            human.ready = False

    def next_round(self):
        self.phase = "lobby"
        self.round += 1
        self.finished_at = None
        self.result = None
        self.played_stage = None
        self.simulation = None
        self.seed = 0
        self.server_tick = 0
        self.paused_for_reconnect = False
        self.map_votes = [None] * self.capacity
        self.rematch_votes = [False] * self.capacity
        for index in range(self.capacity):
            self.inputs[index].clear()
            self.last_inputs[index] = self.neutral_input()
            self.last_input_seq[index] = self.acks[index] = -1
        self.reset_ready()

    def selected_stage(self):
        counts = {stage: self.map_votes.count(stage) for stage in STAGES}
        highest = max(counts.values())
        if not highest:
            return self.settings["stage"]
        return secrets.choice([stage for stage, count in counts.items() if count == highest])

    def update_ballot(self, actor_slot, action, value):
        if not self.extended_snapshots or not 0 <= actor_slot < self.capacity or not self.slots[actor_slot].connected:
            raise ValueError("invalid_slot")
        if action == "map_vote":
            if self.phase != "lobby":
                raise ValueError("not_in_lobby")
            if value not in STAGES:
                raise ValueError("invalid_stage")
            if self.map_votes[actor_slot] != value:
                self.map_votes[actor_slot] = value
                self.slots[actor_slot].ready = False
        else:
            if self.result is None:
                raise ValueError("not_finished")
            if type(value) is not bool:
                raise ValueError("invalid_rematch_vote")
            self.rematch_votes[actor_slot] = value
            if all(human.connected and self.rematch_votes[human.index] for human in self.humans):
                self.next_round()

    async def update_lobby(self, actor_slot, message):
        async with self.lifecycle:
            action = message.get("_browser_action")
            if action in BROWSER_ACTIONS:
                if "round" in message and message["round"] != self.round:
                    raise ValueError("stale_round")
                self.update_ballot(actor_slot, action, message.get(BROWSER_ACTIONS[action]))
            else:
                self.apply_selection(actor_slot, message)
            self.updated_at = time.monotonic()
            await self.broadcast(self.public_state())

    def apply_selection(self, actor_slot, message):
        if self.phase != "lobby":
            raise ValueError("not_in_lobby")
        target = int(message.get("slot", actor_slot))
        if not 0 <= target < len(self.slots):
            raise ValueError("invalid_slot")
        patch = validate_lobby_patch(message.get("patch"))
        slot = self.slots[target]
        if slot.kind == "human":
            if target != actor_slot:
                raise ValueError("cannot_edit_other_human")
            patch = {key: value for key, value in patch.items() if key in {"fighter", "color", "ready"}}
        else:
            if actor_slot != self.host_slot:
                raise ValueError("host_only")
            patch.pop("ready", None)

        if any(key in patch and getattr(slot, key) != patch[key] for key in ("fighter", "color", "level", "enabled")):
            if slot.kind == "human" and self.extended_snapshots:
                slot.ready = False
            else:
                self.reset_ready()
        for key, value in patch.items():
            setattr(slot, key, value)
        if slot.kind == "ai":
            # Keep enabled AI seats consecutive so the runtime's slot indices agree with the lobby.
            relatives = (self.slots[self.capacity:target] if slot.enabled else self.slots[target+1:])
            for bot in [slot, *relatives]:
                bot.connected = bot.ready = bot.enabled = slot.enabled
    async def update_settings(self, actor_slot, message):
        async with self.lifecycle:
            if actor_slot != self.host_slot:
                raise ValueError("host_only")
            if self.phase != "lobby":
                raise ValueError("not_in_lobby")
            patch = validate_settings_patch(message.get("patch"))
            if any(self.settings.get(key) != value for key, value in patch.items()):
                self.settings.update(patch)
                self.reset_ready()
            self.updated_at = time.monotonic()
            await self.broadcast(self.public_state())

    def can_start(self):
        return self.phase == "lobby" and all(
            human.enabled and human.connected and human.ready and human.fighter for human in self.humans
        )

    async def start_match(self):
        async with self.lifecycle:
            if not self.extended_snapshots:
                await super().start_match()
                return
            if not self.can_start() or self.match_task is not None:
                return
            fallback = self.settings["stage"]
            self.played_stage = self.selected_stage()
            # The installed authority uses this key both to validate the AI and to build the match config.
            self.settings["stage"] = self.played_stage
            try:
                await super().start_match()
            finally:
                self.settings["stage"] = fallback
                if self.phase == "lobby":
                    self.played_stage = None

    def queue_input(self, slot, message):
        if self.phase != "playing" or slot not in self.inputs or not self.slots[slot].connected:
            return
        seq = int(message.get("seq", -1))
        if seq <= self.last_input_seq[slot]:
            return
        target = int(message.get("tick", self.server_tick + 2))
        target = min(self.server_tick + MAX_INPUT_LEAD, max(self.server_tick, target))
        controls = normalize_controls(message.get("controls"))
        pending = self.inputs[slot]
        previous = pending.get(target)
        if previous:
            # Two packets for one simulation tick may include a short attack press and its release.
            for edge in EDGE_FIELDS:
                controls[edge] |= previous[1][edge]
        pending[target] = (seq, controls)
        self.last_input_seq[slot] = seq

    def _controls_for_tick(self, slot, tick):
        entry = self.inputs[slot].pop(tick, None)
        if entry is None:
            return controls_without_edges(self.last_inputs[slot])
        seq, controls = entry
        self.acks[slot] = max(self.acks[slot], seq)
        self.last_inputs[slot] = controls
        return controls

    async def finish(self, packet):
        async with self.lifecycle:
            self.phase = "finished"
            self.finished_at = time.monotonic()
            if self.extended_snapshots and packet["reason"] == "game_set":
                self.result = {key: packet[key] for key in ("reason", "winner", "winner_slot")}
            await self.broadcast({"op": "match_end", **packet})
            if self.result is not None:
                await self.broadcast(self.public_state())

    def expired(self, now):
        if self.result is not None and self.connections:
            # The browser lobby owns the active room's expiry while players can rematch.
            return False
        return super().expired(now)

    async def _run_match(self):
        simulation = self.simulation
        loop = asyncio.get_running_loop()
        deadline = loop.time()
        try:
            while self.phase == "playing":
                now = loop.time()
                disconnected = [slot for slot in self.humans if not slot.connected]
                if disconnected:
                    if not self.paused_for_reconnect:
                        self.paused_for_reconnect = True
                        await self.broadcast(self.public_state())
                    if any(slot.disconnected_at is not None and time.monotonic() - slot.disconnected_at > RECONNECT_SECONDS
                           for slot in disconnected):
                        await self.finish({"reason": "reconnect_timeout"})
                        return
                    await asyncio.sleep(0.05)
                    continue
                if self.paused_for_reconnect:
                    self.paused_for_reconnect = False
                    await self.broadcast(self.public_state())
                    await self.broadcast({"op": "snapshot", "snapshot": simulation.snapshot()})
                    deadline = now

                controls = [self._controls_for_tick(index, self.server_tick) for index in range(self.capacity)]
                simulation.step_fast(controls, advance_clock=True)
                self.server_tick = simulation.tick_index
                frame = {"op": "frame", "tick": self.server_tick, "controls": simulation._previous_controls,
                         "acks": {str(index): seq for index, seq in self.acks.items()}}
                if self.server_tick % 20 == 0:
                    frame["digest"] = simulation.state_digest()
                await self.broadcast(frame)
                if simulation.runtime.match_state == "game_set":
                    winner = simulation.runtime.match_winner
                    details = {"reason": "game_set", "winner": winner.name if winner else None,
                               "snapshot": simulation.snapshot()}
                    if self.extended_snapshots:
                        details["winner_slot"] = winner.team_index if winner is not None else None
                        if winner is not None:
                            details["winner"] = self.slots[winner.team_index].name
                    await self.finish(details)
                    return
                deadline += TICK_MS / 1000
                now = loop.time()
                if now - deadline > MAX_TICK_DEBT:
                    deadline = now
                # Writes to the loopback tunnel may complete without yielding. Let input
                # handlers run between catch-up ticks and bound bursts after a stall.
                await asyncio.sleep(max(0.0, deadline - now))
        finally:
            if asyncio.current_task() is self.match_task:
                self.match_task = None


class MultiplayerRoomManager(RoomManager):
    def create(self, player_name):
        options = handshake.get({})
        capacity = options.get("capacity", 2)
        if type(capacity) is not int or not 2 <= capacity <= MAX_PLAYERS:
            raise ValueError("invalid_capacity")
        # The browser sync tunnel sets capacity explicitly; the old desktop handshake omits it.
        room = MultiplayerRoom(self._new_code(), player_name, capacity, extended_snapshots="capacity" in options)
        self.rooms[room.code] = room
        return room, room.host_token, 0


class SeatHandshake:
    """Expose room options to the reused authority endpoint on its first read."""

    def __init__(self, socket):
        self.socket = socket
        self.first = True

    def __getattr__(self, name):
        return getattr(self.socket, name)

    async def receive_text(self):
        message = await self.socket.receive_text()
        if self.first:
            self.first = False
            packet = decode_message(message)
            if packet["op"] == "resume" and int(packet.get("protocol", -1)) == PROTOCOL_VERSION:
                room = upstream.manager.rooms.get(room_code(packet.get("room")))
                if room is not None and str(packet.get("token", "")) in room.connections:
                    # Reject before the reused endpoint records the token for its cleanup.
                    raise ValueError("seat_connected")
            handshake.set(packet)
        elif any(f'"{op}"' in message for op in BROWSER_ACTIONS):
            packet = decode_message(message)
            action = packet["op"]
            if action in BROWSER_ACTIONS:
                # Keep the installed endpoint's credential and rate checks for the browser actions.
                message = encode_message({**packet, "op": "lobby_update", "_browser_action": action})
        return message


# This process has its own manager; the installed source is used without modification.
upstream.manager = MultiplayerRoomManager()
app = FastAPI(title="Glorton Multiplayer Authority", version=str(PROTOCOL_VERSION), lifespan=upstream.lifespan)


@app.get("/")
@app.get("/health")
async def health():
    return {**await upstream.health(), "max_players": MAX_PLAYERS, "release_seat": True}


@app.post("/release-seat")
async def release_seat(body: dict):
    token = body.get("token")
    if not isinstance(token, str) or not SEAT_TOKEN.fullmatch(token):
        return {"released": False}
    try:
        room = upstream.manager.rooms.get(room_code(body.get("room")))
    except (TypeError, ValueError):
        return {"released": False}
    if room is None:
        return {"released": False}
    return {"released": await room.release_guest(token), "playing": room.phase == "playing"}


@app.websocket("/ws")
async def websocket_room(socket: WebSocket):
    token = handshake.set({})
    try:
        await upstream.websocket_room(SeatHandshake(socket))
    finally:
        handshake.reset(token)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--log-level", default="info")
    options = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=options.port, log_level=options.log_level,
                proxy_headers=False, ws="websockets", ws_max_size=16384, ws_max_queue=8, access_log=False)


if __name__ == "__main__":
    main()
