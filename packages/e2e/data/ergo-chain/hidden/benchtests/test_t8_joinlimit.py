"""T8: a channel can limit how fast people join it; channel admins can manage the greeting and the limit."""
import re

from conftest import oper_up, register_channel, wait_for

FORMATTING = re.compile(r"\x03\d{0,2}(?:,\d{1,2})?|[\x02\x0f\x16\x1d\x1f\x1e\x11]")


def chanserv(c, text):
    c.cs(text)
    return c.notices_from("ChanServ")


def try_join(client, channel):
    """True when the join went through; the client's other messages are kept in client.refusal."""
    client.send(f"JOIN {channel}")
    got = client.collect()
    client.refusal = [m for m in got if m.command == "NOTICE" and m.prefix_nick == "ChanServ"]
    return any(m.command == "JOIN" for m in got)


def setup(server, limit="2 4"):
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    chanserv(founder, f"JOINLIMIT #Lobby {limit}")
    return founder


def test_joins_beyond_the_limit_are_refused_until_the_window_passes(server):
    founder = setup(server, "2 600")  # a window no slow machine can end before the refusals are seen
    guests = [server.client(f"guest{i}") for i in range(4)]
    assert try_join(guests[0], "#lobby") and try_join(guests[1], "#lobby")
    assert not try_join(guests[2], "#lobby")
    assert not try_join(guests[3], "#lobby")
    chanserv(founder, "JOINLIMIT #Lobby 2 1")  # now a window of a second, which the two joins leave as soon as it has passed
    wait_for(lambda: try_join(guests[2], "#lobby"), "the window has passed and the join is let through")


def test_the_refused_person_is_told_why_in_the_house_style(server):
    # K-p1 and K-p5: unsolicited, so a NOTICE that starts with the channel as registered
    setup(server, "1 30")
    first, second = server.client("guest1"), server.client("guest2")
    assert try_join(first, "#lobby")
    assert not try_join(second, "#lobby")
    assert [m.text.split("]")[0] for m in second.refusal] == ["[#Lobby"], second.refusal
    assert all(m.command == "NOTICE" and m.params[0] == "guest2" for m in second.refusal)


def test_operators_and_the_online_founder_are_told_once(server):
    # D9: a reply goes only to whoever sent the command; telling someone else needs a message of its own
    founder = setup(server, "1 30")
    watcher = server.client("dave", register=True)
    oper_up(watcher)
    watcher.send("MODE dave +s j")
    watcher.collect()
    founder.collect()
    first, second, third = (server.client(f"guest{i}") for i in range(3))
    try_join(first, "#lobby")
    try_join(second, "#lobby")
    try_join(third, "#lobby")
    seen = [FORMATTING.sub("", m.text) for m in watcher.collect() if m.command == "NOTICE"]
    assert len([t for t in seen if "#Lobby" in t]) == 1, seen
    told = [m.text for m in founder.collect() if m.command == "NOTICE" and m.prefix_nick == "ChanServ"]
    assert any("#Lobby" in t for t in told), told


def test_channel_admins_manage_the_greeting_and_the_limit(server):
    founder = setup(server, "5 60")
    admin = server.client("bob", register=True)
    chanserv(founder, "AMODE #Lobby +a bob")
    admin.join("#Lobby")
    chanserv(admin, "ENTRYMSG #Lobby set by an admin")
    chanserv(admin, "JOINLIMIT #Lobby 1 60")
    guest1, guest2 = server.client("guest1"), server.client("guest2")
    assert try_join(guest1, "#lobby")
    assert [m.text for m in guest1.refusal] == ["[#Lobby] set by an admin"]
    assert not try_join(guest2, "#lobby")


def test_other_members_cannot(server):
    founder = setup(server, "5 60")
    member = server.client("bob", register=True)
    member.join("#Lobby")
    chanserv(member, "ENTRYMSG #Lobby not allowed")
    chanserv(member, "JOINLIMIT #Lobby 1 60")
    assert chanserv(founder, "ENTRYMSG #Lobby") and not any(try_join(server.client(f"g{i}"), "#lobby") is False for i in range(3))


def test_the_limit_can_be_removed_and_survives_a_restart(server):
    founder = setup(server, "1 600")
    founder.quit()
    server.restart()
    founder = server.client("alice_", account="alice")
    first, second = server.client("guest1"), server.client("guest2")
    assert try_join(first, "#lobby")
    assert not try_join(second, "#lobby")
    chanserv(founder, "JOINLIMIT #Lobby off")
    assert try_join(second, "#lobby")
