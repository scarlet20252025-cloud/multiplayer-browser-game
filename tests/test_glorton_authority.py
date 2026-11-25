"""Room lifecycle regression tests for the installed Glorton authority."""

import asyncio
import importlib.util
from pathlib import Path
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
        self.room.inputs[0][648] = (15, {"left": True})
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
