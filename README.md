# Monkeytype Auto Typer

Automatically types [Monkeytype](https://monkeytype.com) tests at a configurable WPM.

**Current version: 3.1.0**

## Files

| File | Purpose |
|------|---------|
| `install.html` | Install page — copy the console script |
| `monkeytype-autotyper-console.js` | Console script (paste on monkeytype.com) |
| `monkeytype-autotyper.user.js` | Tampermonkey userscript |

## Option 1 Quick install (console paste)

1. Open **[install.html](install.html)** locally or from GitHub.
2. Click **Copy script** (loads from `monkeytype-autotyper-console.js`).
3. On [monkeytype.com](https://monkeytype.com), open DevTools console (`F12` / `Cmd+Option+J`).
4. Paste and press Enter.

## Option 2 Install Tampermonkey

Paste [`monkeytype-autotyper.user.js`](monkeytype-autotyper.user.js) into a new Tampermonkey script.

## Usage

1. Press **Tab** on Monkeytype to start a test.
2. Click **Prepare test** in the panel.
3. Set **Target WPM** → **Start typing**.

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+M` | Start / stop |
| `Escape` | Stop |

## Console API

```js
mtAutotyper.setWpm(400)
mtAutotyper.toggle()
mtAutotyper.debug()
```
