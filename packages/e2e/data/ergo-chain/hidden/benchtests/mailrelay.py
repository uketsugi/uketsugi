"""The network's mail relay, as a stand-in: a plain SMTP server (no TLS, no login) with three behaviours of the real one, and a
test inbox that says what it did.

    python3 mailrelay.py --port 2525 [--state DIR]     as a service: SMTP, and `GET /` on the same port shows the inbox
    r = Relay(port=0, greylist=0, quarantine=False, single=False); r.start(); ...; r.delivered     in a test (all three off: it accepts)

- Greylisting: the first time it sees a sender and recipient pair it answers `451 4.7.1` to RCPT TO and asks for a retry after
  `greylist` seconds; the pair is let through once that time has passed since the first attempt.
- Machine mail is accepted only with the header `Auto-Submitted: auto-generated`. Mail without it is answered 250 as usual and
  held in quarantine: it is never delivered.
- One connection at a time: a second, while one is open, is answered `421 4.3.2` at once and closed.
- The test inbox: `GET /` on the relay's port lists what it delivered, held and refused (greylisted attempts, extra connections).
  Every event is also one line on standard output.
"""
import argparse
import json
import os
import re
import select
import socketserver
import threading
import time

GREYLIST = 2.0
SLOW = 0.3  # seconds a client waits for the greeting: a busy relay, and the time in which a web client says what it wants


class Relay:
    def __init__(self, port=0, state=None, greylist=0, quarantine=False, single=False, slow=SLOW):
        self.greylist, self.quarantine, self.single, self.state, self.slow = greylist, quarantine, single, state, slow
        self.delivered, self.quarantined, self.refused = [], [], []  # refused: (kind, sender, recipient)
        self.log = []  # every event: (time, kind, detail)
        self.connections = 0
        self.seen = {}  # (sender, recipient) -> time of the first attempt
        self.busy = threading.Lock()
        self.lock = threading.Lock()
        relay = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                try:
                    relay.session(self)
                except OSError:
                    pass  # a client that hung up

        class Server(socketserver.ThreadingTCPServer):
            daemon_threads = True
            allow_reuse_address = True

        self.server = Server(("127.0.0.1", port), Handler)
        self.port = self.server.server_address[1]

    def start(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def event(self, kind, detail=""):
        with self.lock:
            self.log.append((time.time(), kind, detail))
        print(f"{time.strftime('%H:%M:%S')} {kind} {detail}", flush=True)

    def summary(self):
        """What the relay saw, for the message of a failed assertion: was mail sent at all?"""
        kinds = {}
        for _, k, _ in self.log:
            kinds[k] = kinds.get(k, 0) + 1
        return f"relay saw {self.connections} connections {kinds}; delivered={[m['to'] for m in self.delivered]} quarantined={len(self.quarantined)} refused={self.refused}"

    def inbox(self):
        rows = ["# test inbox of the mail relay (nothing sent to it leaves this machine)", ""]
        for title, mails in (("delivered", self.delivered), ("quarantined (held, never delivered)", self.quarantined)):
            rows.append(f"## {title}: {len(mails)}")
            for m in mails:
                subject = re.search(r"^Subject: (.*)$", m["raw"], re.M)
                head = m["raw"].split("\r\n\r\n", 1)[0].replace("\r\n", " | ")
                why = "" if title == "delivered" else "  [machine mail without 'Auto-Submitted: auto-generated']"
                rows.append(f"- {time.strftime('%H:%M:%S', time.localtime(m['time']))} from {m['from']} to {','.join(m['to'])} subject {subject.group(1).strip() if subject else '-'}{why}\n    headers: {head[:300]}")
        rows.append(f"## refused: {len(self.refused)}")
        for t, k, d in self.log:
            if k in ("greylisted", "busy"):
                rows.append(f"- {time.strftime('%H:%M:%S', time.localtime(t))} {k} {d}")
        return "\n".join(rows) + "\n"

    def record(self, name, row, into):
        with self.lock:
            into.append(row)
            if self.state:
                with open(os.path.join(self.state, name), "a") as f:
                    f.write(json.dumps(row) + "\n")

    def session(self, h):
        def say(line):
            h.wfile.write((line + "\r\n").encode())
            h.wfile.flush()

        self.connections += 1
        if self.single and not self.busy.acquire(blocking=False):
            say("421 4.3.2 Too many connections, one at a time please")
            self.record("refused.jsonl", ["connection", "", ""], self.refused)
            self.event("busy", "second connection while one is open: 421")
            return
        try:
            ready, _, _ = select.select([h.connection], [], [], self.slow)  # a web client speaks first; an SMTP client waits for the greeting
            if ready:
                first = h.connection.recv(4096, __import__("socket").MSG_PEEK)
                if first.startswith(b"GET "):
                    h.connection.recv(4096)
                    body = self.inbox().encode()
                    h.wfile.write(b"HTTP/1.0 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
                    return
            say("220 relay.example.org ESMTP stand-in")
            sender, rcpts = "", []
            while True:
                line = h.rfile.readline()
                if not line:
                    return
                text = line.decode("utf-8", "replace").rstrip("\r\n")
                verb = text.split(" ", 1)[0].upper()
                if verb in ("EHLO", "HELO"):
                    say("250 relay.example.org")
                elif verb == "MAIL":
                    sender, rcpts = _address(text), []
                    say("250 2.1.0 Ok")
                elif verb == "RCPT":
                    rcpt = _address(text)
                    if self.greylisted(sender, rcpt):
                        self.record("refused.jsonl", ["greylist", sender, rcpt], self.refused)
                        self.event("greylisted", f"{sender} -> {rcpt}: 451, retry after {self.greylist:g} s")
                        say(f"451 4.7.1 Greylisted, please try again in {self.greylist:g} seconds")
                    else:
                        rcpts.append(rcpt)
                        say("250 2.1.5 Ok")
                elif verb == "DATA":
                    if not rcpts:
                        say("503 5.5.1 Need RCPT first")
                        continue
                    say("354 End data with <CR><LF>.<CR><LF>")
                    body = []
                    while True:
                        l = h.rfile.readline()
                        if not l or l in (b".\r\n", b".\n"):
                            break
                        body.append(l[1:] if l.startswith(b"..") else l)
                    raw = b"".join(body).decode("utf-8", "replace")
                    mail = {"from": sender, "to": rcpts, "raw": raw, "time": time.time()}
                    marked = re.search(r"^Auto-Submitted:\s*auto-generated\s*$", raw.split("\r\n\r\n", 1)[0], re.I | re.M)
                    if marked or not self.quarantine:
                        self.record("delivered.jsonl", mail, self.delivered)
                        self.event("delivered", f"{sender} -> {','.join(rcpts)}")
                    else:
                        self.record("quarantine.jsonl", mail, self.quarantined)
                        self.event("quarantined", f"{sender} -> {','.join(rcpts)}: no Auto-Submitted: auto-generated")
                    say("250 2.0.0 Ok: queued")
                    sender, rcpts = "", []
                elif verb == "RSET":
                    sender, rcpts = "", []
                    say("250 2.0.0 Ok")
                elif verb == "NOOP":
                    say("250 2.0.0 Ok")
                elif verb == "QUIT":
                    say("221 2.0.0 Bye")
                    return
                else:
                    say("502 5.5.2 Command not recognized")
        finally:
            if self.single:
                self.busy.release()

    def greylisted(self, sender, rcpt):
        if not self.greylist:
            return False
        with self.lock:
            first = self.seen.setdefault((sender, rcpt), time.time())
            return time.time() - first < self.greylist


def _address(text):
    m = re.search(r"<([^>]*)>", text)
    return (m.group(1) if m else text.split(":", 1)[-1]).strip().lower()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=2525)
    ap.add_argument("--state", default=None)
    ap.add_argument("--lenient", action="store_true", help="accept everything: no greylisting, quarantine or connection limit")
    a = ap.parse_args()
    if a.state:
        os.makedirs(a.state, exist_ok=True)
    r = Relay(a.port, a.state, **({} if a.lenient else {"greylist": GREYLIST, "quarantine": True, "single": True}))
    r.server.serve_forever()
