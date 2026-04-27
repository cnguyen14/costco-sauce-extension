# Costco Bulk Add to List

A Chrome (Manifest V3) extension that bulk-adds SKUs / UPCs to a Costco
list (wishlist) and lets you manage existing lists — rename, delete,
inspect items, remove items — from a single popup.

It works by reusing your existing costco.com browser session: it never
sees your password, never logs in for you, and never stores anything
outside the local Chrome profile.

---

## 1. Features

### Bulk Add tab
- Paste any number of SKUs / UPCs (one per line, comma-, or semicolon-separated)
- Choose an existing list or create a new one
- Pick a quantity (1–99)
- One click adds every item; failed lookups are reported individually
- UPC → SKU resolution via Costco's own search redirect

### Manage tab
- Lists every wishlist on your account with item count
- Rename a list (inline prompt)
- Delete a list (with confirmation)
- Expand a list to see its items
  - Items show the real product name (fetched from Costco's catalog API)
  - Falls back to `Item <SKU>` if name lookup is unavailable
- Remove individual items from a list

### Other
- Costco logo as the extension icon
- Status banner shows auth state (signed in, expired, ready)
- All UI strings in English

---

## 2. Installation (unpacked)

1. Clone or copy this folder somewhere stable.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `extension/` folder.
5. Pin the extension if you want quick access.

To update after editing source files: hit the reload icon on the
extension card in `chrome://extensions`, then **also reload any open
costco.com tab** (content scripts do not auto-inject into existing tabs).

---

## 3. Usage

### Sign in first
Open `https://www.costco.com`, sign in normally, and keep the tab open.
The extension reads the JWT from `sessionStorage` of that tab — it does
not run a separate login.

The status banner at the top of the popup tells you the current state:
- **Ready.** — JWT is valid and product names will work.
- **Ready (visit any product page once to enable item names).** — JWT is
  valid but the catalog API headers haven't been captured yet. Open any
  product page once and the catalog cache populates.
- **Token expired. / Not signed in.** — refresh or re-sign-in on the
  costco.com tab.

### Bulk add items
1. Switch to the **Bulk Add** tab (default).
2. Pick a target list, or type a name and click **Create**.
3. Paste SKUs / UPCs into the textarea. Mixed input is fine, e.g.:

   ```
   1921586
   4000372798
   0883149754321
   ```

4. Set the quantity, click **Add all to list**.
5. The log shows ✓ / ✗ per item.

### Manage lists and items
1. Switch to the **Manage** tab.
2. Each list card shows a title, item count, ✎ rename, 🗑 delete.
3. Click the row (or caret) to expand and see items.
4. Each item row shows product name, SKU (`#1921586`), and a 🗑 button.

---

## 4. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Browser tab: https://www.costco.com/...                   │
│                                                             │
│  ┌──────────────── MAIN world ─────────────┐                │
│  │  inject.js  (document_start)            │                │
│  │  • wraps window.fetch + XHR             │                │
│  │  • intercepts gdx-api requests          │                │
│  │  • postMessage(headers) ─────┐          │                │
│  └──────────────────────────────┼──────────┘                │
│                                 ▼                           │
│  ┌────────────── ISOLATED world ──────────────┐             │
│  │  content.js  (document_idle)               │             │
│  │  • reads JWT from sessionStorage           │             │
│  │  • caches gdx headers in chrome.storage    │             │
│  │  • calls api.digital.costco.com (JWT)      │             │
│  │  • calls gdx-api.costco.com (capt. hdrs)   │             │
│  │  • exposes message API: ping, getLists,    │             │
│  │    createList, renameList, deleteList,     │             │
│  │    addEntry, deleteEntry, resolveItem,     │             │
│  │    getProductNames                         │             │
│  └────────────────────▲───────────────────────┘             │
└─────────────────────────┼───────────────────────────────────┘
                          │ chrome.tabs.sendMessage
┌─────────────────────────┴───────────────────────────────────┐
│  Extension popup  (popup.html / popup.css / popup.js)       │
│  • Bulk Add tab   ┐                                         │
│  • Manage tab     ┘  drives the content script via          │
│                      cmd messages above                     │
└─────────────────────────────────────────────────────────────┘
```

### Why two worlds?

`api.digital.costco.com` accepts the user's JWT (Azure B2C token) found
in `sessionStorage`. The ISOLATED-world content script can read
`sessionStorage` and replay the JWT — no problem.

`gdx-api.costco.com` does **not** accept the JWT. It uses a `client-identifier`
header that is generated by the page's runtime and never persisted to
storage. Arbitrary UUIDs return 401. The only reliable way to obtain a
fresh, valid value is to observe an in-flight gdx-api request from the
page itself, which requires hooking `window.fetch` in the **MAIN** world
(the page's own JS context). The MAIN-world script then forwards the
captured headers to the ISOLATED-world content script via `window.postMessage`.

---

## 5. File structure

```
extension/
├── manifest.json          # MV3 manifest, 2 content scripts, host perms
├── content.js             # ISOLATED world: API client, message handlers
├── inject.js              # MAIN world: fetch/XHR wrapper, header capture
├── popup.html             # Tab UI shell
├── popup.css              # Material-ish styling, Costco blue
├── popup.js               # Tab logic, Bulk Add + Manage views
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── DOC.md                 # this file
```

---

## 6. APIs used

### `https://api.digital.costco.com` — JWT-authenticated

Required headers on every call:
- `authorization: <JWT>` — raw JWT, no `Bearer` prefix.
- `client-id: 4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf` — public web client.
- `content-type: application/json`, `accept: application/json` for body methods.

| Method | Path                                    | Purpose                            |
| ------ | --------------------------------------- | ---------------------------------- |
| GET    | `/baskets/lists/`                       | Fetch all of the user's lists.     |
| GET    | `/baskets/lists/{id}`                   | Fetch one list incl. `items[]`.    |
| POST   | `/baskets/lists/`                       | Create a list (`title`, `type:"WishList"`). |
| PATCH  | `/baskets/lists/{id}`                   | Rename / change description.       |
| DELETE | `/baskets/lists/{id}`                   | Delete a list.                     |
| POST   | `/baskets/lists/{id}/entries`           | Add an item by `itemNumber`.       |
| DELETE | `/baskets/lists/{id}/entries/{lineId}`  | Remove an item (use entry `id`).   |

> `PUT /baskets/lists/{id}` returns 404 — the API only accepts PATCH for
> updates.

### `https://gdx-api.costco.com` — captured-header authenticated

Required headers (no `authorization`):
- `client-identifier: <UUID>` — session-bound, captured from page traffic.
- `client-id: <UUID>` — captured at the same time.
- `costco-env: prd`
- `accept: application/json`

| Method | Path                                                    | Purpose                                |
| ------ | ------------------------------------------------------- | -------------------------------------- |
| GET    | `/catalog/product/product-api/v1/products/summary/`     | Batch product names, images, etc.     |

Query string: `clientId=<id>&items=<comma-list>&whsNumber=847&locales=en-us`.
Response: `productData[]`. Name lives at `descriptions[0].object.shortDescription`.

### UPC → SKU resolution

The popup accepts UPC inputs. The content script issues a request to:

```
https://www.costco.com/CatalogSearch?dept=All&keyword=<UPC>
```

If Costco redirects to a PDP URL (`/p/.../<itemNumber>`), the SKU is
extracted from the page HTML by matching `AddToListButtonAddToList_(\d+)`
in the rendered React markup.

---

## 7. Authentication model

The extension never handles credentials directly. The flow is:

1. User signs in to `costco.com` → Azure B2C
   (`signin.costco.com`) issues a JWT.
2. Costco's web app stores it in `sessionStorage` under a key like
   `authToken_<hash>`.
3. The content script reads any `sessionStorage` key matching that
   prefix whose value is longer than 100 chars.
4. `exp` is decoded from the JWT payload to detect expiry (~15 min).
5. When the token is missing or expired, the popup shows an error and
   asks the user to refresh the costco.com tab.

For gdx-api, the MAIN-world `inject.js` watches outgoing requests for
the `client-identifier` header (and `client-id`, `costco-env`), then
forwards them to the ISOLATED world via `window.postMessage` with a
`source: "COSTCO_BULK_ADDER"` tag. The ISOLATED world stores them in
`chrome.storage.local` so they survive popup reopens within the
session's validity.

---

## 8. Permissions explained

```json
"permissions": ["activeTab", "storage"],
"host_permissions": [
  "https://www.costco.com/*",
  "https://api.digital.costco.com/*",
  "https://gdx-api.costco.com/*"
]
```

- `activeTab` — lets the popup talk to the current Costco tab.
- `storage` — caches the captured gdx-api headers.
- `host_permissions` — required for `fetch()` from the content script to
  hit the two backend hostnames; without them, browser CORS would block
  the calls even though they originate from a Costco-side script.

The extension does **not** request `cookies`, `tabs`, `webRequest`, or
broad host access — only the three Costco hostnames it needs.

---

## 9. Limitations and known caveats

- **15-minute token lifetime.** When the JWT expires, you have to
  reload (or revisit) the costco.com tab to renew. The popup detects
  this and tells you.
- **Existing tabs after reload.** If you reload the extension via
  `chrome://extensions`, content scripts do **not** automatically
  re-inject into already-open costco.com tabs. Reload those tabs.
- **Product names need one prior page hit.** The very first popup
  invocation after install may not yet have captured gdx-api headers.
  Open any product page once and the cache populates immediately.
- **Rate limits.** The Bulk Add loop is sequential (one POST at a
  time). Costco does not document a hard rate limit, but bursting
  hundreds of calls in parallel is asking for trouble.
- **Region.** All requests use `whsNumber=847` and `locales=en-us`.
  Other regions may need different values.
- **UPC lookup is best-effort.** It depends on Costco's catalog search
  redirecting to a PDP. Some valid UPCs will not resolve.

---

## 10. Troubleshooting

| Symptom                                          | Likely cause / fix                                                |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `No response from content script.`               | Reload the costco.com tab.                                        |
| `Token expired.`                                 | Refresh the costco.com tab.                                       |
| `Not signed in.`                                 | Sign in to costco.com.                                            |
| `Product info not yet available.`                | Open any costco.com product page once, then reopen the popup.     |
| Manage tab shows `Item 1234567` instead of name  | Same as above — gdx-api headers not yet captured.                 |
| `gdx summary → 401`                              | `client-identifier` is stale. Visit a fresh page to recapture.    |
| `✗ <UPC>: could not resolve UPC to item number`  | UPC didn't land on a PDP. Try with the SKU instead.               |
| Extension card shows red "Errors" badge          | Open the card → service worker / content script logs reveal it.   |

---

## 11. Development notes

- **Manifest V3, no service worker.** All logic runs in content
  scripts and the popup. There is no background script because nothing
  needs to outlive the popup.
- **`world: "MAIN"`** in `content_scripts` requires Chrome 111+.
- The MAIN-world script intentionally posts on every gdx-api request
  (not just the first), so even if the ISOLATED listener wasn't yet
  attached at `document_start`, subsequent requests refresh the cache.
- All API errors propagate as plain `Error` messages back through the
  `chrome.tabs.sendMessage` callback. The popup renders them in the
  log area for the active tab.
- No build step. Edit a file, reload the extension, reload the
  costco.com tab.

---

## 12. Security posture

- **No credentials handled.** The extension reuses the page's existing
  authenticated session.
- **No remote endpoints contacted other than `*.costco.com`.** No
  telemetry, no analytics, no third-party scripts.
- **Stored data is local only.** `chrome.storage.local` holds nothing
  but the captured Costco request headers.
- **`<all_urls>` is not requested.** Only the three Costco hostnames.
- **Inputs are user-typed.** The bulk box is split by whitespace /
  commas / semicolons; only digits proceed past `isUpc()` or are
  passed through as SKU strings. URLs constructed from those inputs
  use `encodeURIComponent`.

---

## 13. Version history

- **1.1.0** — Manage tab (rename / delete lists, view items with names,
  remove items). Costco logo icons. MAIN-world inject.js for catalog
  header capture. Storage permission added.
- **1.0.0** — Initial Bulk Add functionality.
