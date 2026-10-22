---
name: marstw-cart
description: "Add 戰神 MARS protein (www.marstw.com, a SHOPLINE shop) to the user's shopping cart in their own Chrome tab, and look up which flavors a product has, their price and stock. Use this whenever the user wants to buy, reorder or put something from 戰神 / MARS / marstw.com in the cart, pick a flavor (風味) from a product's dropdown, check whether a flavor is sold out, or see what is in their MARS cart - even when they only paste a marstw.com/products/ link and a flavor. Triggers include Traditional Chinese like 幫我把茉香奶綠加入購物車 4 個, 戰神乳清加四包奶茶, 買 MARS 隨手包, 這個口味還有貨嗎, 有哪些口味, 購物車裡有什麼, and English like 'add 4 jasmine milk green tea to my MARS cart'."
---

# 戰神 MARS cart

Two scripts, one source of truth:

| File | Runs in | Does |
| --- | --- | --- |
| `scripts/cart.js` | the user's Chrome tab on www.marstw.com | flavors, match, **add**, cart |
| `scripts/marstw.mjs` | Node 18+ | flavors and match only (read-only) |

`marstw.mjs` loads `cart.js` itself, so a flavor name resolves the same way in
both places.

```
S=~/.claude/skills/marstw-cart/scripts/marstw.mjs
node $S flavors <product url>            # every flavor, price, stock
node $S match <product url> <flavor>     # what a name resolves to; exit 2 = no single match
```

## Why adding has to happen in the browser

The cart belongs to the browser session cookie (guest or logged in). A request
from Node or curl creates a separate guest cart the user never sees. So `add`
only exists in `cart.js`, and it refuses to run anywhere but a marstw.com tab.

## Adding to the cart

1. **Resolve the flavor first, with Node.** `node $S match <url> <flavor>`.
   - Exit 0: one flavor, use its exact name from the output.
   - `沒有這個口味` (not found) or `符合不只一個口味` (ambiguous): **ask the user**
     which one they mean, showing the candidates. Do not substitute a near miss
     yourself. 茉莉奶綠 is not 茉香奶綠, even though it is almost certainly what
     they meant, and 奶綠 alone matches two flavors.
   - Sold out (`✗` / `售完`): tell the user; it cannot be added.
2. **Open a tab with the Claude in Chrome tools.** `tabs_context_mcp` (never reuse a
   tab id from another session), then `navigate` a new tab to the product URL. Any
   www.marstw.com page works, but the product page lets the user see the result.
3. **Paste `scripts/cart.js` with `javascript_tool`.** Read the file and send its
   whole text. It defines `MARSCART`. A `navigate` or reload drops it; paste again.
4. **Add**, with the exact flavor name from step 1:
   ```js
   await MARSCART.add(location.href, '茉香奶綠(水解)', 4)
   ```
   It checks stock and the shop's per-order limit, sends the same request as the
   page's own 加入購物車 button, and returns:
   ```
   { added: true, flavor, quantityAdded: 4, quantityBefore: 0, quantityInCart: 4, unitPrice: 70 }
   ```
   or `{ added: false, reason }` with `reason` one of `not_found`, `ambiguous`
   (with `candidates`), `sold_out`, `not_enough_stock`, `over_max_order_quantity`,
   `rejected` (the shop said no; `status` and `message` say why).
5. **Report** what was added and the new total for that flavor
   (`quantityInCart`). If the user already had some, say so: adding 4 to an
   existing 2 gives 6, not 4. `await MARSCART.cart()` lists every line.

`add` adds to what is there. It never removes or lowers a line. If the user wanted
"exactly 4" and there were already some, tell them and let them fix it on the cart
page.

## Things that will mislead you

- **The 風味 dropdown is AngularJS** (`ng-model="variationName[$index]"`,
  `ng-options="variation for variation in product.digest_variations[$index]"`).
  Setting the `<select>`'s value from script does not update Angular's model, so
  clicking the button afterwards adds the previously selected flavor, or nothing.
  Use `MARSCART.add`, which skips the form entirely.
- **Names change.** The shop renames and adds flavors (dated lots like
  `黑可可20克(26.12.17)`, `(水解)` / `(多效)` / `(高熱量)` lines). Always resolve
  against the live page with `match`, never from memory or from this file.
- **Shown price is the sale price.** `price` is what the cart charges (NT$70 when
  the list price is 80). Members may see a lower price after logging in.
- **The cart badge may lag.** `add` asks the page's `cartService` to refresh, but
  if the header count looks stale, reload; the cart itself is already updated.

## Limits

- Never check out, pay, apply coupons or change the delivery address. Stop at the
  cart and tell the user it is ready for them to check out.
- One product page per `add`. For several flavors, call `add` once per flavor.

## Testing

```
node ~/.claude/skills/marstw-cart/tests/run.mjs          # offline + live read of the page
MARSTW_OFFLINE=1 node .../tests/run.mjs                  # offline only
MARSTW_LIVE_ADD=1 node .../tests/run.mjs                 # also add() for real in a throwaway guest cart
```
