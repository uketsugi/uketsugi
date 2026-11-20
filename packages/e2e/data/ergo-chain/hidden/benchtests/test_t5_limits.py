"""T5: the greeting, note-count and note-length limits move into channels.registration in the configuration."""
import os

import yaml

from conftest import OPER_HASH, register_channel
from harness import REMOVE, TREE, Server

OLD_KEYS = {"enabled", "operator-only", "max-channels-per-account"}
DEFAULTS = {200, 25, 300}  # greeting, notes, note length


def new_keys(config_file):
    registration = yaml.safe_load(open(os.path.join(TREE, config_file)))["channels"]["registration"]
    return {k: v for k, v in registration.items() if k not in OLD_KEYS}


def key_with(value, config_file="default.yaml"):
    (key,) = [k for k, v in new_keys(config_file).items() if v == value]
    return f"channels.registration.{key}"


def chanserv(c, text):
    c.cs(text)
    return c.notices_from("ChanServ")


def greeting_of(server, channel, nick):
    guest = server.client(nick)
    guest.send(f"JOIN {channel}")
    return [m.text for m in guest.collect() if m.prefix_nick == "ChanServ"]


def check_limits(server, greeting, notes, note_length):
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    chanserv(founder, f"ENTRYMSG #lobby {'g' * greeting}")
    assert greeting_of(server, "#lobby", "guest1") == [f"[#lobby] {'g' * greeting}"]
    chanserv(founder, f"ENTRYMSG #lobby {'h' * (greeting + 1)}")
    assert greeting_of(server, "#lobby", "guest2") == [f"[#lobby] {'g' * greeting}"], "a greeting over the limit was accepted"
    chanserv(founder, f"NOTE #lobby ADD {'n' * (note_length + 1)}")
    assert not [l for l in chanserv(founder, "NOTE #lobby LIST") if "nnn" in l], "a note over the limit was accepted"
    chanserv(founder, f"NOTE #lobby ADD {'n' * note_length}")
    for i in range(notes - 1):
        chanserv(founder, f"NOTE #lobby ADD note {i}")
    chanserv(founder, "NOTE #lobby ADD one too many")
    listed = chanserv(founder, "NOTE #lobby LIST")
    assert len(listed) == notes and not any("one too many" in l for l in listed), listed


def test_the_defaults_without_editing_an_existing_configuration():
    # F4: a configuration written for the earlier release has none of the new keys and must still get the defaults
    keys = [key_with(v) for v in sorted(DEFAULTS)]
    s = Server({"opers.admin.password": OPER_HASH, **{k: REMOVE for k in keys}})
    try:
        check_limits(s, 200, 25, 300)
    finally:
        s.close()


def test_the_limits_follow_the_configuration():
    s = Server({"opers.admin.password": OPER_HASH, key_with(200): 12, key_with(25): 3, key_with(300): 20})
    try:
        check_limits(s, 12, 3, 20)
    finally:
        s.close()


def test_both_sample_configurations_carry_the_new_keys():
    # F5: the same keys, with the defaults, in default.yaml and traditional.yaml
    a, b = new_keys("default.yaml"), new_keys("traditional.yaml")
    assert set(a.values()) == DEFAULTS and len(a) == 3, a
    assert a == b, (a, b)


def test_the_traditional_configuration_runs_with_the_defaults():
    s = Server({"opers.admin.password": OPER_HASH}, config_file="traditional.yaml")
    try:
        check_limits(s, 200, 25, 300)
    finally:
        s.close()
