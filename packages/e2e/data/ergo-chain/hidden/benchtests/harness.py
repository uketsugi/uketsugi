"""Black-box harness for the hidden tests: builds the tree's ergo, runs it on a free loopback port with a config
derived from the tree's own default.yaml, and talks IRC to it over plain sockets. Standard library and PyYAML only."""
import atexit
import os
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time

import yaml

TREE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GOENV = {"GOPROXY": "off", "GOTOOLCHAIN": "local", "GOFLAGS": "-mod=vendor", "CGO_ENABLED": "0", "GOTELEMETRY": "off"}
_BIN = None
GUARD = 60  # seconds: how long any wait for a state may last before the test gives up; it only keeps a hung server from hanging the run. What is
# waited for is at most about 30 s of the server's own clock (an expiry), which load does not stretch; and in a tree that lacks the feature every
# such wait runs to its end, so the guard is also what keeps a judgement within the judge's 900 s.


def binary():
    global _BIN
    if _BIN is None:
        folder = tempfile.mkdtemp(prefix="ergo-bin-")
        atexit.register(shutil.rmtree, folder, True)
        out = os.path.join(folder, "ergo")
        env = {**os.environ, **GOENV}
        env.setdefault("GOCACHE", os.path.join(os.path.dirname(out), "gocache"))  # never the caller's home cache unless it says so
        p = subprocess.run(["go", "build", "-o", out, "."], cwd=TREE, env=env, capture_output=True, text=True)
        if p.returncode:
            raise RuntimeError("build failed:\n" + p.stderr[-3000:])
        _BIN = out
    return _BIN


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


REMOVE = object()  # as an override's value: take the key out, as an older configuration file lacks it


def deep_set(d, path, value):
    keys = path.split(".")
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    if value is REMOVE:
        d.pop(keys[-1], None)
    else:
        d[keys[-1]] = value


class Server:
    """One ergo process. `overrides` maps dotted config paths to values, applied over default.yaml."""

    def __init__(self, overrides=None, config_file="default.yaml"):
        self.dir = tempfile.mkdtemp(prefix="ergo-run-")
        self.port = free_port()
        conf = yaml.safe_load(open(os.path.join(TREE, config_file)))
        conf["server"]["listeners"] = {f"127.0.0.1:{self.port}": {}}
        conf["server"]["lookup-hostnames"] = False
        conf["server"]["forward-confirmed-hostnames"] = False
        conf["server"]["check-ident"] = False
        conf["server"].pop("sts", None)
        conf["server"]["ip-limits"] = {"count": False, "throttle": False}
        conf["datastore"]["path"] = os.path.join(self.dir, "ircd.db")
        conf["lock-file"] = os.path.join(self.dir, "ircd.lock")  # the default is one file in the working folder, which lets one server run at a time
        conf["logging"] = [{"method": "file", "filename": os.path.join(self.dir, "ergo.log"), "type": "* -userinput -useroutput", "level": "debug"}]
        conf["fakelag"] = {"enabled": False}
        conf["server"]["motd"] = ""
        conf["accounts"]["registration"]["throttling"] = {"enabled": False}
        conf["accounts"]["login-throttling"] = {"enabled": False}
        conf["accounts"]["multiclient"] = conf["accounts"].get("multiclient", {})
        for k, v in (overrides or {}).items():
            deep_set(conf, k, v)
        self.conf_path = os.path.join(self.dir, "ircd.yaml")
        yaml.safe_dump(conf, open(self.conf_path, "w"))
        self.proc = None
        subprocess.run([binary(), "initdb", "--conf", self.conf_path, "--quiet"], check=True, capture_output=True)
        for attempt in range(4):
            try:
                self.start()
                return
            except RuntimeError as e:  # another test process may have taken the port between its being found free and the server's binding it
                if "exited" not in str(e) or attempt == 3:
                    raise
                self.port = free_port()
                conf["server"]["listeners"] = {f"127.0.0.1:{self.port}": {}}
                yaml.safe_dump(conf, open(self.conf_path, "w"))

    def start(self):
        # K-F8: the server runs in a time zone far from UTC, so a time shown in local time is caught
        self.proc = subprocess.Popen([binary(), "run", "--conf", self.conf_path, "--quiet"], stdout=subprocess.DEVNULL,
                                     stderr=open(os.path.join(self.dir, "stderr.log"), "a"), env={**os.environ, "TZ": "Pacific/Auckland"})
        end = time.monotonic() + GUARD
        while time.monotonic() < end:  # ready is: the server answers a command
            if self.proc.poll() is not None:
                raise RuntimeError("ergo exited:\n" + open(os.path.join(self.dir, "stderr.log")).read()[-3000:])
            if self._answers():
                return
            time.sleep(0.1)  # poll interval
        raise RuntimeError(f"ergo did not answer a PING within {GUARD}s")

    def _answers(self):
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=5) as s:
                s.sendall(b"PING :ready\r\n")
                return b"PONG" in s.recv(4096)
        except OSError:
            return False

    def wait_stored(self, *texts):
        """Waits until the datastore file holds every text. The server writes a channel back in a task of its own that a shutdown does not wait
        for, so a restart that follows a command at once can lose what the command stored; the text a test typed last tells that it is on disk."""
        path = os.path.join(self.dir, "ircd.db")
        end = time.monotonic() + GUARD
        while time.monotonic() < end:
            data = open(path, "rb").read()
            if all(t.encode() in data for t in texts):
                return
            time.sleep(0.05)  # poll interval
        raise AssertionError(f"within {GUARD}s: {texts} stored in the datastore")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(GUARD)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()

    def restart(self):
        self.stop()
        self.start()

    def close(self):
        self.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def client(self, nick, account=None, password="hunter2pw", register=False):
        c = Client(self.port, nick)
        c.connect()
        if register:
            c.ns(f"REGISTER {password}")
            c.expect(lambda m: m.command == "NOTICE" and m.prefix_nick == "NickServ" and "now logged in" in m.text, what="account created and logged in")
        elif account:
            c.ns(f"IDENTIFY {account} {password}")
            c.expect(lambda m: m.command == "NOTICE" and m.prefix_nick == "NickServ" and "now logged in" in m.text, what="logged in")
        return c


class Msg:
    RE = re.compile(r"^(?:@(\S+) )?(?::(\S+) )?(\S+)(.*)$")

    def __init__(self, line):
        self.raw = line
        tags, prefix, command, rest = self.RE.match(line).groups()
        self.tags = dict(t.split("=", 1) if "=" in t else (t, "") for t in tags.split(";")) if tags else {}
        self.prefix = prefix or ""
        self.prefix_nick = self.prefix.split("!")[0]
        self.command = command.upper()
        params, rest = [], rest.strip()
        while rest:
            if rest.startswith(":"):
                params.append(rest[1:])
                break
            part, _, rest = rest.partition(" ")
            params.append(part)
            rest = rest.lstrip(" ")
        self.params = params
        self.text = params[-1] if params else ""

    def __repr__(self):
        return self.raw


class Client:
    def __init__(self, port, nick):
        self.port, self.nick = port, nick
        self.buf = b""
        self.seen = []
        self.syncs = 0

    def connect(self):
        self.sock = socket.create_connection(("127.0.0.1", self.port), timeout=GUARD)
        self.send(f"NICK {self.nick}")
        self.send(f"USER {self.nick} 0 * :{self.nick}")
        self.expect(lambda m: m.command == "001", what="welcome")
        self.expect(lambda m: m.command in ("376", "422"), what="end of MOTD")

    def send(self, line):
        self.sock.sendall((line + "\r\n").encode())

    def ns(self, text):
        self.send(f"PRIVMSG NickServ :{text}")

    def cs(self, text):
        self.send(f"PRIVMSG ChanServ :{text}")

    def _read(self, timeout):
        self.sock.settimeout(timeout)
        try:
            data = self.sock.recv(65536)
        except socket.timeout:
            return False
        if not data:
            raise ConnectionError("server closed the connection")
        self.buf += data
        while b"\r\n" in self.buf:
            line, self.buf = self.buf.split(b"\r\n", 1)
            m = Msg(line.decode("utf-8", "replace"))
            if m.command == "PING":
                self.send("PONG :" + m.text)
                continue
            self.seen.append(m)
        return True

    def expect(self, pred, timeout=GUARD, what="a matching message"):
        """The first unconsumed message that matches; messages before it stay queued for later expects."""
        t0 = time.time()
        while True:
            for i, m in enumerate(self.seen):
                if pred(m):
                    del self.seen[i]
                    return m
            left = timeout - (time.time() - t0)
            if left <= 0:
                raise AssertionError(f"{self.nick}: no {what} within {timeout}s; got: {self.seen[-6:]}")
            self._read(min(left, 0.5))

    def collect(self):
        """Everything the server has sent this connection up to now, and the queue is emptied. The server answers a PING after what it queued
        before it, so the reply to ours marks the end of what was already on its way (no waiting for quiet)."""
        self.syncs += 1
        token = f"sync{self.syncs}"
        self.send(f"PING :{token}")
        self.expect(lambda m: m.command == "PONG" and m.text == token, what="the reply to PING")
        out, self.seen = self.seen, []
        return out

    def notices_from(self, service):
        return [m.text for m in self.collect() if m.command == "NOTICE" and m.prefix_nick == service]

    def wait_closed(self):
        """Reads until the server has closed the connection, as it does the connections of an account that is unregistered."""
        end = time.monotonic() + GUARD
        while time.monotonic() < end:
            try:
                self._read(0.5)
            except ConnectionError:
                return
        raise AssertionError(f"{self.nick}: the server did not close the connection within {GUARD}s")

    def join(self, channel):
        self.send(f"JOIN {channel}")
        self.expect(lambda m: m.command in ("366",) and m.params[1].lower() == channel.lower(), what=f"end of NAMES for {channel}")

    def quit(self):
        """Leaves, and returns once the server has closed the connection, which it does after removing the client from its channels."""
        try:
            self.send("QUIT :bye")
            self.wait_closed()
            self.sock.close()
        except OSError:
            pass
