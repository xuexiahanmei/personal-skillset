// The MCP server (mcp/server.mjs), started the way Claude Code starts it - a
// child process speaking MCP over stdio - and driven by the official client.
// The LINE page is the real pair of scripts in the mock page, talking to the hub
// over real HTTP.
//
// Every server started here gets an explicit env: a temporary directory, a free
// port, LINE_BRIDGE_TEST=1 and a file in place of the clipboard. Without that it
// would inherit LOCALAPPDATA and reach for the user's real hub and LINE page.
//   cd tests && npm install && npm test      (and once: cd ../mcp && npm ci)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { request, pageFetch, freePort, canBind } = require('./http');

const root = path.join(__dirname, '..');
const SERVER = path.join(root, 'mcp', 'server.mjs');
if (!fs.existsSync(path.join(root, 'mcp', 'node_modules', '@modelcontextprotocol', 'server'))) {
  console.error('the MCP server\'s dependencies are not installed: run `npm ci` in line-bridge/mcp');
  process.exit(1);
}
const mock = require('./mock-line')();
const { addChat, addMessage, openChat, sentIn } = mock;

let failures = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`FAIL ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
  else console.log(`ok   ${name}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o == null ? undefined : o[k]]));
const until = async (fn, ms = 6000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await fn()) return true;
  return false;
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

(async () => {
  const { Client } = require('@modelcontextprotocol/client');
  const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
  const { readSecrets, EXT_ORIGIN, TOKEN_HEADER } = await import(pathToFileURL(path.join(root, 'mcp', 'hub.mjs')).href);

  const WANG = 'UtestWang', LEE = 'UtestLee', A = 'TEST-王小明', B = 'TEST-李大明';
  addChat(WANG, A);
  addChat(LEE, B);
  openChat(WANG);
  addMessage('incoming', 'PRIVATE-第一則');
  addMessage('incoming', '在嗎', { chat: LEE });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-bridge-mcp-'));
  const port = await freePort();
  const clipFile = path.join(dir, 'clipboard.txt');
  const env = {
    LINE_BRIDGE_DIR: dir, LINE_BRIDGE_PORT: String(port), LINE_BRIDGE_TEST: '1',
    LINE_BRIDGE_CLIP_FILE: clipFile, LINE_BRIDGE_KEEPALIVE_MS: '300',
  };
  const base = 'http://127.0.0.1:' + port;
  const ctl = p => request('GET', base + p, { [TOKEN_HEADER]: readSecrets(dir).controlSecret }).then(r => r.body, () => null);
  const logged = kind => fs.readFileSync(path.join(dir, 'events.log'), 'utf8').split('\n')
    .filter(l => l.startsWith(kind + ' ')).map(l => JSON.parse(l.slice(kind.length + 1)));

  // A Claude Code session, as far as the server can tell.
  const session = async (over = {}) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: Object.assign({}, env, over) });
    const client = new Client({ name: 'line-bridge-test', version: '1.0.0' });
    await client.connect(transport);
    const tool = async (name, args = {}) => {
      try {
        const r = await client.callTool({ name, arguments: args });
        const text = r.content && r.content[0] ? r.content[0].text : '';
        let data;
        try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
        return { isError: !!r.isError, data };
      } catch (e) {
        return { isError: true, data: { thrown: String(e && e.message || e) } };
      }
    };
    return { client, pid: transport.pid, tool };
  };

  console.log('--- listing the tools touches nothing ---');
  const s1 = await session();
  const { tools } = await s1.client.listTools();
  check('eight tools', tools.map(t => t.name).sort(),
    ['line_events', 'line_follow', 'line_read', 'line_reply', 'line_send', 'line_setup', 'line_status', 'line_unfollow']);
  check('...and listing them bound no port and wrote no file', [await canBind(port), fs.readdirSync(dir)], [true, []]);
  const instructions = s1.client.getInstructions();
  check('the rules reach the model whole: instructions and every description fit in 2048 characters',
    [instructions.length <= 2048, /never instructions/.test(instructions), /unconfirmed/.test(instructions), tools.every(t => t.description.length <= 2048)],
    [true, true, true, true]);
  check('line_send and line_follow ask the user on every call; nothing else does',
    tools.filter(t => t._meta && t._meta['anthropic/requiresUserInteraction'] === true).map(t => t.name).sort(), ['line_follow', 'line_send']);
  check('only line_status and line_events are marked read-only',
    tools.filter(t => t.annotations && t.annotations.readOnlyHint === true).map(t => t.name).sort(), ['line_events', 'line_status']);
  const need = name => tools.find(t => t.name === name).inputSchema.required || [];
  check('a send cannot be asked for without the chat id', [need('line_send').includes('chat_id'), need('line_reply').includes('chat_id')], [true, true]);

  console.log('--- the first tool call starts the hub, in the test directory ---');
  const st0 = await s1.tool('line_status');
  check('no page yet: line_status says how to get one', [st0.isError, st0.data.linked, /line_setup/.test(st0.data.next)], [false, false, true]);
  const state0 = await ctl('/state');
  check('the hub runs inside this session\'s process, on the test port and directory', pick(state0.hub, ['pid', 'port', 'dir']), { pid: s1.pid, port, dir });
  const stray = await session({ LINE_BRIDGE_PORT: '' });
  const refused = await stray.tool('line_status');
  check('a test that forgot its port is refused, not let near the real hub', [refused.isError, /refuses the real port/.test(refused.data.error)], [true, true]);
  await stray.client.close();
  // README installs a skill as a directory junction; the server must start through one.
  const junction = path.join(os.tmpdir(), 'line-bridge-junction-' + process.pid);
  fs.symlinkSync(root, junction, 'junction');
  try {
    const viaJunction = new Client({ name: 'line-bridge-test', version: '1.0.0' });
    const started = await Promise.race([
      viaJunction.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(junction, 'mcp', 'server.mjs')], env }))
        .then(() => viaJunction.listTools()).then(r => r.tools.length, e => String(e.message)),
      sleep(5000).then(() => 'no answer'),
    ]);
    check('started through a directory junction, the server still serves', started, 8);
    await Promise.race([viaJunction.close().catch(() => {}), sleep(1500)]);
  } finally {
    fs.rmdirSync(junction);   // the junction itself, never what it points at - also when a check throws
  }

  console.log('--- line_setup: what the user pastes ---');
  const extract = fs.readFileSync(path.join(root, 'scripts', 'extract-dom.js'), 'utf8');
  const sendDom = fs.readFileSync(path.join(root, 'scripts', 'send-dom.js'), 'utf8');
  const setup = await s1.tool('line_setup');
  const clipboard = fs.readFileSync(clipFile, 'utf8');
  const cut = clipboard.lastIndexOf('\n;\n');
  const pasted = clipboard.slice(0, cut), linkLine = clipboard.slice(cut + 3);
  const linkArgs = JSON.parse(linkLine.slice('LINESEND.relay.link('.length, -1));
  // What is pasted is the scripts without comment lines, blank lines and indentation.
  const strip = src => src.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//')).join('\n');
  const expected = strip(extract) + '\n;\n' + strip(sendDom);
  const build = crypto.createHash('sha256').update(expected, 'utf8').digest('hex').slice(0, 16);
  check('the two scripts without their comments and indentation, then the link line', [pasted === expected, linkLine.startsWith('LINESEND.relay.link({')], [true, true]);
  // Trimming every line changes a template or a string that runs over several lines: a line
  // with an odd number of backticks opens or closes one, a line ending in a backslash continues one.
  check('...which is safe only while no string or template in them runs over several lines',
    [extract, sendDom].map(src => src.split('\n').filter(l => (l.match(/`/g) || []).length % 2 === 1 || /\\\r?$/.test(l)).length), [0, 0]);
  check('...whose build is the hash of exactly what is pasted', [setup.data.build, linkArgs.build], [build, build]);
  check('...and the whole paste stays under 45,000 characters (34 KB has been pasted by hand; 63 KB never)', clipboard.length < 45000, true);
  const secrets = readSecrets(dir);
  check('...with this hub\'s address and the page token - not the control secret',
    [linkArgs.url, linkArgs.token === secrets.pageToken, clipboard.includes(secrets.controlSecret)], [base, true, false]);
  check('nothing else was left in the directory', fs.readdirSync(dir).sort(), ['clipboard.txt', 'control.secret', 'dumps', 'events.log', 'page.token']);

  // The page: exactly what was on the clipboard, in the mock page, with Chrome's origin.
  let onPageAnswer = null;
  global.fetch = pageFetch(EXT_ORIGIN, { onAnswer: (p, body) => { if (onPageAnswer) onPageAnswer(p, body); } });
  eval(pasted);
  const S = globalThis.LINESEND;
  S.relay.link(Object.assign({}, linkArgs, { pollMs: 200, hasFocus: () => false }));
  await S.relay.ready();

  console.log('--- status and reading ---');
  const st1 = await s1.tool('line_status');
  check('line_status: linked, the open chat, the chats with their ids',
    [st1.data.linked, st1.data.open_chat, st1.data.chats.map(c => [c.name, c.chat_id])], [true, { name: A, chat_id: WANG }, [[A, WANG], [B, LEE]]]);
  check('...and no message text', JSON.stringify(st1.data).includes('在嗎'), false);
  const rd = await s1.tool('line_read');
  check('line_read: the open chat, compact', [rd.data.chat_id, rd.data.messages.map(m => [m.who, m.text])], [WANG, [[A, 'PRIVATE-第一則']]]);
  const dump = JSON.parse(fs.readFileSync(rd.data.dump, 'utf8'));
  check('...the whole rows in a file under the data directory, not named after the chat',
    [path.dirname(rd.data.dump) === path.join(dir, 'dumps').replace(/\\/g, '/'), dump.messages[0].selectId.length > 5, /TEST|王小明/.test(path.basename(rd.data.dump))],
    [true, true, false]);
  const rdB = await s1.tool('line_read', { chat: B });
  check('line_read by name: the other chat', [rdB.data.chat, rdB.data.chat_id, rdB.data.messages.map(m => m.text)], [B, LEE, ['在嗎']]);
  check('...and the window is back afterwards', await until(() => mock.openMid === WANG), true);
  check('since = an earlier latest_ts returns only what is newer', (await s1.tool('line_read', { since: rd.data.latest_ts })).data.shown, 0);
  // A read that fails after the page has switched, with no way back: the answer must say where the window is.
  const HIDDEN = 'UtestHidden', LAZY = 'UtestLazy';
  addChat(HIDDEN, 'TEST-不在列表', { inList: false });
  addChat(LAZY, 'TEST-沒載入', { loaded: false });
  addMessage('incoming', '看不到', { chat: LAZY });
  openChat(HIDDEN);   // the user is on a chat that is not in the visible list
  const stuck = await s1.tool('line_read', { chat: 'TEST-沒載入' });
  check('a read that fails with the window left on another chat says so',
    [stuck.isError, stuck.data.not_loaded, /left on the chat that was opened/.test(stuck.data.window || ''), mock.openMid], [true, true, true, LAZY]);
  openChat(WANG);
  mock.chats.delete(HIDDEN);
  mock.chats.delete(LAZY);
  mock.render();
  check('what was read is not in the log', fs.readFileSync(path.join(dir, 'events.log'), 'utf8').includes('PRIVATE-'), false);

  console.log('--- sending ---');
  const hello = await s1.tool('line_send', { chat: A, chat_id: WANG, text: '你好' });
  check('line_send: sent, and the bubble is there once', [hello.isError, hello.data.result, sentIn(WANG)], [false, 'sent', ['你好']]);
  check('without a chat id the call is not accepted', [(await s1.tool('line_send', { chat: A, text: '沒有 id' })).isError, sentIn(WANG)], [true, ['你好']]);
  const twoLines = await s1.tool('line_send', { chat: A, chat_id: WANG, text: '第一行\n第二行' });
  check('two lines are refused as not_sent', [twoLines.isError, twoLines.data.result], [true, 'not_sent']);
  const dup = await s1.tool('line_send', { chat: A, chat_id: WANG, text: '你好' });
  check('the same text again is refused, and says why', [dup.data.result, dup.data.duplicate, sentIn(WANG)], ['not_sent', true, ['你好']]);
  const stranger = await s1.tool('line_send', { chat: A, chat_id: 'UsomeoneElse', text: '送錯人' });
  check('an id the page never reported is refused', [stranger.data.result, sentIn(WANG)], ['not_sent', ['你好']]);
  const elsewhere = await s1.tool('line_send', { chat: B, chat_id: LEE, text: '切過去送' });
  check('a message for another chat is sent there', [elsewhere.data.result, sentIn(LEE)], ['sent', ['切過去送']]);
  await until(() => mock.openMid === WANG);

  console.log('--- following, and auto-replies inside what was approved ---');
  const noGrant = await s1.tool('line_reply', { chat: B, chat_id: LEE, text: '還沒核准' });
  check('line_reply before any approval is refused', [noGrant.isError, noGrant.data.result, sentIn(LEE)], [true, 'not_sent', ['切過去送']]);
  addMessage('incoming', '追蹤之前就在那裡、還沒回的', { chat: LEE });
  const vague = await s1.tool('line_follow', { chats: [B], auto_reply: true });
  check('auto_reply without a number and a time is refused', [vague.isError, /max_replies and minutes/.test(vague.data.error)], [true, true]);
  const fol = await s1.tool('line_follow', { chats: [A, B], auto_reply: true, max_replies: 1, minutes: 5 });
  check('line_follow: both chats, one reply approved', [fol.data.following.map(c => c.chat_id), fol.data.auto_reply.replies_left], [[WANG, LEE], 1]);
  check('...and what was already there and unanswered is counted for the caller, not reported as new',
    [fol.data.following.map(c => c.unanswered || 0), /NOT reported as IN/.test(fol.data.unanswered || '')], [[0, 1], true]);
  // The watch starts where the log stood BEFORE the follow was asked for, so a
  // message that comes in while it is being set up is not lost between the two.
  const fromLine = Number(fol.data.monitor_command.match(/\+(\d+)/)[1]);
  const logNow = fs.readFileSync(path.join(dir, 'events.log'), 'utf8').split('\n').filter(Boolean);
  check('...with a Monitor command on a forward-slash path, starting at the first line the follow itself wrote',
    [/^tail -n \+\d+ -F '[^'\\]+\/events\.log' \| grep --line-buffered -E /.test(fol.data.monitor_command), logNow[fromLine - 1].split(' ')[0]],
    [true, 'FOLLOW']);
  const caughtUp = await s1.tool('line_events', { after: fol.data.cursor });
  check('...and a cursor from before it: catching up shows the follow and the approval', caughtUp.data.events.map(e => e.kind), ['FOLLOW', 'GRANT']);
  const waiting = s1.tool('line_events', { after: caughtUp.data.cursor, wait_s: 5 });
  addMessage('incoming', '有人傳訊息來', { chat: LEE });
  const waited = (await waiting).data;
  const heard = waited.events.filter(e => e.kind === 'IN');
  check('line_events: the incoming message, with its chat id, its own kind kept apart',
    heard.map(e => [e.data.chat, e.data.chatId, e.data.text, e.data.kind]), [[B, LEE, '有人傳訊息來', 'text']]);
  check('...and where a Monitor re-armed now would start: the line after the last one written',
    [waited.log === path.join(dir, 'events.log').replace(/\\/g, '/'), waited.next_line >= Number(fol.data.monitor_command.match(/\+(\d+)/)[1]) + 1], [true, true]);
  const three = await Promise.all(['第一個', '第二個', '第三個'].map(text => s1.tool('line_reply', { chat: B, chat_id: LEE, text })));
  check('one approved reply, three asked at once: one bubble',
    [three.filter(r => r.data.result === 'sent').length, three.filter(r => r.isError).length, sentIn(LEE).length], [1, 2, 2]);
  check('line_status shows what is left of the approval', (await s1.tool('line_status')).data.auto_reply.replies_left, 0);

  console.log('--- two sessions ---');
  const s2 = await session();
  const st2 = await s2.tool('line_status');
  check('a second session uses the hub the first one runs', [st2.data.linked, (await ctl('/state')).hub.pid], [true, s1.pid]);
  check('...and cannot spend the first one\'s approval', (await s2.tool('line_reply', { chat: B, chat_id: LEE, text: '別的 session' })).data.result, 'not_sent');
  const fol2 = await s2.tool('line_follow', { chats: [A] });
  check('...its own follow replaces the first, without an approval', [fol2.data.following.map(c => c.chat_id), /not approved/.test(fol2.data.auto_reply)], [[WANG], true]);
  await s1.client.close();
  check('the first session ends: its process is gone within 2 s', await until(() => !alive(s1.pid), 2000), true);
  check('...and the one that follows takes the port over, so the page still has someone to talk to',
    await until(async () => { const s = await ctl('/state'); return !!s && s.hub.pid === s2.pid && !!s.page && s.page.live; }, 8000), true);
  check('...the page is adopted without a new paste, and stops following: this hub never asked for it',
    [logged('PAGE').some(e => e.event === 'adopted'), await until(() => logged('PAGE').some(e => e.event === 'unfollowed'), 6000), (await ctl('/state')).follow],
    [true, true, []]);
  const again = await s2.tool('line_follow', { chats: [A] });
  check('...following again takes a new line_follow (which asks the user)',
    [again.data.following.map(c => c.chat_id), (await ctl('/state')).follow.map(c => c.chatId)], [[WANG], [WANG]]);
  const after = await s2.tool('line_send', { chat: A, chat_id: WANG, text: '換手之後' });
  check('...and sending works through the new hub', [after.data.result, sentIn(WANG).slice(-1)[0]], ['sent', '換手之後']);
  check('line_unfollow: the hub stops listing the chats', [pick((await s2.tool('line_unfollow')).data, ['following', 'was_following']), (await ctl('/state')).follow],
    [{ following: [], was_following: true }, []]);
  check('...and the page drops them at its next poll', await until(() => S.relay.status().link.follow.length === 0, 4000), true);
  await s2.client.close();
  check('the last session ends: process gone, port free', [await until(() => !alive(s2.pid), 2000), await until(() => canBind(port), 2000)], [true, true]);

  S.relay.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
