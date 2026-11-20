"""T7: CS INFO says whether a greeting is set, when the channel was last used, when it will expire, and how many notes it has."""
import re
from datetime import datetime, timedelta, timezone

from conftest import oper_up, register_channel, wait_for

RFC3339 = re.compile(r"\b(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\b")


def chanserv(c, text):
    c.cs(text)
    return c.notices_from("ChanServ")


def when(text):
    return datetime.strptime(RFC3339.search(text).group(1), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def setup(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    return founder


def test_info_shows_the_greeting_the_last_use_and_the_expiry(server):
    founder = setup(server)
    chanserv(founder, "ENTRYMSG #Lobby Welcome to the lobby")
    info = chanserv(founder, "INFO #Lobby")
    assert any("Welcome to the lobby" in l and "reeting" in l for l in info), info
    assert any("ast used" in l for l in info) and any("xpire" in l for l in info), info


def test_info_dates_are_rfc3339_in_utc(server):
    # D1: anything new that shows a time uses RFC 3339 in UTC, even with the server in another zone
    founder = setup(server)
    info = chanserv(founder, "INFO #Lobby")
    used = [l for l in info if "ast used" in l]
    expires = [l for l in info if "xpire" in l]
    assert used and expires and RFC3339.search(used[0]) and RFC3339.search(expires[0]), info
    now = datetime.now(timezone.utc)
    assert abs((when(used[0]) - now).total_seconds()) < 120
    assert abs((when(expires[0]) - (now + timedelta(days=60))).total_seconds()) < 120, expires


def test_info_says_when_no_greeting_is_set(server):
    founder = setup(server)
    greeting = [l for l in chanserv(founder, "INFO #Lobby") if "reeting" in l]
    assert len(greeting) == 1 and re.search(r"\b(none|not set|no)\b", greeting[0], re.I), greeting


def test_the_last_use_moves_when_someone_joins(server):
    founder = setup(server)
    first = [l for l in chanserv(founder, "INFO #Lobby") if "ast used" in l]
    visitor = server.client("bob", register=True)
    later = []

    def moved():  # the time is shown to the second: joining and leaving again shows the move as soon as the second has turned
        visitor.join("#Lobby")
        visitor.send("PART #Lobby")
        later[:] = [l for l in chanserv(founder, "INFO #Lobby") if "ast used" in l]
        return later != first

    wait_for(moved, "the time of the last use is later than before")
    assert first and later


def test_a_long_greeting_is_shown_whole(server):
    # D8: 156 CJK characters are 468 bytes, which does not fit on a line with ChanServ's prefix and a label. However INFO labels and splits
    # it, the characters of the greeting must all arrive, in order (the label and the other lines are ASCII)
    founder = setup(server)
    greeting = "".join(chr(0x4e00 + i) for i in range(156))
    chanserv(founder, f"ENTRYMSG #Lobby {greeting}")
    shown = "".join(chanserv(founder, "INFO #Lobby"))
    kept = "".join(c for c in shown if "\u4e00" <= c <= "\u9fff")
    assert kept == greeting, f"{len(kept)} of 156 characters arrived: the end of the greeting was cut"


def test_the_founder_and_staff_see_the_notes_count_and_the_limit(server):
    founder = setup(server)
    chanserv(founder, "NOTE #Lobby ADD one")
    chanserv(founder, "NOTE #Lobby ADD two")
    staff = server.client("carol", register=True)
    oper_up(staff)
    for who in (founder, staff):
        notes = [l for l in chanserv(who, "INFO #Lobby") if "ote" in l]
        assert len(notes) == 1 and re.findall(r"\d+", notes[0]) == ["2", "25"], notes


def test_nobody_else_learns_anything_about_notes(server):
    founder = setup(server)
    other = server.client("bob", register=True)

    def seen_by_other():
        return [re.sub(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", "T", l) for l in chanserv(other, "INFO #Lobby")]

    before = seen_by_other()
    chanserv(founder, "NOTE #Lobby ADD secret")
    after = seen_by_other()
    assert before == after and not any("ote" in l for l in after), (before, after)
