"""Keep map drawing within the browser's frame budget."""

from math import sqrt
from time import monotonic

import pygame


MIN_STAGE_WIDTH = 520
SLOW_STAGE_SECONDS = 0.018
TARGET_STAGE_SECONDS = 0.011
SLOW_FRAME_LIMIT = 3


class StageRenderBudget:
    def __init__(self, draw_stage):
        self.draw_stage = draw_stage
        self.viewport_size = None
        self.stage_width = 0
        self.slow_frames = 0
        self.last_scene = None
        self.output = None

    def __call__(self, camera, zoom, viewport):
        if viewport.size != self.viewport_size:
            self.viewport_size = viewport.size
            self.stage_width = viewport.w
            self.slow_frames = 0
            self.last_scene = None
            self.output = None

        started = monotonic()
        if self.stage_width == viewport.w:
            scene = self.draw_stage(camera, zoom, viewport)
            result = scene
        else:
            ratio = self.stage_width / viewport.w
            stage_view = pygame.Rect(0, 0, self.stage_width, max(1, round(viewport.h * ratio)))
            scene = self.draw_stage(camera, zoom * ratio, stage_view)
            if scene is not self.last_scene:
                if self.output is None:
                    self.output = pygame.transform.scale(scene, viewport.size)
                else:
                    pygame.transform.scale(scene, viewport.size, self.output)
            result = self.output

        if scene is not self.last_scene:
            elapsed = monotonic() - started
            self.last_scene = scene
            self.slow_frames = self.slow_frames + 1 if elapsed > SLOW_STAGE_SECONDS else 0
            if self.slow_frames >= SLOW_FRAME_LIMIT and self.stage_width > MIN_STAGE_WIDTH:
                # A cached, stationary scene is cheap. Keep this budget until the
                # viewport changes so starting to move again won't trigger a stall.
                ratio = min(0.85, sqrt(TARGET_STAGE_SECONDS / elapsed))
                self.stage_width = max(MIN_STAGE_WIDTH, round(self.stage_width * ratio))
                self.slow_frames = 0

        return result
