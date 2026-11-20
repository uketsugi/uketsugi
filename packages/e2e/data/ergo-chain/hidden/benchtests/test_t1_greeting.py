"""T1: a greeting that ChanServ sends to people joining a registered channel."""
from conftest import oper_up, register_channel


def chanserv_notices(c):
    return [m for m in c.collect() if m.prefix_nick == "ChanServ" and m.command in ("NOTICE", "PRIVMSG")]


def set_greeting(c, channel, text=""):
    c.cs(f"ENTRYMSG {channel} {text}".rstrip())
    return c.notices_from("ChanServ")


def test_greeting_is_a_chanserv_notice_with_the_channel_as_registered(server):
    # K-p1 (unsolicited ChanServ messages: NOTICE, "[#Channel] " first), K-p5 (the name as registered)
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    set_greeting(founder, "#Lobby", "Welcome to the lobby, be kind")
    guest = server.client("guest1")
    guest.send("JOIN #lobby")
    got = chanserv_notices(guest)
    assert [(m.command, m.params[0], m.text) for m in got] == [("NOTICE", "guest1", "[#Lobby] Welcome to the lobby, be kind")]


def test_only_the_founder_or_staff_can_change_it(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    set_greeting(founder, "#lobby", "hello")
    other = server.client("bob", register=True)
    other.join("#lobby")
    other.collect()
    set_greeting(other, "#lobby", "pwned")
    staff = server.client("carol", register=True)
    oper_up(staff)
    guest = server.client("guest1")
    guest.send("JOIN #lobby")
    assert [m.text for m in chanserv_notices(guest)] == ["[#lobby] hello"]
    set_greeting(staff, "#lobby", "set by staff")
    guest2 = server.client("guest2")
    guest2.send("JOIN #lobby")
    assert [m.text for m in chanserv_notices(guest2)] == ["[#lobby] set by staff"]


def greeting_seen(guest, channel):
    """What the joiner is shown, however many notices the greeting came in, each one starting with the channel as registered."""
    guest.send(f"JOIN {channel}")
    parts = [m.text for m in chanserv_notices(guest)]
    lead = f"[{channel}] "
    assert all(p.startswith(lead) for p in parts), parts
    return "".join(p[len(lead):] for p in parts)


def test_length_is_counted_in_characters(server):
    # K-p8: at most 200 characters, counted as characters and not bytes; longer is refused, not cut. 200 accented letters are 400 bytes,
    # so they may come in one notice or in several: what counts is that all of them arrive and that 201 do not replace them
    founder = server.client("alice", register=True)
    register_channel(founder, "#cafe")
    accented = "é" * 200
    set_greeting(founder, "#cafe", accented)
    assert greeting_seen(server.client("guest1"), "#cafe") == accented
    set_greeting(founder, "#cafe", "x" * 201)
    assert greeting_seen(server.client("guest2"), "#cafe") == accented


def test_removing_the_greeting(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    set_greeting(founder, "#lobby", "hello")
    set_greeting(founder, "#lobby")
    guest = server.client("guest1")
    guest.send("JOIN #lobby")
    assert chanserv_notices(guest) == []


def test_greeting_survives_a_restart(server):
    # K-f1 (a new registration field is written and read back), K-f2 (the change marks the channel for writing)
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    set_greeting(founder, "#Lobby", "still here")
    founder.quit()
    server.restart()
    guest = server.client("guest1")
    guest.send("JOIN #Lobby")
    assert [m.text for m in chanserv_notices(guest)] == ["[#Lobby] still here"]


def test_a_long_greeting_arrives_whole(server):
    # K-PF1, met here: the server cuts every line it sends at 512 bytes. 156 CJK characters (468 bytes) fit in the command that sets them
    # but not in ChanServ's NOTICE once its prefix is added, so the greeting must go out as several notices
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    long = "漢" * 156
    set_greeting(founder, "#Lobby", long)
    guest = server.client("guest1")
    guest.send("JOIN #Lobby")
    parts = [m.text for m in chanserv_notices(guest)]
    assert parts and all(p.startswith("[#Lobby] ") for p in parts)
    assert "".join(p[len("[#Lobby] "):] for p in parts).replace(" ", "") == long
