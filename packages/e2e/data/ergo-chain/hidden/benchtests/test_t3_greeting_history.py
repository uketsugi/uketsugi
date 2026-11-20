"""T3: the history of a channel's greeting."""
import re

from conftest import oper_up, register_channel

RFC3339 = re.compile(r"\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\b")


def history(c, channel):
    c.cs(f"ENTRYMSG {channel} HISTORY")
    return c.notices_from("ChanServ")


def greet(c, channel, text=""):
    c.cs(f"ENTRYMSG {channel} {text}".rstrip())
    c.collect()


def lines_with(lines, text):
    return [i for i, l in enumerate(lines) if text in l]


def test_newest_first_with_who_and_what(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    greet(founder, "#lobby", "first greeting")
    greet(founder, "#lobby", "second greeting")
    greet(founder, "#lobby")
    lines = history(founder, "#lobby")
    first, second = lines_with(lines, "first greeting"), lines_with(lines, "second greeting")
    assert len(first) == 1 and len(second) == 1 and second[0] < first[0]
    removed = [i for i, l in enumerate(lines) if "alice" in l and i < second[0]]
    assert removed, "the removal, newest, comes first and names who did it"
    assert all("alice" in lines[i] for i in first + second)


def test_new_output_uses_rfc3339(server):
    # K-D1: anything new that shows a time uses RFC 3339 in UTC (the notes list keeps its own format)
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    greet(founder, "#lobby", "hello there")
    line = history(founder, "#lobby")[lines_with(history(founder, "#lobby"), "hello there")[0]]
    assert RFC3339.search(line), f"no RFC 3339 time in {line!r}"


def test_founders_see_staff_as_network_staff(server):
    # K-D3: what tells a founder about an action by staff names them only as "network staff"
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    staff = server.client("carol", register=True)
    oper_up(staff)
    greet(staff, "#lobby", "set by the staff")
    line = [l for l in history(founder, "#lobby") if "set by the staff" in l]
    assert len(line) == 1 and "carol" not in line[0].lower() and "network staff" in line[0]


def test_only_founder_and_staff_see_it(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    greet(founder, "#lobby", "private greeting text")
    staff = server.client("carol", register=True)
    oper_up(staff)
    assert lines_with(history(staff, "#lobby"), "private greeting text")
    outsider = server.client("bob", register=True)
    assert not lines_with(history(outsider, "#lobby"), "private greeting text")


def test_keeps_the_last_ten_and_survives_a_restart(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    for i in range(12):
        greet(founder, "#lobby", f"greeting number {i:02d}")
    server.wait_stored("greeting number 11")
    founder.quit()
    server.restart()
    founder = server.client("alice_", account="alice")
    lines = history(founder, "#lobby")
    kept = sorted(int(m) for l in lines for m in re.findall(r"greeting number (\d\d)", l))
    assert kept == list(range(2, 12))
