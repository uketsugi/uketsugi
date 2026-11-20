"""T2: staff notes on a registered channel."""
import datetime
import re

from conftest import oper_up, register_channel

LINE = re.compile(r"^#(\d+) (\d{4}-\d\d-\d\d \d\d:\d\d) UTC (\S+): (.*)$")
# Every test but the one about the time format reads lines loosely, so that each item fails in one test only:
# number, anything, the author, a colon, the text.
LOOSE = re.compile(r"^#(\d+) (.*?) (\S+): (.*)$")


def raw_notes(c, channel):
    c.cs(f"NOTE {channel} LIST")
    return [t for t in c.notices_from("ChanServ") if t.startswith("#")]


def notes(c, channel):
    return [LOOSE.match(t) for t in raw_notes(c, channel)]


def add(c, channel, text):
    c.cs(f"NOTE {channel} ADD {text}")
    return c.notices_from("ChanServ")


def test_list_is_newest_first(server):
    # K-p3 (lists newest first)
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    for text in ("first one", "second one", "third one"):
        add(founder, "#lobby", text)
    rows = notes(founder, "#lobby")
    assert [(r[1], r[3], r[4]) for r in rows] == [("3", "alice", "third one"), ("2", "alice", "second one"), ("1", "alice", "first one")]


def test_times_are_written_the_network_way(server):
    # K-p2 (times as "YYYY-MM-DD HH:MM UTC")
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    add(founder, "#lobby", "a note")
    rows = [LINE.match(t) for t in raw_notes(founder, "#lobby")]
    assert len(rows) == 1 and rows[0], "a LIST line must read: #<n> <YYYY-MM-DD HH:MM> UTC <account>: <text>"
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    assert abs((datetime.datetime.strptime(rows[0][2], "%Y-%m-%d %H:%M") - now).total_seconds()) < 120


def test_staff_can_use_notes_and_others_learn_nothing(server):
    # K-p9 (someone without the right gets the same answer whether or not there is anything to see)
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    register_channel(founder, "#empty")
    staff = server.client("carol", register=True)
    oper_up(staff)
    add(staff, "#lobby", "spam wave from 10.0.0.0/8")
    assert [(r[3], r[4]) for r in notes(founder, "#lobby")] == [("carol", "spam wave from 10.0.0.0/8")]
    outsider = server.client("bob", register=True)
    outsider.cs("NOTE #lobby LIST")
    with_notes = outsider.notices_from("ChanServ")
    outsider.cs("NOTE #empty LIST")
    without_notes = outsider.notices_from("ChanServ")
    assert with_notes == [t.replace("#empty", "#lobby") for t in without_notes]
    assert not any("spam wave" in t for t in with_notes)
    add(outsider, "#lobby", "outsider note")
    assert [r[4] for r in notes(founder, "#lobby")] == ["spam wave from 10.0.0.0/8"]


def test_delete_keeps_the_other_numbers(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    for text in ("a", "b", "c"):
        add(founder, "#lobby", text)
    founder.cs("NOTE #lobby DEL 2")
    founder.collect()
    add(founder, "#lobby", "d")
    assert [(r[1], r[4]) for r in notes(founder, "#lobby")] == [("4", "d"), ("3", "c"), ("1", "a")]


def test_at_most_ten_notes(server):
    # K-r1, as first decided: ten notes a channel (T3 changes it)
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    for i in range(11):
        add(founder, "#lobby", f"note {i}")
    rows = notes(founder, "#lobby")
    assert len(rows) == 10 and rows[0][4] == "note 9"


def test_notes_survive_a_restart(server):
    # K-f1, K-f2
    founder = server.client("alice", register=True)
    register_channel(founder, "#lobby")
    add(founder, "#lobby", "remember me")
    founder.quit()
    server.restart()
    founder = server.client("alice_", account="alice")
    assert [r[4] for r in notes(founder, "#lobby")] == ["remember me"]
