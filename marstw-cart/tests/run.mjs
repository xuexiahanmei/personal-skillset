// node tests/run.mjs                 offline checks + a live read of the product page
// MARSTW_OFFLINE=1 node ...          offline checks only
// MARSTW_LIVE_ADD=1 node ...         also run add() for real, in a throwaway guest
//                                    session with its own cookies (not the user's cart)
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCart } from '../scripts/marstw.mjs';

const URL_ = 'https://www.marstw.com/products/戰神-mars-乳清蛋白全系列';
const M = loadCart();
const I = M._internal;

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

const fl = (name, stock = 10) => ({ name, variationId: name, stock, limitedStock: true, orderable: stock > 0 });
const FLAVORS = [fl('奶茶(水解)'), fl('茉香奶綠(水解)'), fl('烏龍奶茶(水解)', 0), fl('黑可可(水解)'),
  fl('黑可可20克(26.12.17)', 0), fl('輕盈纖奶綠(多效)', 0)];

await check('embedded decodes the JS string literal around the JSON', () => {
  const html = `<script>app.value('product', JSON.parse('{\\"_id\\":\\"p1\\",\\"t\\":\\"\\u8309\\u9999\\",\\"s\\":\\"a\\/b\\",\\"q\\":\\"it\\'s\\"}'));</script>`;
  // Objects from the vm context have that realm's prototypes; compare as plain JSON.
  assert.deepEqual(JSON.parse(JSON.stringify(I.embedded(html, 'product'))), { _id: 'p1', t: '茉香', s: 'a/b', q: "it's" });
  assert.equal(I.embedded(html, 'products'), null);
});

await check('productUrl keeps only marstw product pages', () => {
  assert.equal(I.productUrl('https://www.marstw.com/products/abc?x=1#y'), 'https://www.marstw.com/products/abc');
  assert.throws(() => I.productUrl('https://example.com/products/abc'), /not a marstw/);
  assert.throws(() => I.productUrl('https://www.marstw.com/categories/abc'), /not a product page/);
});

await check('pick: exact, without brackets, unique substring', () => {
  assert.equal(I.pick(FLAVORS, '茉香奶綠(水解)').flavor.name, '茉香奶綠(水解)');
  assert.equal(I.pick(FLAVORS, '茉香奶綠（水解）').flavor.name, '茉香奶綠(水解)');
  assert.equal(I.pick(FLAVORS, '茉香奶綠').flavor.name, '茉香奶綠(水解)');
  assert.equal(I.pick(FLAVORS, '奶茶').flavor.name, '奶茶(水解)');   // base name beats substring
  assert.equal(I.pick(FLAVORS, '黑可可').flavor.name, '黑可可(水解)');
  assert.equal(I.pick(FLAVORS, '烏龍').flavor.name, '烏龍奶茶(水解)');
});

await check('pick: a near miss is a suggestion, never a match', () => {
  const r = I.pick(FLAVORS, '茉莉奶綠');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
  assert.equal(r.candidates[0].name, '茉香奶綠(水解)');
});

await check('pick: several substring hits are ambiguous', () => {
  const r = I.pick(FLAVORS, '奶綠');
  assert.equal(r.reason, 'ambiguous');
  assert.deepEqual(r.candidates.map((f) => f.name), ['茉香奶綠(水解)', '輕盈纖奶綠(多效)']);
});

await check('add refuses to run outside a marstw tab', async () => {
  await assert.rejects(M.add(URL_, '茉香奶綠', 1), /must run in a www\.marstw\.com tab/);
});

if (!process.env.MARSTW_OFFLINE) {
  await check('live: product page parses and has flavors', async () => {
    const info = await M.flavors(URL_);
    assert.match(info.merchantId, /^[0-9a-f]{24}$/);
    assert.ok(info.flavors.length > 5);
    assert.ok(info.flavors.every((f) => f.variationId && f.name));
  });
}

if (process.env.MARSTW_LIVE_ADD) {
  await check('live: add() in a guest session puts the line in that cart', async () => {
    // A fetch that keeps cookies and resolves relative URLs, like a browser tab.
    const jar = new Map();
    const tabFetch = async (u, opts = {}) => {
      const headers = { ...(opts.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
      const res = await fetch(new URL(u, 'https://www.marstw.com'), { ...opts, headers });
      for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
      return res;
    };
    const src = readFileSync(fileURLToPath(new URL('../scripts/cart.js', import.meta.url)), 'utf8');
    const ctx = vm.createContext({ fetch: tabFetch, URL, console, location: { hostname: 'www.marstw.com' } });
    vm.runInContext(src, ctx);
    const info = await ctx.MARSCART.flavors(URL_);
    const f = info.flavors.find((x) => x.orderable && x.stock >= 2);
    const r = await ctx.MARSCART.add(URL_, f.name, 2);
    assert.equal(r.added, true, JSON.stringify(r));
    assert.equal(r.quantityInCart, 2);
    const again = await ctx.MARSCART.add(URL_, f.name, 1);
    assert.equal(again.quantityBefore, 2);
    assert.equal(again.quantityInCart, 3);
    const lines = await ctx.MARSCART.cart();
    assert.equal(lines.find((l) => l.variationId === f.variationId).quantity, 3);
  });
}

if (failed) { console.log(`\n${failed} failed`); process.exitCode = 1; } else console.log('\nall passed');
