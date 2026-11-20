"""T6: registered channels nobody uses expire, and their founders are mailed."""
import os
import time

import yaml

from conftest import NETWORK, after_window, OPER_HASH, body_of, mail_config, make_account, oper_up, register_channel, subject_of, wait_for
from harness import TREE, Server

LONG = {"channels.registration.expire-after": "30s", "channels.registration.expire-warning": "27s"}  # only the warning is due while a test runs
# The server looks every quarter of the period. The warning is due after 4 s of disuse and the end after 24 s, so that a slow machine would have
# to hold the server back for 20 s to make it miss the warning (a channel found past its end is expired with no warning).
PERIODS = {"channels.registration.expire-after": "24s", "channels.registration.expire-warning": "20s"}


def chanserv(c, text):
    c.cs(text)
    return c.notices_from("ChanServ")


def booted(relay, **more):
    return Server({"opers.admin.password": OPER_HASH, **mail_config(relay), **PERIODS, **more})


def founder_of(server, relay, name, channel, email=None):
    """An account with an address, a registered channel, and nobody left in it."""
    oper = server.client("op_" + name)
    oper_up(oper)
    make_account(oper, name, email or f"{name}@example.net")
    oper.quit()
    founder = server.client(name + "_c", account=name)
    register_channel(founder, channel)
    return founder


def is_registered(server, channel):
    n = str(time.time_ns())[-7:]
    oper = server.client("po" + n)
    oper_up(oper)
    make_account(oper, "pr" + n)
    oper.quit()
    c = server.client("pc" + n, account="pr" + n)
    return not any("not registered" in l.lower() or "no such" in l.lower() for l in chanserv(c, f"INFO {channel}"))


def test_warning_and_expiry_mails(relay):
    # D4: the subject starts with the network's name in square brackets and the last line is the signature
    s = booted(relay)
    try:
        founder_of(s, relay, "alice", "#Lobby").quit()
        wait_for(lambda: len(relay.delivered) >= 2, "two mails delivered", relay)
        warning, expired = sorted(relay.delivered, key=lambda m: m["time"])[:2]
        assert warning["to"] == ["alice@example.net"] and "#Lobby" in subject_of(warning)
        assert expired["to"] == ["alice@example.net"] and "#Lobby" in subject_of(expired)
        for mail in (warning, expired):
            assert subject_of(mail).startswith(f"[{NETWORK}] "), subject_of(mail)
            assert body_of(mail).rstrip("\r\n").splitlines()[-1] == f"-- {NETWORK} staff"
            assert "Content-Type: text/html" not in mail["raw"]
        wait_for(lambda: not is_registered(s, "#Lobby"), "the channel's registration is gone")
    finally:
        s.close()


def warning_mailed(relay):
    """The warning itself, not just any mail: the mail about the end would come after 30 s, and a relay that refused the warning would let that one by."""
    return any("will expire" in subject_of(m) for m in relay.delivered)


def test_the_founder_is_mailed_through_a_greylisting_relay(grey_relay):
    # D7: the relay refuses the first attempt for a new sender and recipient with a 451 and wants a retry after two seconds
    s = booted(grey_relay, **LONG)
    try:
        founder_of(s, grey_relay, "alice", "#Lobby").quit()
        wait_for(lambda: warning_mailed(grey_relay), "the warning mail, through the greylisting", grey_relay)
    finally:
        s.close()


def test_the_founder_is_mailed_through_a_relay_that_holds_unmarked_mail(strict_relay):
    # D10: the relay accepts machine mail without Auto-Submitted: auto-generated and never delivers it
    s = booted(strict_relay, **LONG)
    try:
        founder_of(s, strict_relay, "alice", "#Lobby").quit()
        wait_for(lambda: warning_mailed(strict_relay), "the warning mail, delivered and not held", strict_relay)
    finally:
        s.close()


def warned_online_founder(relay):
    s = booted(relay)
    try:
        founder = founder_of(s, relay, "alice", "#Lobby")
        founder.send("PART #Lobby")
        founder.collect()
        told = []

        def warned():
            told.extend(m.text for m in founder.collect() if m.command == "NOTICE" and m.prefix_nick == "ChanServ")
            return told

        wait_for(warned, "ChanServ's warning to the founder", relay)
        return told
    finally:
        s.close()


def test_an_online_founder_is_told_when_the_warning_goes_out(relay):
    # D9: ChanServ has to message the founder's own connection, which is not the connection of anyone who typed a command
    told = warned_online_founder(relay)
    assert any("#Lobby" in t for t in told), told


def test_the_founders_notice_is_in_the_house_style(relay):
    # P1: a NOTICE that starts with the channel as registered in square brackets
    told = warned_online_founder(relay)
    assert told and all(t.startswith("[#Lobby] ") for t in told), told


def test_a_channel_that_is_used_keeps_its_registration(relay):
    s = booted(relay)
    try:
        founder = founder_of(s, relay, "alice", "#lobby")
        founder.quit()
        control = founder_of(s, relay, "bella", "#control")  # nobody uses it: its end shows that the whole period has passed
        control.quit()
        member = s.client("alice_d", account="alice")
        oper = s.client("op_probe")
        oper_up(oper)
        make_account(oper, "probe")
        oper.quit()
        probe = s.client("probe_c", account="probe")

        def control_expired():
            member.send("PART #lobby")  # joined again and again for longer than the whole period
            member.collect()
            member.join("#lobby")
            return any("not registered" in l.lower() or "no such" in l.lower() for l in chanserv(probe, "INFO #control"))

        wait_for(control_expired, "the unused channel has expired", relay)
        assert is_registered(s, "#lobby")
    finally:
        s.close()


def a_whole_period_has_passed():
    """What a test of "nothing happens" waits for: a second server, started now, with the short periods, in which an unused channel expires. Its
    end can come only after a whole period has passed on this machine, which is the same however slow it is."""
    from conftest import _serving
    relay = _serving()
    control = booted(relay)
    try:
        founder_of(control, relay, "ctl", "#control").quit()
        wait_for(lambda: not is_registered(control, "#control"), "the control channel's registration is gone", relay)
    finally:
        control.close()
        relay.stop()


def test_zero_turns_expiry_off(relay):
    s = booted(relay, **{"channels.registration.expire-after": 0})
    try:
        founder_of(s, relay, "alice", "#lobby").quit()
        a_whole_period_has_passed()
        assert is_registered(s, "#lobby") and not relay.delivered
    finally:
        s.close()


def test_a_channel_that_expired_while_the_server_was_down_expires_at_start(relay):
    # F9: nothing is waiting for a timer when the server comes back
    # Known limit: this cannot tell an expiry at start-up from one at the first timer tick (a quarter of the period later). Both leave the
    # channel gone and the founder mailed, and no state of the server separates them but elapsed time, which a test may not decide on.
    s = booted(relay, **{"channels.registration.expire-after": "4s", "channels.registration.expire-warning": "2s"})
    try:
        founder_of(s, relay, "alice", "#lobby").quit()
        left = time.monotonic()
        s.stop()
        after_window(left, 4)  # the whole period passes with the server down
        s.start()
        wait_for(lambda: not is_registered(s, "#lobby"), "the channel's registration is gone")
        wait_for(lambda: any("#lobby" in subject_of(m).lower() for m in relay.delivered), "a mail to the founder about #lobby", relay)
    finally:
        s.close()


def test_the_default_periods_leave_a_new_channel_alone(relay):
    # F4: an existing configuration has neither key
    s = Server({"opers.admin.password": OPER_HASH, **mail_config(relay),
                "channels.registration.expire-after": __import__("harness").REMOVE, "channels.registration.expire-warning": __import__("harness").REMOVE})
    try:
        founder_of(s, relay, "alice", "#lobby").quit()
        a_whole_period_has_passed()
        assert is_registered(s, "#lobby") and not relay.delivered
    finally:
        s.close()
