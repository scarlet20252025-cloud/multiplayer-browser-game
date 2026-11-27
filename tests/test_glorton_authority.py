"""Room lifecycle regression tests for the installed Glorton authority."""

import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


if importlib.util.find_spec("online") is None:
    raise unittest.SkipTest("The installed Glorton runtime is required")

SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "glorton-multiplayer-authority.py"
SPEC = importlib.util.spec_from_file_location("glorton_authority", SOURCE)
authority = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(authority)


class BrowserRoomTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.room = authority.MultiplayerRoom("ABC239", "Host", 2, extended_snapshots=True)
        self.sent = []

        async def record(packet):
            self.sent.append(packet)

        self.room.add_connection(self.room.host_token, 0, record)
        self.guest_token, slot = self.room.join("Guest")
        self.room.add_connection(self.guest_token, slot, record)

    async def select(self, slot, **fields):
        await self.room.update_lobby(slot, {"patch": fields})

    async def vote(self, slot, stage):
        await self.room.update_lobby(slot, {"_browser_action": "map_vote", "stage": stage})

    async def rematch(self, slot, ready=True):
        await self.room.update_lobby(slot, {"_browser_action": "rematch", "ready": ready})

    async def finish_match(self):
        result = {"reason": "game_set", "winner": "Guest", "winner_slot": 1}
        await self.room.finish(result)
        self.assertEqual(self.room.public_state()["result"], result)
        self.assertIn({"op": "match_end", "round": 1, **result}, self.sent)

    async def test_second_player_selection_and_ready_do_not_unready_first_player(self):
        await self.select(0, ready=True)
        await self.select(1, fighter="CoffeePlayer", color=2)
        await self.vote(1, "Rooftop")
        self.assertTrue(self.room.humans[0].ready)
        await self.select(1, ready=True)
        self.assertTrue(self.room.can_start())
        await self.select(1, fighter="CoffeePlayer", color=2)
        self.assertTrue(self.room.can_start())
        await self.room.update_settings(0, {"patch": {"stage": "Mogadishu"}})
        self.assertTrue(self.room.can_start())
        await self.vote(1, "Space")
        self.assertEqual([slot.ready for slot in self.room.humans], [True, False])

    async def test_ready_host_refresh_restarts_the_consensus_after_welcome(self):
        await self.vote(0, "B52")
        await self.select(0, fighter="CoffeePlayer", color=3, ready=True)
        self.room.disconnect(self.room.host_token)
        self.assertTrue(self.room.humans[0].ready)
        await self.select(1, ready=True)
        self.assertFalse(self.room.can_start())

        class RefreshedSocket:
            def __init__(self, room):
                self.requests = [authority.encode_message({
                    "op": "resume", "room": room.code, "token": room.host_token,
                    "protocol": authority.PROTOCOL_VERSION,
                })]
                self.packets = []

            async def accept(self):
                pass

            async def receive_text(self):
                if self.requests:
                    return self.requests.pop()
                raise authority.upstream.WebSocketDisconnect()

            async def send_text(self, message):
                self.packets.append(authority.decode_message(message))

        socket = RefreshedSocket(self.room)
        starts = []
        original_broadcast = self.room.broadcast

        async def checked_broadcast(packet):
            # Other ready events must wait until the reconnect handshake has completed.
            if packet["op"] == "room_state" and len(socket.packets) == 1:
                self.assertFalse(self.room.can_start())
            await original_broadcast(packet)

        async def start(room):
            starts.append(room.match_config())
            room.phase = "playing"
            self.assertEqual([packet["op"] for packet in socket.packets], ["welcome", "room_state"])
            self.assertTrue(all(slot["ready"] for slot in socket.packets[1]["slots"][:2]))
            await authority.Room.broadcast(room, {"op": "match_start"})

        with (patch.dict(authority.upstream.manager.rooms, {self.room.code: self.room}),
              patch.object(authority.Room, "start_match", start),
              patch.object(self.room, "broadcast", checked_broadcast)):
            await authority.websocket_room(socket)

        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0]["stage"], "B52")
        self.assertEqual(starts[0]["players"][0]["fighter"], "CoffeePlayer")
        self.assertEqual(starts[0]["players"][0]["color"], 3)
        self.assertEqual(socket.packets[-1]["op"], "match_start")
        self.assertFalse(self.room.pending_lobby_resumes)

    async def test_map_vote_chooses_only_top_tied_maps(self):
        self.assertEqual(self.room.selected_stage(), "Mogadishu")
        await self.vote(0, "Rooftop")
        await self.vote(1, "Space")
        with patch.object(authority.secrets, "choice", return_value="Space") as choice:
            self.assertEqual(self.room.selected_stage(), "Space")
            choice.assert_called_once_with(["Rooftop", "Space"])
        await self.vote(1, "Rooftop")
        self.assertEqual(self.room.selected_stage(), "Rooftop")
        self.assertEqual(self.room.public_state()["map_votes"], ["Rooftop", "Rooftop"])
        with self.assertRaisesRegex(ValueError, "invalid_stage"):
            await self.vote(1, "Unavailable")

    async def test_start_uses_selected_map_and_keeps_fallback(self):
        called = []

        async def start(room):
            called.append(room.match_config()["stage"])
            room.phase = "playing"

        await self.vote(0, "B52")
        await self.select(0, ready=True)
        await self.select(1, ready=True)
        with patch.object(authority.Room, "start_match", start):
            await self.room.start_match()
        self.assertEqual(called, ["B52"])
        self.assertEqual(self.room.public_state()["settings"]["stage"], "B52")
        self.assertEqual(self.room.settings["stage"], "Mogadishu")
        with self.assertRaisesRegex(ValueError, "not_in_lobby"):
            await self.vote(0, "Space")

    async def test_rematch_resets_round_state_but_keeps_slot_and_character(self):
        await self.select(0, fighter="CoffeePlayer", color=3, ready=True)
        await self.vote(1, "B52")
        self.room.server_tick = 645
        self.room.inputs[0][648] = (15, {"left": True}, 648)
        self.room.acks[0] = self.room.last_input_seq[0] = 14
        self.room.simulation = object()
        await self.finish_match()
        await self.rematch(0)
        self.assertEqual(self.room.public_state()["rematch_votes"], [True, False])
        await self.rematch(0, False)
        await self.rematch(1)
        self.assertEqual(self.room.phase, "finished")
        await self.rematch(0)
        state = self.room.public_state()
        self.assertEqual((state["phase"], state["round"], state["server_tick"]), ("lobby", 2, 0))
        self.assertIsNone(state["result"])
        self.assertIsNone(self.room.simulation)
        self.assertEqual(state["map_votes"], [None, None])
        self.assertEqual(state["rematch_votes"], [False, False])
        self.assertEqual(self.room.inputs[0], {})
        self.assertEqual(self.room.acks[0], -1)
        self.assertEqual(self.room.last_input_seq[0], -1)
        self.assertEqual([slot.ready for slot in self.room.humans], [False, False])
        self.assertTrue(all(slot.connected for slot in self.room.humans))
        self.assertEqual((self.room.humans[0].fighter, self.room.humans[0].color), ("CoffeePlayer", 3))

    async def test_initial_checkpoint_uses_the_room_stock(self):
        await self.room.update_settings(0, {"patch": {"stock": 1}})
        await self.select(0, ready=True)
        await self.select(1, ready=True)
        await self.room.start_match()
        try:
            packet = next(entry for entry in self.sent if entry["op"] == "match_start")
            self.assertEqual([fighter["lives"] for fighter in packet["initial_snapshot"]["fighters"]], [1, 1])
            self.assertEqual([fighter.lives for fighter in self.room.simulation.fighters], [1, 1])
        finally:
            if self.room.match_task is not None:
                self.room.match_task.cancel()
                await asyncio.gather(self.room.match_task, return_exceptions=True)

    async def test_guest_exit_from_result_frees_the_same_room(self):
        await self.finish_match()
        await self.rematch(1)
        self.room.disconnect(self.guest_token)
        self.assertEqual(self.room.public_state()["rematch_votes"], [False, False])
        self.assertTrue(await self.room.release_guest(self.guest_token))
        self.assertEqual(self.room.public_state()["round"], 2)
        self.assertTrue(self.room.humans[0].connected)
        new_token, seat = self.room.join("Another guest")
        self.assertEqual(seat, 1)
        self.assertNotEqual(new_token, self.guest_token)

    async def test_automatic_roster_waits_for_reserved_seat_then_compacts_inputs_and_rematches(self):
        room = authority.MultiplayerRoom("ABC239", "Host", 4, extended_snapshots=True, automatic_roster=True)

        async def record(packet):
            self.sent.append(packet)

        room.add_connection(room.host_token, 0, record)
        await room.update_lobby(0, {"patch": {"ready": True}})
        self.assertFalse(room.can_start())
        reserved_token, reserved_slot = room.join("Reserved")
        room.add_connection(reserved_token, reserved_slot, record)
        guest_token, guest_slot = room.join("Player Three")
        room.add_connection(guest_token, guest_slot, record)
        await room.update_lobby(guest_slot, {"patch": {"fighter": "CoffeePlayer", "ready": True}})
        room.disconnect(reserved_token)
        self.assertFalse(room.can_start())

        configs = []

        async def start(active_room):
            configs.append(active_room.match_config())
            active_room.phase = "playing"

        with patch.object(authority.Room, "start_match", start):
            self.assertTrue(await room.release_guest(reserved_token))
        self.assertEqual(room.match_slots, (0, 2))
        self.assertEqual(room.public_state()["match_slots"], [0, 2])
        self.assertEqual([player["team_index"] for player in configs[0]["players"]], [0, 1])
        self.assertEqual([player["network_slot"] for player in configs[0]["players"]], [0, 1])
        with self.assertRaisesRegex(ValueError, "match_already_started"):
            room.join("Late join")

        class FinalTick:
            tick_index = 0
            runtime = SimpleNamespace(match_state="fighting", match_winner=None)

            def step_fast(self, controls, *, advance_clock):
                self._previous_controls = controls
                self.tick_index += 1
                self.runtime.match_state = "game_set"
                self.runtime.match_winner = SimpleNamespace(name="Coffee", team_index=1)

            def snapshot(self):
                return {"tick": self.tick_index}

        room.simulation = FinalTick()
        room.queue_input(guest_slot, {"seq": 3, "tick": 0, "controls": {"right": True}})
        with patch.object(room, "broadcast", record):
            await room._run_match()
        frame = next(packet for packet in self.sent if packet["op"] == "frame")
        self.assertEqual([controls["right"] for controls in frame["controls"]], [False, True])
        self.assertEqual(room.result["winner_slot"], 2)
        self.assertEqual(room.result["winner"], "Player Three")

        for seat in (0, 2):
            await room.update_lobby(seat, {"_browser_action": "rematch", "ready": True, "round": 1})
        self.assertEqual((room.phase, room.round), ("lobby", 2))
        self.assertIsNone(room.match_slots)
        self.assertEqual(room.humans[2].fighter, "CoffeePlayer")
        self.assertEqual(room.humans[2].token, guest_token)

    async def test_automatic_roster_requires_every_joined_player_to_be_ready(self):
        room = authority.MultiplayerRoom("ABC239", "Host", 4, extended_snapshots=True, automatic_roster=True)

        async def record(_packet):
            pass

        room.add_connection(room.host_token, 0, record)
        for seat in range(1, 4):
            token, index = room.join("Guest " + str(seat))
            room.add_connection(token, index, record)
        for seat in range(3):
            await room.update_lobby(seat, {"patch": {"ready": True}})
        self.assertFalse(room.can_start())
        await room.update_lobby(3, {"patch": {"ready": True}})
        self.assertTrue(room.can_start())

    async def test_rapid_shield_transitions_keep_latest_state_and_preserve_attack_edges(self):
        self.room.phase = "playing"
        for sample in range(100):
            tick = sample * 3
            self.room.server_tick = tick
            for offset, controls in enumerate(({"shield_pressed": True, "punch_pressed": True},
                                               {"shield_released": True}, {"right": True})):
                self.room.queue_input(0, {"seq": tick + offset, "tick": tick, "controls": controls})
            pressed = self.room._controls_for_tick(0, tick)
            self.assertTrue(pressed["shield_pressed"] and pressed["punch_pressed"])
            self.assertFalse(pressed["shield_released"])
            released = self.room._controls_for_tick(0, tick + 1)
            self.assertTrue(released["shield_released"])
            self.assertFalse(released["shield_pressed"])
            self.assertTrue(self.room._controls_for_tick(0, tick + 2)["right"])
        self.assertEqual(self.room.acks[0], 299)
        self.room.server_tick = 300
        self.room.queue_input(0, {"seq": 300, "tick": 300, "controls": {"shield_released": True}})
        self.room.queue_input(0, {"seq": 301, "tick": 300, "controls": {"shield_pressed": True}})
        self.assertTrue(self.room._controls_for_tick(0, 300)["shield_released"])
        self.assertTrue(self.room._controls_for_tick(0, 301)["shield_pressed"])

    async def test_late_shield_duck_and_direction_taps_bind_to_distinct_authoritative_frames(self):
        self.room.phase = "playing"
        self.room.server_tick = 90
        samples = (
            (61, {"shield_pressed": True}),
            (62, {"shield_released": True}),
            (63, {"down": True}),
            (63, {}),  # The browser may reuse the last predicted tick after reaching its lead cap.
            (63, {"left": True}),
            (63, {}),
        )
        for seq, (requested, controls) in enumerate(samples, 1):
            self.room.queue_input(0, {"seq": seq, "tick": requested, "controls": controls})
        self.assertEqual(list(self.room.inputs[0]), list(range(90, 96)))
        for seq, (_, expected) in enumerate(samples, 1):
            current = self.room._controls_for_tick(0, 89 + seq)
            self.assertEqual({key: value for key, value in current.items() if value}, expected)
            self.assertEqual(self.room.acks[0], seq)

    async def test_late_burst_at_the_horizon_keeps_final_release(self):
        self.room.phase = "playing"
        self.room.server_tick = 100
        for seq in range(40):
            pressed = seq % 2 == 0
            controls = {"shield_pressed": pressed, "shield_released": not pressed, "down": pressed}
            self.room.queue_input(0, {"seq": seq, "tick": seq + 1, "controls": controls})
        self.assertEqual(list(self.room.inputs[0]), list(range(100, 109)))
        for tick in range(100, 108):
            self.room._controls_for_tick(0, tick)
        final = self.room._controls_for_tick(0, 108)
        self.assertTrue(final["shield_released"])
        self.assertFalse(final["shield_pressed"] or final["down"])
        self.assertEqual(self.room.acks[0], 39)

    async def test_out_of_order_target_never_reapplies_an_old_hold_after_release(self):
        self.room.phase = "playing"
        self.room.server_tick = 50
        self.room.queue_input(0, {"seq": 1, "tick": 55, "controls": {"left": True, "jump_pressed": True}})
        self.room.queue_input(0, {"seq": 2, "tick": 51, "controls": {}})
        self.assertFalse(self.room._controls_for_tick(0, 51)["left"])
        step = self.room._controls_for_tick(0, 55)
        self.assertTrue(step["jump_pressed"])
        self.assertFalse(step["left"])
        self.assertEqual(self.room.acks[0], 2)
        self.assertFalse(self.room._controls_for_tick(0, 56)["left"])

    async def test_focus_clear_and_disconnect_discard_queued_controls_and_release_shield(self):
        self.room.phase = "playing"
        self.room.server_tick = 80
        self.room.queue_input(0, {"seq": 1, "tick": 85, "controls": {"shield_pressed": True, "right": True}})
        self.room.queue_input(0, {"seq": 2, "tick": 80, "clear": True})
        self.assertEqual(list(self.room.inputs[0]), [80])
        cleared = self.room._controls_for_tick(0, 80)
        self.assertTrue(cleared["shield_released"])
        self.assertFalse(cleared["shield_pressed"] or cleared["right"])
        self.assertEqual(self.room.acks[0], 2)

        self.room.server_tick = 81
        self.room.queue_input(0, {"seq": 3, "tick": 84, "controls": {"shield_pressed": True}})
        self.room.disconnect(self.room.host_token)
        self.assertEqual(list(self.room.inputs[0]), [81])
        self.assertTrue(self.room._controls_for_tick(0, 81)["shield_released"])
        self.assertFalse(self.room._controls_for_tick(0, 82)["shield_pressed"])
