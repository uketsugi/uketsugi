"""The mail relay stand-in's own behaviour: greylisting, quarantine of mail without Auto-Submitted, one connection at a time, the inbox."""
import smtplib
import socket

import harness
import urllib.request

import pytest

from conftest import wait_for
from mailrelay import Relay

AUTO = "Auto-Submitted: auto-generated\r\n"


def send(relay, rcpt="founder@example.org", sender="net@example.org", headers=AUTO):
    def attempt():
        try:
            with smtplib.SMTP("127.0.0.1", relay.port, timeout=harness.GUARD) as s:
                s.sendmail(sender, [rcpt], f"From: {sender}\r\nTo: {rcpt}\r\nSubject: hi\r\n{headers}\r\nbody\r\n")
            return True
        except smtplib.SMTPConnectError:
            return False  # a one-connection relay still holds the last connection: try again

    wait_for(attempt, "the relay takes the connection")


def accepted(relay, **kw):
    try:
        send(relay, **kw)
        return True
    except smtplib.SMTPRecipientsRefused:
        return False


def let_the_greylist_pass(relay, **kw):
    """The refusals are asserted while the greylist time is long, so that no slow machine can end it first; then the time is made short, and the
    send is repeated until the relay lets the pair through."""
    relay.greylist = 0.2
    wait_for(lambda: accepted(relay, **kw), "the greylisted pair is let through")


@pytest.fixture
def grey():
    r = Relay(0, greylist=600).start()
    yield r
    r.stop()


@pytest.fixture
def strict():
    r = Relay(0, quarantine=True).start()
    yield r
    r.stop()


@pytest.fixture
def single():
    r = Relay(0, single=True).start()
    yield r
    r.stop()


def test_a_new_pair_is_greylisted_once(grey):
    with pytest.raises(smtplib.SMTPRecipientsRefused) as e:
        send(grey)
    assert list(e.value.recipients.values())[0][0] == 451
    assert not grey.delivered
    with pytest.raises(smtplib.SMTPRecipientsRefused):
        send(grey)  # too early: still within the greylist time
    let_the_greylist_pass(grey)
    send(grey)  # and from then on the pair is known
    assert len(grey.delivered) == 2


def test_each_pair_is_greylisted_on_its_own(grey):
    with pytest.raises(smtplib.SMTPRecipientsRefused):
        send(grey, rcpt="a@example.org")
    let_the_greylist_pass(grey, rcpt="a@example.org")
    grey.greylist = 600
    with pytest.raises(smtplib.SMTPRecipientsRefused):
        send(grey, rcpt="b@example.org")


def test_mail_without_auto_submitted_is_accepted_and_never_delivered(strict):
    send(strict, headers="")  # answered 250, so the sender cannot tell
    send(strict)
    assert len(strict.delivered) == 1 and len(strict.quarantined) == 1


def test_one_connection_at_a_time(single):
    first = smtplib.SMTP("127.0.0.1", single.port, timeout=harness.GUARD)
    with pytest.raises(smtplib.SMTPConnectError) as e:
        smtplib.SMTP("127.0.0.1", single.port, timeout=harness.GUARD)
    assert e.value.smtp_code == 421
    first.quit()

    def free_again():
        try:
            smtplib.SMTP("127.0.0.1", single.port, timeout=harness.GUARD).quit()
            return True
        except smtplib.SMTPConnectError:
            return False

    wait_for(free_again, "the relay takes a connection again")


def test_a_relay_with_nothing_switched_on_accepts_everything():
    r = Relay(0).start()
    try:
        send(r, headers="")
        send(r)
        send(r)
        assert len(r.delivered) == 3 and not r.refused
    finally:
        r.stop()


def test_the_inbox_says_what_was_delivered_held_and_refused():
    r = Relay(0, greylist=600, quarantine=True, single=True).start()
    try:
        with pytest.raises(smtplib.SMTPRecipientsRefused):
            send(r)
        let_the_greylist_pass(r, headers="")
        send(r)
        first = smtplib.SMTP("127.0.0.1", r.port, timeout=harness.GUARD)
        with pytest.raises(smtplib.SMTPConnectError):
            smtplib.SMTP("127.0.0.1", r.port, timeout=harness.GUARD)
        first.quit()
        r.slow = harness.GUARD  # the relay waits this long for a web client to speak first; no SMTP client is connected now
        page = urllib.request.urlopen(f"http://127.0.0.1:{r.port}/", timeout=harness.GUARD).read().decode()
        assert "delivered: 1" in page and "quarantined" in page and "Auto-Submitted" in page
        assert "greylisted" in page and "busy" in page
        assert r.connections >= 4 and "greylisted" in r.summary()
    finally:
        r.stop()
