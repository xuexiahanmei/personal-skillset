// Read-only look at a 戰神 MARS product from the command line (Node 18+).
//
//   node marstw.mjs flavors <product url> [--json]       every flavor, price and stock
//   node marstw.mjs match <product url> <flavor> [--json] what a flavor name resolves to
//
// It loads scripts/cart.js, the same code that runs in the browser tab, so a name
// that matches here matches there. Adding to the cart is not offered here: a cart
// made from Node belongs to a throwaway guest session the user never sees.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export function loadCart() {
  const src = readFileSync(fileURLToPath(new URL('./cart.js', import.meta.url)), 'utf8');
  const ctx = vm.createContext({ fetch, URL, console });
  vm.runInContext(src, ctx);
  return ctx.MARSCART;
}

function fmtFlavor(f) {
  const stock = !f.limitedStock ? '不限量' : f.stock > 0 ? `庫存 ${f.stock}` : '售完';
  const price = f.price == null ? '' : f.listPrice && f.listPrice !== f.price ? `NT$${f.price} (原價 ${f.listPrice})` : `NT$${f.price}`;
  return `${f.orderable ? '  ' : '✗ '}${f.name}  ${price}  ${stock}`;
}

async function main(argv) {
  const json = argv.includes('--json');
  const [cmd, url, ...rest] = argv.filter((a) => a !== '--json');
  const M = loadCart();
  const out = (v) => console.log(JSON.stringify(v, null, 2));

  if (cmd === 'flavors' && url) {
    const info = await M.flavors(url);
    if (json) return out(info);
    console.log(info.title);
    for (const f of info.flavors) console.log(fmtFlavor(f));
    return;
  }
  if (cmd === 'match' && url && rest.length) {
    const r = await M.match(url, rest.join(' '));
    if (json) return out(r);
    if (r.ok) return console.log(`「${r.query}」 -> ${fmtFlavor(r.flavor).trim()}`);
    console.log(`「${r.query}」 ${r.reason === 'ambiguous' ? '符合不只一個口味' : '沒有這個口味'}${r.candidates.length ? ',候選:' : ''}`);
    for (const f of r.candidates) console.log(fmtFlavor(f));
    process.exitCode = 2;
    return;
  }
  console.error('usage: node marstw.mjs flavors <product url> [--json]\n       node marstw.mjs match <product url> <flavor> [--json]');
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
