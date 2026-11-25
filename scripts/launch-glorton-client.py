import argparse
import asyncio
import os
from pathlib import Path
import re
import runpy
import sys
from urllib.parse import parse_qs, urlsplit, urlunsplit


DEFAULT_SERVER = "ws://127.0.0.1:8765/ws"
LOBBY_SOCKET = "/glorton-online/ws"
ROOM_CODE = re.compile(r"[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}", re.IGNORECASE | re.ASCII)


def room_code(value):
    code = value.strip()
    if not ROOM_CODE.fullmatch(code):
        raise argparse.ArgumentTypeError("room codes contain six letters or digits (without I, O, 0, or 1)")
    return code.upper()


def lobby_invite(value):
    try:
        invite = urlsplit(value)
        origin = invite.netloc
        port = invite.port
        if (invite.scheme not in {"http", "https"} or not invite.hostname or
                invite.username is not None or invite.password is not None or port == 0 or
                re.search(r"[\s\\\x00-\x1f\x7f]", value)):
            raise ValueError
        target, = parse_qs(invite.query, keep_blank_values=True, max_num_fields=32)["glorton"]
    except (KeyError, ValueError):
        raise argparse.ArgumentTypeError("expected a lobby URL with one ?glorton=ROOMCODE or ?glorton=host") from None
    server = urlunsplit(("wss" if invite.scheme == "https" else "ws", origin, LOBBY_SOCKET, "", ""))
    return server, None if target.lower() == "host" else room_code(target)


def initialize_windows_fonts():
    if sys.platform != "win32":
        return

    from pygame import sysfont

    try:
        sysfont.initsysfonts()
    except TypeError as error:
        if "os.PathLike" not in str(error) or "not int" not in str(error):
            raise
        font_dir = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
        arial = {}
        for style, filename in {
            (False, False): "arial.ttf",
            (True, False): "arialbd.ttf",
            (False, True): "ariali.ttf",
            (True, True): "arialbi.ttf",
        }.items():
            path = font_dir / filename
            if path.is_file():
                arial[style] = str(path)
        if arial:
            sysfont.Sysfonts["arial"] = arial
        sysfont.create_aliases()
        sysfont.is_init = True
        print("Pygame: using fallback fonts for this Glorton process.", file=sys.stderr)


async def queue_lobby_keys(pygame, running_client, code):
    while pygame.display.get_surface() is None:
        await asyncio.wait((running_client,), timeout=0.025)
        if running_client.done():
            return

    def keydown(key, character):
        pygame.event.post(pygame.event.Event(pygame.KEYDOWN, key=key, unicode=character))

    if code is None:
        keydown(pygame.K_c, "c")
    else:
        keydown(pygame.K_j, "j")
        for character in code.lower():
            keydown(pygame.key.key_code(character), character)
        keydown(pygame.K_RETURN, "\r")


def launch_handoff(code):
    import pygame
    from online import client as upstream

    # Follow the release's normal create/join keyboard flow and startup checks.
    class LobbyClient(upstream.OnlineGameClient):
        async def run(self):
            async with asyncio.TaskGroup() as tasks:
                play = tasks.create_task(super().run())
                tasks.create_task(queue_lobby_keys(pygame, play, code))

    upstream.OnlineGameClient = LobbyClient
    upstream.main()


def main():
    parser = argparse.ArgumentParser(description="Launch an installed Glorton desktop release on Windows")
    parser.add_argument("release", type=Path, help="Folder containing the installed upstream release")
    parser.add_argument("--server", help=f"WebSocket server (default: {DEFAULT_SERVER})")
    parser.add_argument("--name", default="Player")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--invite", type=lobby_invite, help="Lobby invite or host URL")
    actions.add_argument("--room", type=room_code, help="Join a room by its six-character code")
    actions.add_argument("--create-room", action="store_true", help="Create a room on startup")
    options = parser.parse_args()
    if options.invite and options.server is not None:
        parser.error("--invite already specifies the server")
    release = options.release.resolve()
    if not (release / "online" / "client.py").is_file():
        parser.error("release must contain online/client.py")

    server, code = options.invite or (options.server or DEFAULT_SERVER, options.room)
    sys.path.insert(0, str(release))
    os.chdir(release)
    initialize_windows_fonts()
    sys.argv = ["online.client", "--server", server, "--name", options.name]
    if options.invite or options.room or options.create_room:
        launch_handoff(code)
    else:
        runpy.run_module("online.client", run_name="__main__")


if __name__ == "__main__":
    main()
