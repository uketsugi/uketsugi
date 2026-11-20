"""T11: a staff report of channels about to expire and channels with notes."""
import re

import pytest

from conftest import NETWORK, OPER_HASH, body_of, mail_config, make_account, oper_up, register_channel, subject_of, wait_for
from harness import Server

RFC3339 = re.compile(r"\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\b")
FORMATTING = re.compile(r"\x03\d{0,2}(?:,\d{1,2})?|[\x02\x0f\x16\x1d\x1f\x1e\x11]")
PERIODS = {"channels.registration.expire-after": "40s", "channels.registration.expire-warning": "30s"}  # in the warning period from 10 s of disuse
LAST_USED = re.compile(r"ast used.*?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)")


def chanserv(c, text):
    c.cs(text)
    return c.notices_from("ChanServ")


def staff_client(server, nick="carol"):
    c = server.client(nick, register=True)
    oper_up(c)
    return c


def last_used(staff, channel):
    return LAST_USED.search(" ".join(chanserv(staff, f"INFO {channel}"))).group(1)


def listed_as_expiring(staff, *channels):
    lines = chanserv(staff, "REPORT EXPIRING")
    return all(any(l.startswith(c) for l in lines) for c in channels)


@pytest.fixture(scope="module")
def expiring():
    """Two channels in the warning period, one fresh with a note; nobody is in any of them (a channel someone with an account is in is in use).
    Yields the server, the staff client and the lines of REPORT. Nothing here waits for a time: #Two is made to be used a second later than #One
    (the report shows seconds) by joining it until INFO says so, and #Fresh is made once the report lists #One and #Two as expiring, so that it
    is 10 s short of the warning period when the report is read."""
    s = Server({"opers.admin.password": OPER_HASH, **PERIODS})
    staff = staff_client(s)
    alice, bob, dave = (s.client(n, register=True) for n in ("alice", "bob", "dave"))
    for founder, channel in ((alice, "#One"), (bob, "#Two")):
        register_channel(founder, channel)
        founder.send(f"PART {channel}")
        founder.collect()

    def later():
        bob.join("#Two")
        bob.send("PART #Two")
        return last_used(staff, "#Two") > last_used(staff, "#One")

    wait_for(later, "#Two was last used later than #One")
    wait_for(lambda: listed_as_expiring(staff, "#One", "#Two"), "REPORT EXPIRING lists #One and #Two")
    register_channel(dave, "#Fresh")
    chanserv(dave, "NOTE #Fresh ADD about the newcomer")
    dave.send("PART #Fresh")
    dave.collect()
    yield s, staff, chanserv(staff, "REPORT")
    s.close()


def test_the_report_lists_expiring_channels_soonest_first_with_their_founders(expiring):
    s, staff, report = expiring
    one = [l for l in report if l.startswith("#One")]
    two = [l for l in report if l.startswith("#Two")]
    assert one and two and "alice" in one[0] and "bob" in two[0], report
    assert report.index(one[0]) < report.index(two[0])
    only = chanserv(staff, "REPORT EXPIRING")
    assert any(l.startswith("#One") for l in only) and not any(l.startswith("#Fresh") for l in only), only


def test_the_report_lists_channels_with_notes_and_the_newest_note(expiring):
    s, staff, report = expiring
    (fresh,) = [l for l in report if l.startswith("#Fresh")]
    assert "dave" in fresh and "about the newcomer" in fresh, report


def test_the_report_dates_are_rfc3339(expiring):
    # D1
    s, staff, report = expiring
    for channel in ("#One", "#Two", "#Fresh"):
        (line,) = [l for l in report if l.startswith(channel)]
        assert RFC3339.search(line), report
    assert RFC3339.search([l for l in report if l.startswith("#One")][0]).group(0) < RFC3339.search([l for l in report if l.startswith("#Two")][0]).group(0)


def test_the_report_says_which_periods_are_in_use(server):
    # D5: the board's 90 days and 14 days
    staff = staff_client(server)
    text = " ".join(chanserv(staff, "REPORT"))
    assert "90 days" in text and "14 days" in text and "60 days" not in text, text


def test_only_staff_may_ask(server):
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    chanserv(founder, "NOTE #Lobby ADD private")
    for text in ("REPORT", "REPORT EXPIRING", "REPORT NOTE #Lobby sneaky"):
        got = chanserv(founder, text)
        assert not any("#Lobby" in l and "private" in l for l in got), got
    assert not any("sneaky" in l for l in chanserv(founder, "NOTE #Lobby LIST"))


def test_a_long_note_is_shown_whole_in_the_report(server):
    # K-PF1: 154 CJK characters are 462 bytes, more than fits on a line with ChanServ's prefix and the channel's details
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    staff = staff_client(server)
    text = "".join(chr(0x4e00 + i) for i in range(154))
    chanserv(staff, f"REPORT NOTE #Lobby {text}")
    shown = "".join(chanserv(staff, "REPORT"))
    assert text[:10] in shown and text[-10:] in shown, "the end of the note was cut"


def test_report_note_adds_a_note_and_tells_the_other_operators(server):
    # D2: every use of a staff-only command sends `STAFF <account> <COMMAND> <#channel>`
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    staff, watcher = staff_client(server), staff_client(server, "dave")
    watcher.send("MODE dave +s j")
    watcher.collect()
    chanserv(staff, "REPORT NOTE #Lobby reviewed in the report")
    assert any("reviewed in the report" in l for l in chanserv(founder, "NOTE #Lobby LIST"))
    seen = [FORMATTING.sub("", m.text) for m in watcher.collect() if m.command == "NOTICE"]
    assert any(re.search(r"STAFF carol REPORT( NOTE)? #Lobby", t) for t in seen), seen


def report_mailed(relay):
    """Two operators, each logged in to an account with an address, are online when one of them asks for the report by mail."""
    s = Server({"opers.admin.password": OPER_HASH, **mail_config(relay)})
    admin = s.client("admin1")
    oper_up(admin)
    for name in ("alice", "carol", "dave"):
        make_account(admin, name, f"{name}@example.net")
    alice = s.client("alice_c", account="alice")
    register_channel(alice, "#Lobby")
    chanserv(alice, "NOTE #Lobby ADD the secret detail")
    carol, dave = s.client("carol_c", account="carol"), s.client("dave_c", account="dave")
    oper_up(carol)
    oper_up(dave)
    carol.cs("REPORT MAIL")
    carol.expect(lambda m: "Mailing the report to 2 operators" in m.text, what="the server counting both operators")
    s.online = [alice, carol, dave]  # they stay connected: the server mails the operators it finds online, and a client that goes out of scope is closed
    return s


def both_operators_mailed(relay):
    return {m["to"][0] for m in relay.delivered} >= {"carol@example.net", "dave@example.net"}


def test_report_mail_goes_to_every_operator_without_the_notes(relay):
    # D4: the subject starts with the network's name in square brackets and the last line is the signature
    s = report_mailed(relay)
    try:
        wait_for(lambda: both_operators_mailed(relay), "a mail to each operator", relay)
        for mail in relay.delivered:
            assert subject_of(mail).startswith(f"[{NETWORK}] ")
            assert body_of(mail).rstrip("\r\n").splitlines()[-1] == f"-- {NETWORK} staff"
            assert "#Lobby" in body_of(mail) and "secret detail" not in mail["raw"]
    finally:
        s.close()


def test_report_mail_through_a_greylisting_relay(grey_relay):
    # D7: the relay refuses the first attempt for a new sender and recipient with a 451 and wants a retry after two seconds
    s = report_mailed(grey_relay)
    try:
        wait_for(lambda: both_operators_mailed(grey_relay), "a mail to each operator, through the greylisting", grey_relay)
    finally:
        s.close()


def test_report_mail_through_a_relay_that_holds_unmarked_mail(strict_relay):
    # D10: the relay accepts machine mail without Auto-Submitted: auto-generated and never delivers it
    s = report_mailed(strict_relay)
    try:
        wait_for(lambda: both_operators_mailed(strict_relay), "a mail to each operator, delivered and not held", strict_relay)
    finally:
        s.close()


def test_a_note_added_with_report_keeps_its_spacing(server):
    # D12
    founder = server.client("alice", register=True)
    register_channel(founder, "#Lobby")
    staff = staff_client(server)
    chanserv(staff, "REPORT NOTE #Lobby a  b   c")
    assert any(l.endswith(": a  b   c") for l in chanserv(founder, "NOTE #Lobby LIST")), "the spacing of the note was lost"


def test_the_report_shows_founders_as_registered(server):
    # D13: the account's name as it was registered (Alice), not the case-folded form ergo keeps for comparing (alice)
    founder = server.client("Alice", register=True)
    register_channel(founder, "#Lobby")
    chanserv(founder, "NOTE #Lobby ADD about something")
    staff = staff_client(server)
    (line,) = [l for l in chanserv(staff, "REPORT") if l.startswith("#Lobby")]
    assert "Alice" in line, line
