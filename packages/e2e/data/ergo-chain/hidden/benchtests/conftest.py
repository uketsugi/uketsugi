import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness  # noqa: E402

OPER_PASSWORD = "operpass"
OPER_HASH = "$2a$04$C0Egf0/nsJ6uu88nxogPleEgITPNHIjXCG8aUk7mLuWfPOoNtHQLu"  # ergo genpasswd of OPER_PASSWORD


@pytest.fixture
def server():
    s = harness.Server({"opers.admin.password": OPER_HASH})
    yield s
    s.close()


def register_channel(founder, channel):
    founder.join(channel)
    founder.cs(f"REGISTER {channel}")
    founder.expect(lambda m: m.command == "NOTICE" and m.prefix_nick == "ChanServ" and "registered" in m.text.lower(), what="channel registered")


def oper_up(client):
    client.send(f"OPER admin {OPER_PASSWORD}")
    client.expect(lambda m: m.command == "381", what="RPL_YOUREOPER")


NETWORK = "ErgoTest"  # network.name in default.yaml


def _serving(**quirks):
    from mailrelay import Relay
    return Relay(0, **quirks).start()


@pytest.fixture
def relay():
    """The mail relay stand-in on a free loopback port with its three behaviours off: it accepts everything. For what a mail says."""
    r = _serving()
    yield r
    r.stop()


@pytest.fixture
def grey_relay():
    """The relay with greylisting only (D7): the first attempt for a new sender and recipient is refused with a 451."""
    r = _serving(greylist=2.0)
    yield r
    r.stop()


@pytest.fixture
def strict_relay():
    """The relay with quarantine only (D10): mail without `Auto-Submitted: auto-generated` is accepted and never delivered."""
    r = _serving(quarantine=True)
    yield r
    r.stop()


def mail_config(relay):
    """Overrides that point the server's mail at the relay (the same settings as account verification mail)."""
    return {"accounts.registration.email-verification": {"enabled": True, "sender": "admin@example.org", "require-tls": False,
                                                          "helo-domain": "example.org", "mta": {"server": "127.0.0.1", "port": relay.port}}}


def make_account(oper, name, email="", password="hunter2pw"):
    """An account made by an operator (SAREGISTER, which sends no mail), with an email address when one is given."""
    oper.ns(f"SAREGISTER {name} {password}")
    oper.expect(lambda m: m.command == "NOTICE" and m.prefix_nick == "NickServ" and "registered account" in m.text.lower(), what="account created")
    if email:
        oper.ns(f"SASET {name} EMAIL {email}")
        oper.expect(lambda m: m.command == "NOTICE" and m.prefix_nick == "NickServ" and "successfully" in m.text.lower(), what="email set")


def wait_for(predicate, what, relay=None):
    """Polls until the predicate holds; the deadline is only a guard against hanging. On failure the message says what the relay saw, so that no
    mail sent at all is told from a mail refused."""
    import time
    end = time.monotonic() + harness.GUARD
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.1)  # poll interval
    raise AssertionError(f"within {harness.GUARD}s: {what}" + (f"; {relay.summary()}" if relay is not None else ""))


def after_window(since, seconds):
    """Returns once at least `seconds` have passed since `since` (a time.monotonic() taken after the event that opened the window). For a window the
    feature itself measures in time and that nothing on the server can show ending: the server stamps the event before the test takes `since`, so
    the window is over on the server's clock when this returns, however loaded the machine is (load can only make it later)."""
    import time
    while time.monotonic() < since + seconds:
        time.sleep(0.1)  # poll interval


def subject_of(mail):
    import re
    return re.search(r"^Subject: (.*)$", mail["raw"], re.M).group(1).strip()


def body_of(mail):
    return mail["raw"].split("\r\n\r\n", 1)[1]
