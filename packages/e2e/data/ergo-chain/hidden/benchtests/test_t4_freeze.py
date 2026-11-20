"""T4: network staff freeze a channel during a dispute."""
import re

from conftest import oper_up, register_channel

RFC3339 = re.compile(r"\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\b")
FORMATTING = re.compile(r"\x03\d{0,2}(?:,\d{1,2})?|[\x02\x0f\x16\x1d\x1f\x1e\x11]")


def chanserv(c, text):
    c.cs(text)
    return c.notices_from("ChanServ")


def greeting_seen_by(server, nick, channel):
    guest = server.client(nick)
    guest.send(f"JOIN {channel}")
    return [m.text for m in guest.collect() if m.prefix_nick == "ChanServ"]


def setup(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    chanserv(founder, "ENTRYMSG #Lobby before the dispute")
    staff = server.client("carol", register=True)
    oper_up(staff)
    return founder, staff


def test_frozen_channel_refuses_its_founder_but_not_staff(server):
    founder, staff = setup(server)
    chanserv(staff, "FREEZE #Lobby ownership dispute, ticket 4411")
    chanserv(founder, "ENTRYMSG #Lobby changed during the dispute")
    chanserv(founder, "NOTE #Lobby ADD founder note while frozen")
    assert greeting_seen_by(server, "guest1", "#lobby") == ["[#Lobby] before the dispute"]
    assert not any("founder note while frozen" in l for l in chanserv(founder, "NOTE #Lobby LIST"))
    chanserv(staff, "ENTRYMSG #Lobby set by staff while frozen")
    assert greeting_seen_by(server, "guest2", "#lobby") == ["[#Lobby] set by staff while frozen"]
    chanserv(staff, "UNFREEZE #Lobby")
    chanserv(founder, "ENTRYMSG #Lobby after the dispute")
    assert greeting_seen_by(server, "guest3", "#lobby") == ["[#Lobby] after the dispute"]


def test_only_staff_can_freeze(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    chanserv(founder, "FREEZE #lobby i want to")
    chanserv(founder, "ENTRYMSG #lobby still mine")
    assert greeting_seen_by(server, "guest1", "#lobby") == ["[#lobby] still mine"]


def test_other_operators_are_told(server):
    # K-D2: every use of a staff-only command sends `STAFF <account> <COMMAND> <#channel>` on the channels mask
    founder, staff = setup(server)
    watcher = server.client("dave", register=True)
    oper_up(watcher)
    watcher.send("MODE dave +s j")
    watcher.collect()
    chanserv(staff, "FREEZE #Lobby ownership dispute")
    chanserv(staff, "UNFREEZE #Lobby")
    seen = [FORMATTING.sub("", m.text) for m in watcher.collect() if m.command == "NOTICE"]
    assert any("STAFF carol FREEZE #Lobby" in t for t in seen), seen
    assert any("STAFF carol UNFREEZE #Lobby" in t for t in seen), seen


def test_info_says_since_when_in_rfc3339(server):
    # K-D1: anything new that shows a time uses RFC 3339 in UTC
    founder, staff = setup(server)
    chanserv(staff, "FREEZE #Lobby ownership dispute")
    info = chanserv(founder, "INFO #Lobby")
    new = [l for l in info if "dispute" in l or "rozen" in l]
    assert new and any(RFC3339.search(l) for l in new), info


def test_founders_are_not_told_which_staff_member(server):
    # K-D3: what tells a founder about an action by staff names them only as "network staff"
    founder, staff = setup(server)
    chanserv(staff, "FREEZE #Lobby ownership dispute")
    seen = chanserv(founder, "INFO #Lobby") + chanserv(founder, "ENTRYMSG #Lobby try anyway")
    assert not any("carol" in l.lower() for l in seen), seen


def test_freeze_survives_a_restart(server):
    founder, staff = setup(server)
    chanserv(staff, "FREEZE #Lobby ownership dispute")
    founder.quit()
    staff.quit()
    server.restart()
    founder = server.client("alice_", account="alice")
    chanserv(founder, "ENTRYMSG #Lobby after the restart")
    assert greeting_seen_by(server, "guest1", "#lobby") == ["[#Lobby] before the dispute"]


def test_a_long_reason_is_shown_whole(server):
    # K-PF1, needed here: a reason of 440 characters does not fit on one line once ChanServ's prefix is added; the server cuts it
    founder, staff = setup(server)
    reason = " ".join(f"w{i:03d}" for i in range(88))  # 88 words, 439 characters, ending in w087
    chanserv(staff, f"FREEZE #Lobby {reason}")
    shown = " ".join(chanserv(founder, "INFO #Lobby"))
    assert "w000" in shown and "w087" in shown, "the end of the reason was cut"
    assert all(f"w{i:03d}" in shown for i in range(88))
