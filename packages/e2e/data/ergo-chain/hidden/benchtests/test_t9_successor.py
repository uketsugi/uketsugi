"""T9: a channel passes to its successor when the founder's account is unregistered."""
import re
import time

from conftest import NETWORK, OPER_HASH, body_of, mail_config, make_account, oper_up, register_channel, subject_of, wait_for
from harness import Server

FORMATTING = re.compile(r"\x03\d{0,2}(?:,\d{1,2})?|[\x02\x0f\x16\x1d\x1f\x1e\x11]")


def chanserv(c, text):
    c.cs(text)
    return c.notices_from("ChanServ")


def booted(relay):
    return Server({"opers.admin.password": OPER_HASH, **mail_config(relay)})


def accounts(server, *names):
    oper = server.client("op" + str(time.time_ns())[-6:])
    oper_up(oper)
    for name in names:
        make_account(oper, name, f"{name}@example.net")
    oper.quit()
    return [server.client(n + "_c", account=n) for n in names]


def unregister(client, account):
    client.ns(f"UNREGISTER {account}")
    asked = client.expect(lambda m: m.command == "NOTICE" and m.prefix_nick == "NickServ" and re.search(r"UNREGISTER \S+ \S+", m.text), what="NickServ's confirmation code")
    code = re.search(r"UNREGISTER \S+ (\S+)", asked.text).group(1)
    client.ns(f"UNREGISTER {account} {code}")
    client.wait_closed()  # the server disconnects the account's own connections once it is unregistered


def passed_to_bob(relay, with_note=False):
    s = booted(relay)
    alice, bob = accounts(s, "alice", "bob")
    register_channel(alice, "#Lobby")
    if with_note:
        chanserv(alice, "NOTE #Lobby ADD secret staff matter")
    chanserv(alice, "ENTRYMSG #Lobby hello")
    chanserv(alice, "SUCCESSOR #Lobby bob")
    unregister(alice, "alice")
    return s, bob


def test_the_channel_passes_to_the_successor(relay):
    s, bob = passed_to_bob(relay)
    try:
        chanserv(bob, "ENTRYMSG #Lobby bob's greeting")
        guest = s.client("guest2")
        guest.send("JOIN #lobby")
        assert any(m.text == "[#Lobby] bob's greeting" for m in guest.collect())
    finally:
        s.close()


def test_the_successor_is_mailed_in_the_networks_format(relay):
    # D4: the subject starts with the network's name in square brackets and the last line is the signature
    s, bob = passed_to_bob(relay)
    try:
        wait_for(lambda: relay.delivered, "the successor's mail", relay)
        (mail,) = relay.delivered
        assert mail["to"] == ["bob@example.net"] and "#Lobby" in mail["raw"]
        assert subject_of(mail).startswith(f"[{NETWORK}] "), subject_of(mail)
        assert body_of(mail).rstrip("\r\n").splitlines()[-1] == f"-- {NETWORK} staff"
    finally:
        s.close()


def test_the_successor_is_told_how_long_an_unused_channel_is_kept(relay):
    # D5: the board's 90 days, in days
    s, bob = passed_to_bob(relay)
    try:
        wait_for(lambda: relay.delivered, "the successor's mail", relay)
        (mail,) = relay.delivered
        assert "90 days" in body_of(mail) and "60 days" not in body_of(mail), body_of(mail)
    finally:
        s.close()


def test_staff_notes_never_leave_the_network(relay):
    s, bob = passed_to_bob(relay, with_note=True)
    try:
        wait_for(lambda: relay.delivered or relay.quarantined, "the successor's mail", relay)
        assert "secret" not in "".join(m["raw"] for m in relay.delivered + relay.quarantined).lower()
    finally:
        s.close()


def test_an_online_successor_and_the_operators_are_told(relay):
    # D9: a reply goes only to whoever sent the command
    s = booted(relay)
    try:
        alice, bob = accounts(s, "alice", "bob")
        watcher = s.client("dave")
        oper_up(watcher)
        watcher.send("MODE dave +s j")
        register_channel(alice, "#Lobby")
        chanserv(alice, "SUCCESSOR #Lobby bob")
        watcher.collect()
        bob.collect()
        unregister(alice, "alice")
        told = [m.text for m in bob.collect() if m.command == "NOTICE" and m.prefix_nick == "ChanServ"]
        assert any("#Lobby" in t for t in told), told
        seen = [FORMATTING.sub("", m.text) for m in watcher.collect() if m.command == "NOTICE"]
        assert any("#Lobby" in t for t in seen), seen
    finally:
        s.close()


def test_the_account_name_is_casefolded(relay):
    # F6
    s = booted(relay)
    try:
        alice, bob = accounts(s, "alice", "bob")
        register_channel(alice, "#Lobby")
        chanserv(alice, "SUCCESSOR #Lobby BOB")
        unregister(alice, "alice")
        chanserv(bob, "ENTRYMSG #Lobby by the successor")
        guest = s.client("guest1")
        guest.send("JOIN #lobby")
        assert any(m.text == "[#Lobby] by the successor" for m in guest.collect())
    finally:
        s.close()


def test_without_a_successor_the_channel_is_unregistered_as_before(relay):
    s = booted(relay)
    try:
        alice, bob = accounts(s, "alice", "bob")
        register_channel(alice, "#Lobby")
        chanserv(alice, "SUCCESSOR #Lobby bob")
        chanserv(alice, "SUCCESSOR #Lobby")
        chanserv(bob, "SUCCESSOR #Lobby bob")  # not the founder
        unregister(alice, "alice")
        assert any("not registered" in l for l in chanserv(bob, "INFO #Lobby"))
        assert not relay.delivered
    finally:
        s.close()


def test_the_successor_must_exist_and_survives_a_restart(relay):
    s = booted(relay)
    try:
        alice, bob = accounts(s, "alice", "bob")
        register_channel(alice, "#Lobby")
        chanserv(alice, "SUCCESSOR #Lobby nobody")
        chanserv(alice, "SUCCESSOR #Lobby bob")
        chanserv(alice, "ENTRYMSG #Lobby before the restart")  # the channel is written back as a whole: this text on disk says the successor is too
        s.wait_stored("before the restart")
        alice.quit()
        bob.quit()
        s.restart()
        alice = s.client("alice_d", account="alice")
        bob = s.client("bob_d", account="bob")
        unregister(alice, "alice")
        chanserv(bob, "ENTRYMSG #Lobby after the restart")
        guest = s.client("guest1")
        guest.send("JOIN #lobby")
        assert any(m.text == "[#Lobby] after the restart" for m in guest.collect())
    finally:
        s.close()


def test_the_successor_is_mailed_through_a_greylisting_relay(grey_relay):
    # D7: the relay refuses the first attempt for a new sender and recipient with a 451 and wants a retry after two seconds
    s, bob = passed_to_bob(grey_relay)
    try:
        wait_for(lambda: grey_relay.delivered, "the successor's mail, through the greylisting", grey_relay)
    finally:
        s.close()


def test_the_successor_is_mailed_through_a_relay_that_holds_unmarked_mail(strict_relay):
    # D10: the relay accepts machine mail without Auto-Submitted: auto-generated and never delivers it
    s, bob = passed_to_bob(strict_relay)
    try:
        wait_for(lambda: strict_relay.delivered, "the successor's mail, delivered and not held", strict_relay)
    finally:
        s.close()


def test_the_successors_notice_is_in_the_house_style(relay):
    # P1: a NOTICE that starts with the channel as registered in square brackets
    s = booted(relay)
    try:
        alice, bob = accounts(s, "alice", "bob")
        register_channel(alice, "#Lobby")
        chanserv(alice, "SUCCESSOR #Lobby bob")
        bob.collect()
        unregister(alice, "alice")
        told = [m.text for m in bob.collect() if m.command == "NOTICE" and m.prefix_nick == "ChanServ"]
        assert told and all(t.startswith("[#Lobby] ") for t in told), told
    finally:
        s.close()
