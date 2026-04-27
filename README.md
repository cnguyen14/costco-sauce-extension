# Costco Sauce — Extension

Chrome extension that helps you manage Costco wishlists and accept curated lists pushed from the admin server.

## What it does

- **Manage** — view every wishlist on your account, rename or delete lists, expand a list to see real product names, remove items individually.
- **Remote** — link to the admin once, then any list of SKUs the admin pushes is added to your account automatically. Pause anytime.

It reuses your existing `costco.com` browser session — no login, no password, no telemetry.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** → select this `extension/` folder.
4. Pin the extension for one-click access.

After editing source files, reload the extension card *and* refresh any open `costco.com` tab.

## Usage

1. Sign in to `https://www.costco.com` and keep the tab open.
2. Open the extension popup. The user card at the top shows which Costco account you're signed into.
3. **Manage tab** — browse and clean up your lists.
4. **Remote tab** — click *Register with admin*, send the generated token to the admin out-of-band, wait for approval. Once approved, pushes start landing in your lists automatically.

To stop receiving pushes temporarily, toggle *Pause remote control*. To re-link from scratch, click *Reset registration*.
