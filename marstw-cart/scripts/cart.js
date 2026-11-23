// 戰神 MARS (www.marstw.com) cart helper.
//
// Paste once into a tab on www.marstw.com (javascript_tool, or the DevTools
// console). It assigns globalThis.MARSCART, so re-pasting a newer copy replaces
// the old one instead of throwing "already declared".
//
//   await MARSCART.flavors(url)            -> every flavor of a product, with stock
//   await MARSCART.match(url, name)        -> what a flavor name resolves to, without adding
//   await MARSCART.add(url, name, qty)     -> put qty of that flavor in the cart
//   await MARSCART.cart()                  -> what is in the cart now
//
// The shop is SHOPLINE. The cart belongs to the browser session (cookies), so
// add() only means something in the user's own tab. Nothing here checks out,
// pays, removes or changes existing cart lines.
//
// The same file is loaded by marstw.mjs and the tests in Node, where only the
// read-only calls are used.

globalThis.MARSCART = (() => {
  const ORIGIN = 'https://www.marstw.com';

  // The product page embeds its data as
  //   app.value('product', JSON.parse('<a JS single-quoted string>'));
  // Read up to the first unescaped quote and undo the JS escapes by hand:
  // eval is blocked by CSP on some SHOPLINE shops, and the JSON inside is only
  // valid once the string literal around it is decoded.
  function embedded(html, name) {
    const marker = `app.value('${name}', JSON.parse('`;
    const start = html.indexOf(marker);
    if (start < 0) return null;
    let i = start + marker.length;
    let out = '';
    for (; i < html.length; i++) {
      const c = html[i];
      if (c === "'") return JSON.parse(out);
      if (c !== '\\') { out += c; continue; }
      const n = html[++i];
      if (n === 'u') { out += String.fromCharCode(parseInt(html.substr(i + 1, 4), 16)); i += 4; }
      else if (n === 'x') { out += String.fromCharCode(parseInt(html.substr(i + 1, 2), 16)); i += 2; }
      else out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[n] ?? n;
    }
    throw new Error(`unterminated ${name} JSON on the page`);
  }

  function csrfToken(html) {
    const m = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/);
    return m ? m[1] : null;
  }

  function productUrl(url) {
    const u = new URL(url, ORIGIN);
    if (u.hostname !== 'www.marstw.com' && u.hostname !== 'marstw.com') {
      throw new Error(`not a marstw.com link: ${url}`);
    }
    if (!u.pathname.startsWith('/products/')) throw new Error(`not a product page: ${url}`);
    return ORIGIN + u.pathname;
  }

  const zh = (t) => (t && (t['zh-hant'] || t.en || Object.values(t).find(Boolean))) || '';
  const money = (p) => (p && p.cents > 0 ? p.dollars : null);

  function summarize(product) {
    const sameStock = product.unlimited_quantity || product.out_of_stock_orderable;
    return {
      productId: product._id,
      merchantId: product.owner_id,
      title: zh(product.title_translations),
      flavors: (product.variations || []).map((v) => {
        const price = money(v.price_sale) ?? money(v.price);
        return {
          name: (v.fields || []).map((f) => zh(f.name_translations) || f.name).join(' / '),
          variationId: v.key,
          stock: v.quantity,
          limitedStock: !sameStock,
          orderable: sameStock || v.quantity > 0,
          price,
          listPrice: money(v.price),
        };
      }),
      maxOrderQuantity: product.max_order_quantity > 0 ? product.max_order_quantity : null,
    };
  }

  async function load(url) {
    const res = await fetch(productUrl(url), { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`product page returned HTTP ${res.status}`);
    const html = await res.text();
    const product = embedded(html, 'product');
    if (!product || !product._id) throw new Error('no product data on that page - is it a product page?');
    return { info: summarize(product), csrf: csrfToken(html) };
  }

  // Shop names vary in brackets, spaces and full-width characters: 「茉香奶綠（水解）」.
  const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  const base = (s) => norm(s).replace(/\(.*?\)|\[.*?\]/g, '');
  const bigrams = (s) => new Set([...s].map((c, i, a) => c + (a[i + 1] || '')));

  // How close two names are, for suggestions only. Never used to pick.
  function similarity(a, b) {
    const x = [...base(a)], y = new Set(base(b));
    const chars = x.filter((c) => y.has(c)).length / Math.max(x.length, 1);
    const bx = bigrams(base(a)), by = bigrams(base(b));
    const pairs = [...bx].filter((p) => p.length === 2 && by.has(p)).length;
    return chars + pairs * 0.5;
  }

  // Exact name, then exact name without the bracketed part, then a substring
  // that only one flavor contains. Anything else is not a match: a near miss
  // like 茉莉奶綠 vs 茉香奶綠 comes back as a suggestion for the user to confirm.
  function pick(flavors, name) {
    const q = norm(name);
    const tiers = [
      flavors.filter((f) => norm(f.name) === q),
      flavors.filter((f) => base(f.name) === base(name)),
      flavors.filter((f) => norm(f.name).includes(q)),
    ];
    for (const hits of tiers) {
      if (hits.length === 1) return { ok: true, flavor: hits[0] };
      if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits };
    }
    const candidates = flavors
      .map((f) => ({ ...f, score: similarity(name, f.name) }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ score, ...f }) => f);
    return { ok: false, reason: 'not_found', candidates };
  }

  async function flavors(url) {
    return (await load(url)).info;
  }

  async function match(url, name) {
    const { info } = await load(url);
    return { title: info.title, query: name, ...pick(info.flavors, name) };
  }

  function cartLines(cart) {
    return (cart.items || []).map((it) => ({
      itemId: it._id || it.id,
      productId: it.product_id,
      variationId: it.variation_id || null,
      title: zh(it.product && it.product.title_translations),
      flavor: ((it.variation && it.variation.fields) || []).map((f) => zh(f.name_translations) || f.name).join(' / '),
      quantity: it.quantity,
    }));
  }

  async function cart() {
    const res = await fetch(`/api/merchants/${await merchantId()}/cart`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`cart returned HTTP ${res.status}`);
    const body = await res.json();
    return cartLines(body.data || {});
  }

  async function merchantId() {
    const cfg = globalThis.mainConfig && globalThis.mainConfig.merchantId;
    if (cfg) return cfg;
    const html = await (await fetch('/', { credentials: 'same-origin' })).text();
    const m = html.match(/merchant_id":"([0-9a-f]{24})"/);
    if (!m) throw new Error('could not find the merchant id');
    return m[1];
  }

  async function add(url, name, quantity) {
    if (typeof location === 'undefined' || !/(^|\.)marstw\.com$/.test(location.hostname)) {
      throw new Error('add() must run in a www.marstw.com tab - the cart lives in that browser session');
    }
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1) throw new Error(`quantity must be a whole number >= 1, got ${quantity}`);

    const { info, csrf } = await load(url);
    const m = pick(info.flavors, name);
    if (!m.ok) return { added: false, title: info.title, query: name, ...m };
    const f = m.flavor;
    if (!f.orderable) return { added: false, reason: 'sold_out', flavor: f };
    if (f.limitedStock && f.stock < qty) return { added: false, reason: 'not_enough_stock', flavor: f };
    if (info.maxOrderQuantity && qty > info.maxOrderQuantity) {
      return { added: false, reason: 'over_max_order_quantity', max: info.maxOrderQuantity, flavor: f };
    }

    const before = await cart();
    const had = before.find((l) => l.variationId === f.variationId);

    // Same body the shop's own cartService.addItem sends.
    const res = await fetch(`/api/merchants/${info.merchantId}/cart/items`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'X-CSRF-Token': csrf || '',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({
        item: { product_id: info.productId, quantity: qty, type: 'product', variation_id: f.variationId },
        cart_options: { skip_calculate_order: true, is_cart_page: false },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.result) {
      return { added: false, reason: 'rejected', status: res.status, message: body.message || body.error || null, flavor: f };
    }
    const line = cartLines(body.data || {}).find((l) => l.variationId === f.variationId) || null;

    // Let the page's own cart badge and panel catch up, when Angular is there.
    try {
      const inj = globalThis.angular && angular.element(document.body).injector();
      if (inj && inj.has('cartService')) inj.get('cartService').fetchItems();
    } catch (_) { /* cosmetic only */ }

    return {
      added: true,
      title: info.title,
      flavor: f.name,
      quantityAdded: qty,
      quantityBefore: had ? had.quantity : 0,
      quantityInCart: line ? line.quantity : null,
      unitPrice: f.price,
    };
  }

  return { flavors, match, add, cart, _internal: { embedded, csrfToken, productUrl, summarize, pick, norm, cartLines } };
})();
