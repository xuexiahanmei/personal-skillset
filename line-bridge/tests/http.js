// HTTP helpers for the hub tests.
const http = require('http');
const net = require('net');

// One connection per request (agent: false). A pooled connection goes stale when
// a hub is closed and another takes its port, and the next request on it is
// reset - which is not what these tests are about.
function request(method, url, headers, body, { signal, onAnswer } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false, signal }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* no JSON body */ }
        if (onAnswer) onAnswer(u.pathname, parsed);
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// A fetch for the page scripts, sent the way Chrome sends it from the LINE
// extension: with that origin. onAnswer(path, body) sees each answer first.
function pageFetch(origin, hooks = {}) {
  return (url, opts = {}) => request(opts.method || 'GET', url, Object.assign({ origin }, opts.headers), opts.body,
    { onAnswer: (p, body) => { if (hooks.onAnswer) hooks.onAnswer(p, body); } })
    .then(r => ({ ok: r.status < 400, status: r.status, json: async () => r.body }),
      e => { throw new TypeError('Failed to fetch (' + e.code + ')'); });
}

const freePort = () => new Promise(resolve => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Could a server bind this port right now?
const canBind = port => new Promise(resolve => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen({ port, host: '127.0.0.1', exclusive: true }, () => s.close(() => resolve(true)));
});

module.exports = { request, pageFetch, freePort, canBind };
