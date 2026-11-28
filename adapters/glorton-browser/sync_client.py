"""Browser transport for an installed Glorton release. Uses its existing engine."""

import asyncio
from functools import lru_cache
import json
import os
import platform
import sys
import time
from types import ModuleType, SimpleNamespace

import pygame

from render_scene import install_stage_renderer
from stage_budget import StageRenderBudget


DRAW_INTERVAL = 1 / 60
DRAW_TOLERANCE = 0.0015
DISPLAY_LIMIT = 1280
MAX_PACKETS_PER_ITERATION = 64


class BrowserSocket:
    def __init__(self, bridge, handle):
        self.bridge = bridge
        self.handle = handle

    async def send(self, message):
        if not self.bridge.send(self.handle, message):
            raise ConnectionError("Browser socket closed")

    async def close(self):
        self.bridge.close(self.handle)


def load_release_client():
    # The desktop client imports a native socket library. This entry supplies the
    # interface expected by its type imports; BrowserClient binds the actual socket.
    for name in ("websockets", "websockets.asyncio", "websockets.asyncio.client"):
        sys.modules[name] = ModuleType(name)
    dependency = sys.modules["websockets.asyncio.client"]
    dependency.ClientConnection = BrowserSocket
    dependency.connect = None
    from online.client import OnlineGameClient

    return OnlineGameClient


def browser_display_size(window, stage):
    if stage is None or not stage.clientWidth:
        return DISPLAY_LIMIT, 760
    ratio = min(2.0, max(1.0, float(window.devicePixelRatio or 1)))
    width = min(DISPLAY_LIMIT, max(320, round(stage.clientWidth * ratio)))
    return width, round(width * 19 / 32)


def scale_display_asset(surface, size):
    source = surface.get_size()
    if source == size:
        return surface
    # Magnify the packaged 1x bitmap once without averaging away its edges.
    if source[0] <= size[0] and source[1] <= size[1]:
        return pygame.transform.scale(surface, size)
    return pygame.transform.smoothscale(surface, size)


def next_draw_deadline(previous, now):
    deadline = previous + DRAW_INTERVAL
    return deadline if deadline > now else now + DRAW_INTERVAL


def configure_screen():
    # The SDL backing surface is already measured in physical pixels.
    os.environ["GLORTON_PIXEL_RATIO"] = "1"
    os.environ["GLORTON_ASSET_SCALE"] = "1"


def is_empty_palette_png(path):
    """Detect a PNG with no visible palette entries before SDL decodes it."""
    with path.open("rb") as image:
        if image.read(8) != b"\x89PNG\r\n\x1a\n":
            return False
        palette_entries = 0
        while header := image.read(8):
            if len(header) < 8:
                return False
            size = int.from_bytes(header[:4], "big")
            kind = header[4:]
            if kind == b"PLTE" and 3 <= size <= 768 and size % 3 == 0:
                palette_entries = size // 3
            if kind == b"tRNS":
                # A shorter table leaves its remaining palette entries opaque.
                return bool(palette_entries and size == palette_entries and image.read(size) == b"\0" * size)
            if kind in (b"IDAT", b"IEND"):
                break
            image.seek(size + 4, 1)
    return False


def prepare_explosion_rendering(runtime, surface_cache):
    frames = runtime.boom_star_frames + runtime.boom_wave_frames + runtime.boom_matter_frames
    explosion_paths = {frame.image_path for frame in frames}
    draw_registered = runtime._draw_registered_asset

    blank_paths = {path for path in explosion_paths if is_empty_palette_png(path)}

    @lru_cache(maxsize=8)
    def visual_image(path):
        image = surface_cache.get(path)
        return image if image.get_flags() & pygame.SRCALPHA else image.convert_alpha()

    def draw(screen, asset, *args, **kwargs):
        if asset.image_path in explosion_paths:
            # Browser SDL decodes an all-transparent palette as opaque black.
            # Skip those draw calls without changing animation frame counts.
            if asset.image_path in blank_paths:
                return
            image = visual_image(asset.image_path)
            asset = SimpleNamespace(image=image, offset=asset.offset, render_scale=asset.render_scale)
        draw_registered(screen, asset, *args, **kwargs)

    runtime._draw_registered_asset = draw


async def main():
    window = platform.window
    configure_screen()
    bridge = window.GlortonLocalSession
    upstream = load_release_client()
    from online.protocol import EDGE_FIELDS, HOLD_FIELDS
    from src.assets import SURFACE_CACHE
    from src.display import detect_display_metrics
    from src.runtime import TICK_MS

    SURFACE_CACHE.max_bytes = 96 * 1024 * 1024

    class BrowserClient(upstream):
        _font = staticmethod(lru_cache(maxsize=24)(upstream._font))

        def _start_runtime(self, message):
            super()._start_runtime(message)
            self.last_sent_holds = None
            self.last_input_tick = -1
            self.browser_pressed.clear()
            self.last_local_controls = {}
            self.runtime._quality_scale = scale_display_asset
            install_stage_renderer(self.runtime)
            self.runtime._stage_scene = StageRenderBudget(self.runtime._stage_scene)
            prepare_explosion_rendering(self.runtime, SURFACE_CACHE)
            local = self.local_input
            self.control_keys = (local.left_keys | local.right_keys | local.up_keys | local.down_keys |
                                 local.jump_keys | local.punch_keys | local.special_keys | local.shield_keys)

        async def _connect(self, action):
            handle = bridge.open()
            deadline = time.monotonic() + 7
            while bridge.state(handle) == 0 and time.monotonic() < deadline:
                await asyncio.sleep(0)
            if bridge.state(handle) != 1:
                bridge.close(handle)
                self.websocket = None
                self.status = "Connection unavailable"
                return
            self.websocket = BrowserSocket(bridge, handle)
            self.last_sent_holds = None
            self.reconnecting = False

        async def _process_messages(self):
            socket = self.websocket
            if socket is None:
                return
            # Apply the WebSocket inbox in the same browser turn as the simulation.
            # A separate asyncio receive task can leave a frame waiting in a second queue.
            for _ in range(MAX_PACKETS_PER_ITERATION):
                payload = bridge.read(socket.handle)
                if not payload:
                    break
                try:
                    message = json.loads(str(payload))
                except ValueError:
                    await socket.close()
                    break
                await self._handle_message(message)
            else:
                return
            if bridge.state(socket.handle) >= 2:
                self.websocket = None
                self.prediction_offset.update(0, 0)
                resumable = self.mode in ("lobby", "battle") or bool(self.room_state.get("result"))
                if self.running and resumable and not self.room_ended:
                    self._begin_reconnect()

        async def _handle_message(self, message):
            operation = message.get("op")
            round_number = message.get("round", self.round_number)
            if round_number < self.round_number:
                return
            if operation == "room_state" and message.get("phase") == "lobby" and round_number > self.round_number:
                self.runtime = None
                self.local_input = None
                self.pending_frames.clear()
                self.corrections = 0
                self.prediction_offset.update(0, 0)
                self.mode = "lobby"
            self.round_number = round_number
            if (operation == "state" and message.get("phase") == "ended") or (operation == "error" and message.get("fatal")):
                self.room_ended = True
            if operation == "welcome":
                message = {**message, "room": str(bridge.room), "token": "browser-seat"}
            await super()._handle_message(message)
            if operation == "room_state" and message.get("result"):
                self.mode = "finished"
            if operation == "room_state" and message.get("paused_for_reconnect"):
                self.prediction_offset.update(0, 0)
            if operation in ("match_start", "snapshot") and self.runtime is not None:
                snapshot = message.get("initial_snapshot" if operation == "match_start" else "snapshot")
                if not isinstance(snapshot, dict) or snapshot.get("tick") != self.runtime.simulation.tick_index:
                    return
                continuation = snapshot.get("_runtime")
                if isinstance(continuation, dict):
                    self.runtime.fight_timer_accumulator_ms = continuation["fight_timer_accumulator_ms"]
                    self.runtime.match_loading_elapsed_ms = continuation["match_loading_elapsed_ms"]
                    self.runtime.countdown_focus_indices = continuation["countdown_focus_indices"]
                bridge.acknowledge(snapshot["tick"], True, self.round_number)

        async def _handle_event(self, event):
            # The browser owns selection, Ready and rematch controls.
            if self.mode in ("lobby", "finished") and event.type in (pygame.KEYDOWN, pygame.KEYUP):
                return
            if self.mode == "battle" and event.type in (pygame.KEYDOWN, pygame.KEYUP) and event.key in self.control_keys:
                return
            await super()._handle_event(event)

        def _apply_keyboard(self, payload):
            if payload["reset"]:
                self.local_input = self.runtime._create_inputs()[0]
                self.browser_pressed.clear()
                self.last_sent_holds = None
                self.last_input_tick = -1
            local = self.local_input
            for action, pressed in payload["events"]:
                key = next(iter(getattr(local, f"{action}_keys")), None)
                if key is None:
                    continue
                if pressed:
                    self.browser_pressed.add(key)
                    local.keydown(key)
                else:
                    self.browser_pressed.discard(key)
                    local.keyup(key)
                    # Keep the other held direction when the current direction is released.
                    if action in ("left", "right") and local.horizontal_direction == action:
                        local.horizontal_direction = "left" if local.held_left else "right" if local.held_right else "stop"

        async def _send_controls(self):
            if (self.mode != "battle" or self.local_input is None or self.websocket is None
                    or self.room_state.get("paused_for_reconnect")):
                return
            now = time.monotonic()
            due = now >= self.next_input_at
            if not due and self.local_input.held_up:
                # Sampling the upstream diagonal/jump input advances its held timer.
                # Keep hold-to-jump on the normal game-tick cadence.
                return
            payload = str(bridge.readInput())
            if payload:
                self._apply_keyboard(json.loads(payload))
            elif not due:
                return
            controls = self.local_input.controls({key: key in self.browser_pressed for key in self.local_input.down_keys})
            self.last_local_controls = controls
            if due:
                self.next_input_at = max(self.next_input_at + TICK_MS / 1000, now + TICK_MS / 2000)
            holds = tuple(controls[field] for field in HOLD_FIELDS)
            if holds == self.last_sent_holds and not any(controls[field] for field in EDGE_FIELDS):
                return
            self.last_sent_holds = holds
            self.input_seq += 1
            # Keep the two edges of a short tap on separate ticks when the latest
            # server frame has not arrived yet. The first edge has no extra delay.
            tick = max(self.server_tick, min(self.server_tick + 2, self.last_input_tick + 1))
            self.last_input_tick = tick
            await self.send({"op": "input", "seq": self.input_seq, "tick": tick, "controls": controls})

        async def run(self):
            pygame.init()
            pygame.display.set_caption("The Fight for Glorton - Online")
            stage = window.document.querySelector(".glorton-stage")
            screen = pygame.display.set_mode(browser_display_size(window, stage), pygame.RESIZABLE)
            font = pygame.font.Font(None, 20)
            last_iteration = time.monotonic()
            previous_mode = None
            next_draw = 0.0
            resize_probe = 0.0
            render_ms = 0.0
            presented_frames = 0
            self.control_keys = set()
            self.browser_pressed = set()
            self.round_number = 0
            self.room_ended = False
            try:
                while self.running:
                    now = time.monotonic()
                    elapsed = (now - last_iteration) * 1000
                    last_iteration = now
                    for event in pygame.event.get():
                        await self._handle_event(event)
                    await self._process_messages()
                    await self._send_controls()
                    await self._advance_confirmed_frames()
                    self.latency_ms = float(bridge.rtt())
                    if self.websocket is not None and not self.room_state.get("paused_for_reconnect"):
                        self._update_prediction(elapsed)

                    tick = self.runtime.simulation.tick_index if self.runtime is not None else 0
                    if self.mode == "battle":
                        bridge.acknowledge(tick, False, self.round_number)
                    if now >= resize_probe:
                        resize_probe = now + 0.5
                        size = browser_display_size(window, stage)
                        if abs(size[0] - screen.get_width()) >= 8:
                            screen = pygame.display.set_mode(size, pygame.RESIZABLE)
                            if self.runtime is not None:
                                self.runtime.display_metrics = detect_display_metrics(screen)
                            previous_mode = None

                    draw_started = time.monotonic()
                    mode_changed = self.mode != previous_mode
                    if mode_changed or (self.mode == "battle" and draw_started + DRAW_TOLERANCE >= next_draw):
                        if self.mode in ("battle", "finished"):
                            self._draw_battle(screen, font)
                        else:
                            # The browser owns connection and character selection UI.
                            screen.fill((29, 23, 64))
                        pygame.display.flip()
                        presented_frames += 1
                        render_ms = (time.monotonic() - draw_started) * 1000
                        next_draw = next_draw_deadline(draw_started if mode_changed else next_draw, draw_started)
                        previous_mode = self.mode
                    bridge.report(self.mode, tick, self.corrections, render_ms, presented_frames)
                    # Yield to the browser rather than blocking it with SDL's clock limiter.
                    await asyncio.sleep(0)
            finally:
                await self.send({"op": "leave"})
                if self.websocket is not None:
                    await self.websocket.close()
                pygame.quit()

        def _draw_battle(self, screen, font):
            runtime = self.runtime
            if runtime is None:
                screen.fill((0, 0, 0))
                return
            view = runtime.camera_view
            target = runtime.camera_target_view
            elapsed = (time.monotonic() - self.last_frame_at) * 1000
            runtime.accumulator = max(0, min(TICK_MS - 1, int(elapsed)))
            fighter = runtime.fighters[self.local_slot] if 0 <= self.local_slot < len(runtime.fighters) else None
            if fighter is not None:
                previous_pos = pygame.Vector2(fighter.pos)
                previous_last_pos = pygame.Vector2(fighter.prev_pos)
                fighter.pos += self.prediction_offset
                # Remote fighters interpolate over a tick. The local fighter can
                # display its latest position immediately, plus visual prediction.
                fighter.prev_pos.update(fighter.pos)
            try:
                runtime._draw_output(screen, font)
            finally:
                if fighter is not None:
                    fighter.pos.update(previous_pos)
                    fighter.prev_pos.update(previous_last_pos)
                # Visual interpolation must never feed back into the synchronized state.
                runtime.camera_view = view
                runtime.camera_target_view = target
                runtime.accumulator = 0

    client = BrowserClient("", "")

    async def join_after_start(game):
        while pygame.display.get_surface() is None and not game.done():
            await asyncio.sleep(0)
        if not game.done():
            client._start_connect("join")

    game = asyncio.create_task(client.run())
    await join_after_start(game)
    await game
