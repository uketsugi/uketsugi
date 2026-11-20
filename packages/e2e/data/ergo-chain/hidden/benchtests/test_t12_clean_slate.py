"""T12: when a registration ends, for any reason, everything kept about the channel goes and the founder is told."""
import re
import time

from conftest import NETWORK, after_window, OPER_HASH, body_of, mail_config, make_account, oper_up, register_channel, subject_of, wait_for
from harness import Server

MORE_MAIL = 8  # seconds the server is given to send a mail it should not: more than one look of the expiry timer (6 s with the periods below)
FORMATTING = re.compile(r"\x03\d{0,2}(?:,\d{1,2})?|[\x02\x0f\x16\x1d\x1f\x1e\x11]")


def chanserv(c, text):
    c.cs(text)
    return c.notices_from("ChanServ")


def booted(relay, **more):
    return Server({"opers.admin.password": OPER_HASH, **mail_config(relay), **more})


def people(server, *names):
    admin = server.client("admin" + str(time.time_ns())[-6:])
    oper_up(admin)
    for n in names:
        make_account(admin, n, f"{n}@example.net")
    admin.quit()
    return [server.client(n + "_c", account=n) for n in names]


def unregister(client, channel):
    client.cs(f"UNREGISTER {channel}")
    asked = client.expect(lambda m: m.command == "NOTICE" and m.prefix_nick == "ChanServ" and re.search(r"UNREGISTER \S+ \S+", m.text), what="ChanServ's confirmation code")
    code = re.search(r"UNREGISTER \S+ (\S+)", asked.text).group(1)
    client.cs(f"UNREGISTER {channel} {code}")
    client.collect()


def dress(founder, channel):
    """Everything a channel can have kept about it."""
    for text in (f"ENTRYMSG {channel} the greeting", f"ENTRYMSG {channel} REGULARS the welcome back", f"NOTE {channel} ADD a note",
                 f"JOINLIMIT {channel} 1 600", f"SUCCESSOR {channel} bob"):
        chanserv(founder, text)


def assert_clean_slate(server, newcomer, channel, leavers=()):
    for old in leavers:
        old.quit()  # the channel must be empty for a newcomer to be its first operator; quit returns when the server has closed the connection
    register_channel(newcomer, channel)
    assert not any("a note" in l for l in chanserv(newcomer, f"NOTE {channel} LIST"))
    assert not any("the greeting" in l for l in chanserv(newcomer, f"ENTRYMSG {channel} HISTORY"))
    first, second = server.client("guest1"), server.client("guest2")
    for g in (first, second):
        g.send(f"JOIN {channel}")
    got = {g.nick: g.collect() for g in (first, second)}
    assert not any(m.prefix_nick == "ChanServ" for ms in got.values() for m in ms), "something of the old registration is still said"
    assert all(any(m.command == "JOIN" and m.prefix_nick == nick for m in ms) for nick, ms in got.items()), "the old join limit still applies"
    info = " ".join(chanserv(newcomer, f"INFO {channel}"))
    assert "Notes: 0" in info.replace("  ", " ") or "0 of" in info
    assert "bob" not in info


def test_a_dropped_registration_leaves_nothing(relay):
    s = booted(relay)
    try:
        alice, bob, carol = people(s, "alice", "bob", "carol")
        register_channel(alice, "#Lobby")
        dress(alice, "#Lobby")
        unregister(alice, "#Lobby")
        assert_clean_slate(s, carol, "#lobby", [alice])
    finally:
        s.close()


def dropped_and_mailed(relay):
    s = booted(relay)
    alice, bob, carol = people(s, "alice", "bob", "carol")
    register_channel(alice, "#Lobby")
    unregister(alice, "#Lobby")
    wait_for(lambda: relay.delivered, "the founder's mail", relay)
    (mail,) = relay.delivered
    assert mail["to"] == ["alice@example.net"] and "#Lobby" in mail["raw"]
    return s, mail


def test_the_founder_is_mailed_in_the_networks_format_when_a_registration_is_dropped(relay):
    # D4: the subject starts with the network's name in square brackets and the last line is the signature
    s, mail = dropped_and_mailed(relay)
    try:
        assert subject_of(mail).startswith(f"[{NETWORK}] "), subject_of(mail)
        assert body_of(mail).rstrip("\r\n").splitlines()[-1] == f"-- {NETWORK} staff"
    finally:
        s.close()


def test_the_founder_is_told_how_long_a_new_registration_is_kept(relay):
    # D5: the board's 90 days, in days
    s, mail = dropped_and_mailed(relay)
    try:
        assert "90 days" in body_of(mail) and "60 days" not in body_of(mail), body_of(mail)
    finally:
        s.close()


def closed_by_staff(relay):
    """Staff close #Lobby while its founder and another operator, who listens to channel server notices, are online."""
    s = booted(relay)
    alice, bob, carol, staff = people(s, "alice", "bob", "carol", "sam")
    register_channel(alice, "#Lobby")
    dress(alice, "#Lobby")
    oper_up(staff)
    watcher = s.client("dave")
    oper_up(watcher)
    watcher.send("MODE dave +s j")
    watcher.collect()
    alice.collect()
    staff.cs("CLOSE #Lobby ownership dispute 4411")
    staff.collect()  # the others are told while the command runs: once its own connection has had its answer, what they are to get is on its way
    told = [m.text for m in alice.collect() if m.command == "NOTICE" and m.prefix_nick == "ChanServ"]
    seen = [FORMATTING.sub("", m.text) for m in watcher.collect() if m.command == "NOTICE"]
    return s, alice, carol, told, seen


def test_staff_closing_tells_the_online_founder(relay):
    # D9: the founder's connection is not the one that typed the command
    s, alice, carol, told, seen = closed_by_staff(relay)
    try:
        assert any("#Lobby" in t for t in told), told
    finally:
        s.close()


def test_staff_closing_sends_the_staff_notice_to_the_other_operators(relay):
    # D2: every use of a staff-only command sends `STAFF <account> <COMMAND> <#channel>`
    s, alice, carol, told, seen = closed_by_staff(relay)
    try:
        assert any("STAFF sam CLOSE #Lobby" in t for t in seen), seen
    finally:
        s.close()


def test_the_founder_is_told_network_staff_and_the_reason_not_who(relay):
    # D3: what tells a founder about an action by staff names them only as network staff
    s, alice, carol, told, seen = closed_by_staff(relay)
    try:
        assert told and any("ownership dispute 4411" in t for t in told) and not any("sam" in t.lower() for t in told), told
        wait_for(lambda: relay.delivered, "the founder's mail", relay)
        (mail,) = relay.delivered
        assert "ownership dispute 4411" in body_of(mail) and "network staff" in body_of(mail).lower()
        assert "sam" not in mail["raw"].lower().replace("example", "")
    finally:
        s.close()


def test_staff_closing_leaves_nothing(relay):
    s, alice, carol, told, seen = closed_by_staff(relay)
    try:
        assert_clean_slate(s, carol, "#lobby", [alice])
    finally:
        s.close()


def test_only_staff_can_close(relay):
    s = booted(relay)
    try:
        alice, bob = people(s, "alice", "bob")
        register_channel(alice, "#Lobby")
        chanserv(alice, "CLOSE #Lobby by the founder")
        chanserv(bob, "CLOSE #Lobby by someone else")
        assert not any("not registered" in l for l in chanserv(alice, "INFO #Lobby"))
    finally:
        s.close()


def test_an_expired_channel_leaves_nothing_and_the_founder_gets_one_mail_about_the_end(relay):
    s = booted(relay, **{"channels.registration.expire-after": "24s", "channels.registration.expire-warning": "20s"})
    try:
        alice, bob, carol = people(s, "alice", "bob", "carol")
        register_channel(alice, "#Lobby")
        dress(alice, "#Lobby")
        alice.quit()
        wait_for(lambda: len(relay.delivered) >= 2, "the warning mail and the mail about the end", relay)
        after_window(time.monotonic(), MORE_MAIL)  # looking for a third: it can only be missed on a slow machine, and a right server never sends one
        assert len(relay.delivered) == 2 and all(m["to"] == ["alice@example.net"] and "#Lobby" in m["raw"] for m in relay.delivered), [m["to"] for m in relay.delivered]
        assert_clean_slate(s, carol, "#lobby")
    finally:
        s.close()


def test_a_removed_account_ends_its_channels_and_leaves_nothing(relay):
    s = booted(relay)
    try:
        alice, bob, carol = people(s, "alice", "bob", "carol")
        register_channel(alice, "#Lobby")
        dress(alice, "#Lobby")
        chanserv(alice, "SUCCESSOR #Lobby")
        alice.ns("UNREGISTER alice")
        asked = alice.expect(lambda m: m.command == "NOTICE" and m.prefix_nick == "NickServ" and re.search(r"UNREGISTER \S+ \S+", m.text), what="NickServ's confirmation code")
        alice.ns("UNREGISTER alice " + re.search(r"UNREGISTER \S+ (\S+)", asked.text).group(1))
        alice.wait_closed()
        assert_clean_slate(s, carol, "#lobby")
    finally:
        s.close()


def test_the_founder_is_mailed_through_a_greylisting_relay(grey_relay):
    # D7: the relay refuses the first attempt for a new sender and recipient with a 451 and wants a retry after two seconds
    s = booted(grey_relay)
    try:
        alice, bob, carol = people(s, "alice", "bob", "carol")
        register_channel(alice, "#Lobby")
        unregister(alice, "#Lobby")
        wait_for(lambda: grey_relay.delivered, "the founder's mail, through the greylisting", grey_relay)
    finally:
        s.close()


def test_the_founder_is_mailed_through_a_relay_that_holds_unmarked_mail(strict_relay):
    # D10: the relay accepts machine mail without Auto-Submitted: auto-generated and never delivers it
    s = booted(strict_relay)
    try:
        alice, bob, carol = people(s, "alice", "bob", "carol")
        register_channel(alice, "#Lobby")
        unregister(alice, "#Lobby")
        wait_for(lambda: strict_relay.delivered, "the founder's mail, delivered and not held", strict_relay)
    finally:
        s.close()


def test_the_founders_notice_is_in_the_house_style(relay):
    # P1: a NOTICE that starts with the channel as registered in square brackets
    s, alice, carol, told, seen = closed_by_staff(relay)
    try:
        assert told and all(t.startswith("[#Lobby] ") for t in told), told
    finally:
        s.close()


def test_the_reason_keeps_its_spacing(relay):
    # D12
    s = booted(relay)
    try:
        alice, bob, carol, staff = people(s, "alice", "bob", "carol", "sam")
        register_channel(alice, "#Lobby")
        oper_up(staff)
        alice.collect()
        staff.cs("CLOSE #Lobby ownership   dispute  4411")
        staff.collect()
        told = [m.text for m in alice.collect() if m.command == "NOTICE" and m.prefix_nick == "ChanServ"]
        assert any("ownership   dispute  4411" in t for t in told), told
    finally:
        s.close()


def test_the_operators_notice_names_the_founder_as_registered(relay):
    # D13: Alice, not alice
    s = booted(relay)
    try:
        alice, bob, carol, staff = people(s, "Alice", "bob", "carol", "sam")
        register_channel(alice, "#Lobby")
        oper_up(staff)
        watcher = s.client("dave")
        oper_up(watcher)
        watcher.send("MODE dave +s j")
        watcher.collect()
        staff.cs("CLOSE #Lobby cleanup")
        staff.collect()
        seen = [FORMATTING.sub("", m.text) for m in watcher.collect() if m.command == "NOTICE"]
        assert any("#Lobby" in t and "Alice" in t for t in seen), seen
    finally:
        s.close()
