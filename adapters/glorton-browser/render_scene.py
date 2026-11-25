"""Faster composition for static stages in the installed browser renderer."""

import pygame


class StageBlitter:
    def __init__(self, surface):
        self.surface = surface

    def blit(self, source, position):
        return self.surface.blit(source, position, special_flags=pygame.BLEND_ALPHA_SDL2)


def install_stage_renderer(runtime):
    stage = runtime.stage
    # Animated stages benefit from the upstream independent layer caches.
    if stage.helicopter_frames or stage.dynamic_frames or stage.background_layers or stage.background_object_layers:
        return

    cached_key = None
    cached_scene = None

    def draw(cam, zoom, viewport):
        nonlocal cached_key, cached_scene
        key = (viewport.size, round(cam.x * zoom, 3), round(cam.y * zoom, 3), round(zoom, 6))
        if key == cached_key:
            return cached_scene

        # Both layers can blend straight into an opaque scene on a static map.
        # SDL2's accelerated alpha rounding can differ by one channel value.
        scene = pygame.Surface(viewport.size).convert()
        local = scene.get_rect()
        target = StageBlitter(scene)
        runtime._draw_sky_backdrop(scene, local)
        runtime._draw_background(target, cam, zoom, local)
        if stage.foreground is not None:
            runtime._draw_world_surface_clipped(
                target, stage.foreground, stage.foreground_offset, cam, zoom, local,
                source_scale=stage.foreground_scale,
            )
        cached_key = key
        cached_scene = scene
        return scene

    runtime._stage_scene = draw
