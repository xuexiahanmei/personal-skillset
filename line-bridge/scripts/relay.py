"""Local relay between the LINE Chrome extension page and Claude (auto-reply).

    python relay.py serve --dir <private dir> [--port 38765]
    python relay.py queue --dir <private dir> [--port 38765] --chat NAME -   (text on stdin)
    python relay.py ping  --dir <private dir> [--port 38765]
    python relay.py clear --dir <private dir> [--port 38765]

serve  Listens on 127.0.0.1 only. The page side (LINESEND.relay in send-dom.js)
       POSTs each new incoming message to /in and polls /out for replies to send,
       reporting each result to /sent. Every event is appended to
       <dir>/relay.log as "<KIND> <json>"; tail it with a Monitor.
       KINDs: START, PAGE, IN, QUEUED, SENT, SENDFAIL, CLEARED, DOWN, UP.
queue  Adds a reply for the page to send, bound to one chat (--chat, the header
       name): the page refuses a reply meant for another chat. The text comes
       only on stdin ("-"), fed through a QUOTED heredoc, so the shell never
       expands $, backticks or $(...) in it.
ping   Prints the relay's answer (with the number of queued replies).
clear  Drops every queued reply that has not been reported yet.

Every request must carry ?t=<token>. The token is random per run and written to
<dir>/relay.token once the port is bound, so only a process that can read that
file can make the user's LINE send anything. Keep <dir> outside any repository:
the log holds the conversation.

`queue` posts from Python on purpose: curl.exe on this machine reads its command
line in the ANSI code page (Big5), so CJK text reached the relay as Big5 bytes.
"""
import argparse
import http.server
import json
import os
import secrets
import sys
import threading
import time
import urllib.parse
import urllib.request

# A reply handed to the page is not handed out again for this long, so a second
# page (a re-pasted script) cannot send it twice.
LEASE_SEC = 60
# Chrome throttles timers in a minimised window to about one run a minute; a
# shorter threshold would flap DOWN/UP instead of reporting a dead page.
DOWN_AFTER_SEC = 90


def serve(args):
    os.makedirs(args.dir, exist_ok=True)
    log_path = os.path.join(args.dir, 'relay.log')
    token = secrets.token_hex(16)   # written to disk only once the port is ours

    lock = threading.Lock()
    queue = []    # {"id", "chat", "text", "leased_until"}
    state = {'next_id': 1, 'last_poll': 0.0, 'down': False}

    def log(kind, obj):
        line = kind + ' ' + json.dumps(obj, ensure_ascii=False)
        with lock:
            with open(log_path, 'a', encoding='utf-8') as f:
                f.write(line + '\n')

    class Handler(http.server.BaseHTTPRequestHandler):
        def _cors(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'content-type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')

        def _reply(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self._cors()
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authed(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            return secrets.compare_digest(q.get('t', [''])[0], token)

        def _body(self):
            n = int(self.headers.get('Content-Length') or 0)
            try:
                return json.loads(self.rfile.read(n).decode('utf-8') or '{}')
            except (UnicodeDecodeError, ValueError) as e:
                self._reply(400, {'error': 'body must be UTF-8 JSON: %s' % e})
                return None

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            path = urllib.parse.urlparse(self.path).path
            if not self._authed():
                return self._reply(403, {'error': 'token'})
            if path == '/ping':
                return self._reply(200, {'pong': True, 'queued': len(queue)})
            if path == '/out':
                now = time.time()
                with lock:
                    state['last_poll'] = now
                    came_back = state['down']
                    state['down'] = False
                    ready = [q for q in queue if q['leased_until'] <= now]
                    for q in ready:
                        q['leased_until'] = now + LEASE_SEC
                    out = [{'id': q['id'], 'chat': q['chat'], 'text': q['text']} for q in ready]
                if came_back:
                    log('UP', {'at': time.strftime('%H:%M:%S')})
                return self._reply(200, out)
            self._reply(404, {'error': 'no such path'})

        def do_POST(self):
            path = urllib.parse.urlparse(self.path).path
            if not self._authed():
                return self._reply(403, {'error': 'token'})
            data = self._body()
            if data is None:
                return
            if path == '/in':
                log('IN', data)
                return self._reply(200, {'ok': True})
            if path == '/sent':
                with lock:
                    queue[:] = [q for q in queue if q['id'] != data.get('id')]
                log('SENT' if data.get('ok') else 'SENDFAIL', data)
                return self._reply(200, {'ok': True})
            if path == '/queue':
                text, chat = data.get('text'), data.get('chat')
                if not isinstance(text, str) or not text.strip():
                    return self._reply(400, {'error': 'text must be a non-empty string'})
                if not isinstance(chat, str) or not chat.strip():
                    return self._reply(400, {'error': 'chat (the header name) is required'})
                with lock:
                    item = {'id': state['next_id'], 'chat': chat, 'text': text, 'leased_until': 0.0}
                    state['next_id'] += 1
                    queue.append(item)
                log('QUEUED', {'id': item['id'], 'chat': chat, 'text': text})
                return self._reply(200, {'id': item['id'], 'chat': chat, 'text': text})
            if path == '/log':
                log('PAGE', data)
                return self._reply(200, {'ok': True})
            if path == '/clear':
                with lock:
                    dropped = [q['id'] for q in queue]
                    queue[:] = []
                log('CLEARED', {'ids': dropped})
                return self._reply(200, {'cleared': dropped})
            self._reply(404, {'error': 'no such path'})

        def log_message(self, *args):
            pass

    def watchdog():
        # Silence is not success: say so once if the page stops polling.
        while True:
            time.sleep(min(5, args.down_after / 3))
            with lock:
                last = state['last_poll']
                gone = last and time.time() - last > args.down_after and not state['down']
                if gone:
                    state['down'] = True
            if gone:
                log('DOWN', {'lastPollAgoSec': round(time.time() - last)})

    server = RelayServer(('127.0.0.1', args.port), Handler)   # raises if the port is taken
    with open(os.path.join(args.dir, 'relay.token'), 'w', encoding='ascii') as f:
        f.write(token)
    threading.Thread(target=watchdog, daemon=True).start()
    log('START', {'port': args.port})
    server.serve_forever()


class RelayServer(http.server.ThreadingHTTPServer):
    # The stdlib default (True) sets SO_REUSEADDR, which on Windows lets a second
    # relay bind the same port and silently share it (tested). Without it the
    # second bind fails with WinError 10048, and a restart right after traffic
    # still binds (tested).
    allow_reuse_address = False
    daemon_threads = True


def request(args, method, path, payload=None):
    token = open(os.path.join(args.dir, 'relay.token'), encoding='ascii').read().strip()
    # ensure_ascii escapes CJK as \uXXXX, so no code page can mangle the body.
    body = None if payload is None else json.dumps(payload).encode('ascii')
    req = urllib.request.Request(
        'http://127.0.0.1:%d%s?t=%s' % (args.port, path, token), data=body, method=method,
        headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as r:
        # Raw bytes: print() would encode with the console code page and fail.
        sys.stdout.buffer.write(r.read() + b'\n')


def main():
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = p.add_subparsers(dest='cmd', required=True)
    for name in ('serve', 'queue', 'ping', 'clear'):
        s = sub.add_parser(name)
        s.add_argument('--dir', required=True, help='private directory for relay.log and relay.token')
        s.add_argument('--port', type=int, default=38765)
        if name == 'serve':
            s.add_argument('--down-after', type=float, default=DOWN_AFTER_SEC, help=argparse.SUPPRESS)
        if name == 'queue':
            s.add_argument('--chat', required=True, help='the chat header name the reply is for')
            s.add_argument('text', help='- : read the reply (UTF-8) from stdin')
    args = p.parse_args()
    if args.cmd == 'serve':
        serve(args)
    elif args.cmd == 'queue':
        if args.text != '-':
            p.error("pass the text on stdin: queue --chat NAME - <<'EOF' ... EOF "
                    "(an argument goes through the shell, which expands $ and backticks)")
        # A heredoc ends with a newline; the text itself is one line.
        text = sys.stdin.buffer.read().decode('utf-8').rstrip('\r\n')
        request(args, 'POST', '/queue', {'chat': args.chat, 'text': text})
    elif args.cmd == 'clear':
        request(args, 'POST', '/clear', {})
    else:
        request(args, 'GET', '/ping')


if __name__ == '__main__':
    main()
