"""Exercise scripts/relay.py over real HTTP on 127.0.0.1 (no LINE involved).

    python test_relay.py      (npm test runs it after the JS suites)

Starts `relay.py serve` in a temporary directory on a free port, then checks the
token gate, queueing through `relay.py queue` (stdin, CJK, text that looks like
shell code or an option), the chat binding, the 60 s lease, /sent, rejected
bodies, and that a second relay cannot take the same port.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RELAY = os.path.join(HERE, '..', 'scripts', 'relay.py')
ENV = dict(os.environ, PYTHONIOENCODING='utf-8')

failures = 0


def check(name, actual, expected):
    global failures
    if actual == expected:
        print('ok   ' + name)
    else:
        failures += 1
        print('FAIL %s\n  expected: %r\n  actual:   %r' % (name, expected, actual))


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def http(method, path, token=None, body=None, raw=None):
    url = 'http://127.0.0.1:%d%s' % (port, path) + ('?t=' + token if token else '')
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode('ascii'))
    req = urllib.request.Request(url, data=data, method=method, headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode('utf-8'))


def queue(chat, text):
    p = subprocess.run([sys.executable, RELAY, 'queue', '--dir', d, '--port', str(port), '--chat', chat, '-'],
                       input=(text + '\n').encode('utf-8'), capture_output=True, env=ENV, timeout=10)
    return p.returncode, json.loads(p.stdout.decode('utf-8')) if p.returncode == 0 else p.stderr.decode('utf-8', 'replace')


def start_relay():
    proc = subprocess.Popen([sys.executable, RELAY, 'serve', '--dir', d, '--port', str(port), '--down-after', '2'],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=ENV)
    for _ in range(50):
        try:
            if http('GET', '/ping', open(os.path.join(d, 'relay.token'), encoding='ascii').read().strip())[0] == 200:
                return proc
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise RuntimeError('relay did not start')


def log_kinds():
    return [line.split(' ', 1)[0] for line in open(os.path.join(d, 'relay.log'), encoding='utf-8')]


with tempfile.TemporaryDirectory() as d:
    port = free_port()
    server = start_relay()
    try:
        token_path = os.path.join(d, 'relay.token')
        token = open(token_path, encoding='ascii').read().strip()

        check('ping with the token', http('GET', '/ping', token), (200, {'pong': True, 'queued': 0}))
        check('no token -> 403', http('GET', '/ping')[0], 403)
        check('wrong token -> 403', http('GET', '/out', 'x' * 32)[0], 403)

        tricky = '價格 $5 $(echo SUBSHELL) `id` 他說 "OK"'
        check('queue CJK + shell-looking text via stdin, verbatim', queue('王小明', tricky), (0, {'id': 1, 'chat': '王小明', 'text': tricky}))
        check('queue text that starts with a dash', queue('王小明', '-_-')[1]['text'], '-_-')
        literal = subprocess.run([sys.executable, RELAY, 'queue', '--dir', d, '--port', str(port), '--chat', '王小明', 'hi'],
                                 capture_output=True, env=ENV, timeout=10)
        check('text as an argument (through the shell) is refused', literal.returncode, 2)
        check('queue without --chat is refused by the relay', http('POST', '/queue', token, {'text': 'hi'})[0], 400)
        check('empty text -> 400', http('POST', '/queue', token, {'chat': '王小明', 'text': '  '})[0], 400)
        big5 = '{"chat":"a","text":"你好"}'.encode('big5')
        check('a Big5 body -> 400, not a crash', http('POST', '/queue', token, raw=big5)[0], 400)
        check('...and the relay still answers', http('GET', '/ping', token)[0], 200)

        status, out = http('GET', '/out', token)
        check('/out hands out both replies with their chat', [(o['id'], o['chat']) for o in out], [(1, '王小明'), (2, '王小明')])
        check('/out again within the lease -> nothing', http('GET', '/out', token)[1], [])
        http('POST', '/sent', token, {'id': 1, 'chat': '王小明', 'text': tricky, 'ok': True})
        check('/sent removes the reply', http('GET', '/ping', token)[1]['queued'], 1)

        try:
            second = subprocess.run([sys.executable, RELAY, 'serve', '--dir', d, '--port', str(port)],
                                    capture_output=True, env=ENV, timeout=10)
            refused = second.returncode != 0
        except subprocess.TimeoutExpired:
            refused = False   # it bound the port and kept serving (SO_REUSEADDR on Windows)
        check('a second relay on the same port fails', refused, True)
        check('...without replacing the token', open(token_path, encoding='ascii').read().strip(), token)
        check('...and the first relay still answers', http('GET', '/ping', token)[0], 200)

        check('clear drops what is still queued', http('POST', '/clear', token, {}), (200, {'cleared': [2]}))
        check('...leaving nothing', http('GET', '/ping', token)[1]['queued'], 0)

        # The page polled /out above; with --down-after 2 the watchdog reports it.
        for _ in range(50):
            if 'DOWN' in log_kinds():
                break
            time.sleep(0.2)
        http('GET', '/out', token)
        time.sleep(0.2)
        check('log kinds, with DOWN then UP', log_kinds(),
              ['START', 'QUEUED', 'QUEUED', 'SENT', 'CLEARED', 'DOWN', 'UP'])
    finally:
        server.terminate()
        server.wait(timeout=10)

    # Right after a run that served traffic, the same port binds again.
    server = start_relay()
    check('a restart on the same port works', http('GET', '/ping', open(token_path, encoding='ascii').read().strip())[0], 200)
    server.terminate()
    server.wait(timeout=10)

print('\nALL PASSED' if failures == 0 else '\n%d FAILED' % failures)
sys.exit(1 if failures else 0)
