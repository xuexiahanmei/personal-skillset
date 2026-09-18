// Tests for scripts/extract-dom.js against a fixture copy of Discord's DOM.
//
//   npm install && npm test
//
// These cover the parts that are easy to get wrong and silent when they break:
// which content element belongs to a reply, senders on grouped messages, and
// messages that carry no sender or timestamp at all.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const src = fs.readFileSync(path.join(root, 'scripts', 'extract-dom.js'), 'utf8');

// runScripts: 'outside-only' gives the window a real JS realm, so window.eval
// below runs with document, getComputedStyle and MutationObserver in scope.
// Without it window.eval is just Node's and the extractor cannot see the DOM.
const dom = new JSDOM(html, {
  url: 'https://discord.com/channels/900000000000000001/900000000000000001',
  runScripts: 'outside-only',
});
const { window } = dom;

// jsdom has no layout engine, so innerText is undefined there. The extractor
// reads innerText because on real Discord it is what turns emoji images and
// mentions into readable text; textContent is the closest stand-in here.
Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
  get() { return this.textContent; },
  configurable: true,
});

// Naming the local binding X rather than DISCORDX matters: the source assigns
// globalThis.DISCORDX, and a const of the same name in this scope would shadow
// it and throw before the assignment completes.
window.eval(src);
const X = window.DISCORDX;

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
  }
}

function ok(name, cond) {
  check(name, !!cond, true);
}

const msgs = X.dump();
const by = (suffix) => msgs.find((m) => m.messageId.endsWith(suffix));

// --- shape -----------------------------------------------------------------
check('dump returns every message', msgs.length, 6);
check('oldest first', msgs[0].messageId.endsWith('001'), true);
check('channel id comes off the li id', msgs[0].channelId, '900000000000000001');

// --- senders ---------------------------------------------------------------
check('group start reads its own sender', by('001').sender, 'Alex Rivera');
check('grouped follow-up inherits the sender', by('002').sender, 'Alex Rivera');
check('follow-up is marked as not a group start', by('002').groupStart, false);
check('a new group starts a new sender', by('003').sender, 'Sam Okafor');
check('system messages get no sender', by('005').sender, null);

// --- timestamps ------------------------------------------------------------
check('timestamp comes from the datetime attribute', by('001').ts, '2026-09-18T02:20:00.000Z');
check('grouped messages keep their own timestamp', by('002').ts, '2026-09-18T02:20:30.000Z');
ok('a message with no <time> still gets a timestamp from its snowflake', by('005').ts);
check('the snowflake fallback decodes to the right year', by('005').ts.slice(0, 4), '2026');

// --- replies: the trap this file exists for --------------------------------
const reply = by('003');
ok('the reply is recognised', reply.replyTo);
check('the reply keeps its OWN body, not the quoted one', reply.text, 'nice, thanks for checking');
check('the quote keeps the original text', reply.replyTo.text, 'deploy is green');
check('the quote points at the original by id', reply.replyTo.messageId, '1550000000000000001');
check('the quoted sender is read', reply.replyTo.sender, 'Alex Rivera');
check('a quote whose original is loaded is marked resolved', reply.replyTo.resolved, true);
check('a plain message has no replyTo', by('001').replyTo, null);

// --- attachments and embeds ------------------------------------------------
const media = by('004');
check('the embed is picked up', media.embeds.length, 1);
ok('the embed keeps its title', media.embeds[0].includes('A post title'));
check('the image is counted', media.images, 1);
check('the attachment link is kept', media.files.length, 1);
ok('the signed query string is stripped off attachment urls', !media.files[0].includes('?'));
check('a plain message has no embeds', by('001').embeds.length, 0);

// --- system and edited -----------------------------------------------------
check('system messages are flagged', by('005').system, true);
check('ordinary messages are not flagged as system', by('001').system, false);
check('edits are flagged', by('006').edited, true);
check('unedited messages are not flagged', by('001').edited, false);

// --- text cleaning ---------------------------------------------------------
ok('zero-width padding is stripped', by('006').text.startsWith('on it'));
ok('no zero-width characters survive anywhere', !msgs.some((m) => /[\u200B-\u200D\uFEFF]/.test(m.text)));

// --- dividers and channel --------------------------------------------------
check('the date divider is readable', X.dividers(), ['September 18, 2026']);
const ch = X.channel();
check('the composer label names the destination', ch.composerLabel, 'Message #general');
check('a channel with a composer is not read-only', ch.readOnly, false);
check('loaded counts the rendered messages', ch.loaded, 6);

// --- summarize -------------------------------------------------------------
const digest = X.summarize(msgs);
ok('the digest marks the reply', digest.includes('[re Alex Rivera:'));
ok('the digest names senders', digest.includes('Sam Okafor:'));
ok('the digest marks system messages', digest.includes('*:'));
ok('the digest notes images', digest.includes('<1 img>'));
check('the digest has one line per message', digest.split('\n').length, 6);

// --- targets(): turning a name into somewhere to navigate ------------------
const all = X.targets();
check('both DMs and channels are listed', all.length, 3);
check('sidebar furniture is not mistaken for a channel', all.filter((t) => t.type === 'channel').length, 1);
check('a DM gets a full url', X.targets('Alexis Chen')[0].url, 'https://discord.com/channels/@me/1200000000000000002');
check('a channel gets its id', X.targets('general')[0].channelId, '900000000000000001');
check('the kind is kept', X.targets('general')[0].type, 'channel');
// "Alex" is a substring of "Alexis Chen", so a plain contains-match would return
// two results and picking the first would open the wrong conversation.
check('an exact name wins over a longer one containing it', X.targets('Alex Rivera').length, 1);
check('a partial name still returns the candidates', X.targets('Alex').length, 2);
check('an unknown name returns nothing', X.targets('nobody here').length, 0);

// --- watch(): the echo a send leaves behind --------------------------------
// Sending paints the message locally under one id, then swaps in the server's
// copy under another and removes the first. Reproduce that here: two <li>s
// arrive, the first is then detached, and only the survivor should come out.
function makeItem(messageId, text) {
  const li = window.document.createElement('li');
  li.id = `chat-messages-900000000000000001-${messageId}`;
  li.className = 'messageListItem__5126c';
  li.innerHTML =
    `<div class="message__5126c groupStart__5126c wrapper_c19a55">` +
    `<div class="contents_c19a55">` +
    `<h3><span id="message-username-${messageId}">` +
    `<span class="username_c19a55" data-text="Alex Rivera">Alex Rivera</span></span>` +
    `<span><time id="message-timestamp-${messageId}" datetime="2026-09-18T02:30:00.000Z"></time></span></h3>` +
    `<div id="message-content-${messageId}" class="markup__75297">${text}</div>` +
    `</div><div id="message-accessories-${messageId}"></div></div>`;
  return li;
}

const list = window.document.querySelector('ol[data-list-id="chat-messages"]');
const seenLive = [];
const started = X.watch((m) => seenLive.push(m.text));
check('watch reports that it started', started.ok, true);
check('watch records how many messages it started from', started.baseline, 6);

const echo = makeItem('1550000000000000007', 'shipping it');
const real = makeItem('1550000000000000008', 'shipping it');
list.appendChild(echo);
list.appendChild(real);
echo.remove();

// MutationObserver callbacks are queued as microtasks, so let them run.
setTimeout(() => {
  check('the callback sees both the echo and the real message', seenLive.length, 2);

  const collected = X.collect();
  check('collect drops the echo', collected.length, 1);
  check('collect keeps the message that survived', collected[0].messageId, '1550000000000000008');
  check('collect parses the survivor properly', collected[0].sender, 'Alex Rivera');
  check('collect drains the buffer', X.collect().length, 0);
  check('stop() returns cleanly', X.stop(), true);

  // --- the harness redaction trap ------------------------------------------
  // Any JSON key containing "author" is redacted by the harness's secret scanner
  // (it is guarding "authorization"), which silently blanks the field. Keeping
  // the field named "sender" is a real constraint, not a style choice.
  ok('no field is named author', !JSON.stringify(msgs).toLowerCase().includes('"author'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 0);
