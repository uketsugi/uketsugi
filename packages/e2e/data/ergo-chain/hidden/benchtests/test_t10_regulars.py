"""T10: people whose account joined recently get the welcome-back message instead of the greeting."""
import os
import re
import time

import yaml

from conftest import OPER_HASH, after_window, oper_up, register_channel
from harness import TREE, Server

WINDOW = 3  # seconds
OLD_KEYS = {"enabled", "operator-only", "max-channels-per-account", "greeting-max-length", "notes-max", "note-max-length", "expire-after", "expire-warning"}


def new_keys(config_file):
    registration = yaml.safe_load(open(os.path.join(TREE, config_file)))["channels"]["registration"]
    return {k: v for k, v in registration.items() if k not in OLD_KEYS}


def window_key():
    (key,) = [k for k, v in new_keys("default.yaml").items() if v == "24h"]
    return f"channels.registration.{key}"


def chanserv(c, text):
    c.cs(text)
    return c.notices_from("ChanServ")


def joined(client, channel):
    client.send(f"JOIN {channel}")
    return [m.text for m in client.collect() if m.prefix_nick == "ChanServ"]


def rejoin(client, channel):
    client.send(f"PART {channel}")
    client.collect()
    return joined(client, channel)


def setup(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    chanserv(founder, "ENTRYMSG #Lobby Welcome to the lobby")
    chanserv(founder, "ENTRYMSG #Lobby REGULARS Welcome back")
    return founder


def test_a_regular_gets_the_welcome_back_message_inside_a_long_window():
    # a window no stall can end: this half decides on the server's answer alone
    s = Server({"opers.admin.password": OPER_HASH, window_key(): "1h"})
    try:
        setup(s)
        bob = s.client("bob", register=True)
        assert joined(bob, "#lobby") == ["[#Lobby] Welcome to the lobby"]
        after_window(time.monotonic(), 1)  # at least a second since the join, so that a window of a few milliseconds is not mistaken for a long one
        assert rejoin(bob, "#lobby") == ["[#Lobby] Welcome back"]
    finally:
        s.close()


def test_a_regular_gets_the_greeting_again_once_the_window_has_ended():
    # a short window and a wait for at least that long after the last join: late can only help, so no load can fail a correct server
    s = Server({"opers.admin.password": OPER_HASH, window_key(): f"{WINDOW}s"})
    try:
        setup(s)
        bob = s.client("bob", register=True)
        assert joined(bob, "#lobby") == ["[#Lobby] Welcome to the lobby"]
        after_window(time.monotonic(), WINDOW)
        assert rejoin(bob, "#lobby") == ["[#Lobby] Welcome to the lobby"]
    finally:
        s.close()


def test_the_window_is_a_day_by_default(server):
    setup(server)
    bob = server.client("bob", register=True)
    joined(bob, "#lobby")
    assert rejoin(bob, "#lobby") == ["[#Lobby] Welcome back"]


def test_a_regular_gets_nothing_when_there_is_no_welcome_back_message(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    chanserv(founder, "ENTRYMSG #Lobby Welcome to the lobby")
    bob = server.client("bob", register=True)
    joined(bob, "#lobby")
    assert rejoin(bob, "#lobby") == []


def test_people_without_an_account_always_get_the_greeting(server):
    setup(server)
    guest = server.client("guest1")
    assert joined(guest, "#lobby") == ["[#Lobby] Welcome to the lobby"]
    assert rejoin(guest, "#lobby") == ["[#Lobby] Welcome to the lobby"]


def test_the_welcome_back_message_follows_the_greeting_rules(server):
    founder = setup(server)
    chanserv(founder, "ENTRYMSG #Lobby REGULARS " + "é" * 201)
    chanserv(founder, "ENTRYMSG #Lobby REGULARS " + "é" * 200)
    bob = server.client("bob", register=True)
    joined(bob, "#lobby")
    assert rejoin(bob, "#lobby") == ["[#Lobby] " + "é" * 200]
    other = server.client("carol", register=True)
    other.join("#Lobby")
    chanserv(other, "ENTRYMSG #Lobby REGULARS hijacked")
    staff = server.client("dave", register=True)
    oper_up(staff)
    chanserv(staff, "FREEZE #Lobby dispute")
    chanserv(founder, "ENTRYMSG #Lobby REGULARS during the freeze")
    assert rejoin(bob, "#lobby") == ["[#Lobby] " + "é" * 200]
    chanserv(staff, "ENTRYMSG #Lobby REGULARS set by staff")
    assert rejoin(bob, "#lobby") == ["[#Lobby] set by staff"]


def test_a_long_welcome_back_message_arrives_whole(server):
    founder = setup(server)
    text = "".join(chr(0x4e00 + i) for i in range(154))  # 462 bytes: with ChanServ's prefix and the channel's name more than a line, and still one command
    chanserv(founder, f"ENTRYMSG #Lobby REGULARS {text}")
    bob = server.client("bob", register=True)
    joined(bob, "#lobby")
    assert "".join(t.removeprefix("[#Lobby] ") for t in rejoin(bob, "#lobby")) == text


def test_the_welcome_back_message_survives_a_restart_and_can_be_removed(server):
    founder = setup(server)
    server.wait_stored("Welcome back")
    founder.quit()
    server.restart()
    founder = server.client("alice_", account="alice")
    bob = server.client("bob", register=True)
    joined(bob, "#lobby")
    assert rejoin(bob, "#lobby") == ["[#Lobby] Welcome back"]
    chanserv(founder, "ENTRYMSG #Lobby REGULARS")
    assert rejoin(bob, "#lobby") == []


def test_the_welcome_back_message_is_kept_exactly_as_typed(server):
    # D12: ChanServ splits a command on spaces, so runs of spaces in the text are lost unless the command asks for its last parameter whole
    founder = setup(server)
    chanserv(founder, "ENTRYMSG #Lobby REGULARS ( o  o )   hello   there")
    bob = server.client("bob", register=True)
    joined(bob, "#lobby")
    assert rejoin(bob, "#lobby") == ["[#Lobby] ( o  o )   hello   there"]
