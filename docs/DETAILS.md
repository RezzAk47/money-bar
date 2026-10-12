# Money Bar: technical details

The [README](../README.md) is the short version. This page has the full detail: the data file, how saves are protected, what
was tested, and how the app differs from the SwiftUI Mac [money-bar](https://github.com/RezzAk47/money-bar).

Money Bar is not financial advice or accounting software.

## Where the data lives

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/MoneyBar` |
| Windows | `%APPDATA%\MoneyBar` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/MoneyBar` |

`MONEYBAR_DATA_DIR` overrides the folder (every test and manual run sets it to a temp folder). Files: `entries.json`,
`entries.backup.json` (last good copy, rolled only when entries change), `entries.backup-daily.json` (the file from before the
first change of each local day), `entries.broken-*.json` (an unreadable file kept by "Keep a copy and start over").

The app has its own identifier (`app.moneybar.cross`) and tray icon; it does not touch the Mac app, its login item or its
notifications. Both apps can use the same `entries.json`.

## The file format (same as the Mac app)

`{ version, settings: {...}, entries: [...] }`. Entries hold integer cents (1 to 100,000,000), `kind` (expense/income/tip),
`category`, `note`, `date` (`yyyy-MM-dd`), `created` (seconds), `sample`, optional `recurring` (rule id). Settings hold
currency, week start (1 = Sunday ... 7), menu bar mode, theme/layout/glass/blur, report chart, items shown, budgets, budget
alert record, recurring rules and custom categories.

* Strict decode with named errors (`entries > #2 > cents: ...`). A file that cannot be read is **never overwritten**; nothing
  saves until you fix it or choose "Keep a copy and start over" (it asks first: "Yes, keep a copy and start over" or Cancel).
* Keys this app does not know are kept (top level and inside `settings`) and written back; `version` written is
  max(file, current).
* Writes are atomic (temp file, fsync, rename). **A symlinked `entries.json` is followed only when it points at a valid Money
  Bar file you own**: an existing regular file (not a folder, device or pipe), owned by the current user (Unix), that is empty or
  a JSON object with a number `version`, an `entries` array and/or a `settings` object. Anything else (a dangling link,
  `~/.zshrc`, `authorized_keys`, another program's JSON) is refused with a named error shown in the popup and nothing is written.
  The target is re-checked (same file, same device and inode) right before the rename, and the temp file is made in the data
  folder when the target is on the same filesystem, otherwise next to the validated target only. Backups
  (`entries.backup*.json`) and `.broken-*` copies are never written through a link: a link with such a name is replaced by the
  new file and its target is untouched. Hard links keep their other name's content (rename-over replaces only the data file's
  name). A data folder that is itself a link is allowed (you made it). Leftover temp files older than a minute are removed at
  start. Edits made outside the app are noticed by size + modification time every 2 seconds and before every click.
* Recurring entry ids are derived from rule + date with the same hash as the Mac app, so both apps make identical ids and never
  double-add.

## Design

* `src/core/` is pure TypeScript (no DOM, no Tauri): money, categories (reserved "Debt payment" with letters-only folding),
  civil date maths, periods, reports, budgets, month-at-a-glance, recurring rules, CSV, themes and contrast, the store.
  Periods use plain calendar days, so DST and a day without midnight (America/Sao_Paulo 2018-11-04) cannot lose or double a day.
* `src/ui/` is Preact: header, add form, Today cards (+ card payments line), budgets strip, recent list (edit, delete with a
  confirm, repeat icon, "Card payment" rows), Reports (day/week/month/custom, SVG bars or line, donut, budget bars, glance;
  clicking a category row opens a small inline form for its monthly budget, with the same rules as Settings; Escape closes
  only that form), Settings (themes, layout, glass/blur, items shown, budgets, recurring list with inline editor that starts
  in the amount field and closes on Escape without leaving Settings, categories, sample data, data info).
* `src-tauri/` is the shell: tray with the menu-bar text as title (macOS) and tooltip, one frameless popup placed next to the
  tray icon, single instance, autostart, notifications behind an interface. The webview may only call: `app_info`, `fs_read`,
  `fs_stat`, `fs_write`, `fs_move_aside`, `fs_clean_temps` (allowed file names inside the data folder), `export_csv`,
  `set_tray_label`, `hide_popup`, `hold_popup_open`, `quit_app`. No fs, shell or http plugin. The page loads nothing remote
  (CSP `default-src 'self'`).
* Budget alerts are **off by default**, are sent once per category per month at 80% and 100%, and are recorded as sent only
  after the system accepted the notification.

## Protection against lost updates

Every write of `entries.json` is a compare-and-swap. The app remembers the file's stamp (size, modification time and change
time as whole microseconds, inode as a string: exact integers, so the stamp survives Rust to JSON to the page and back bit for
bit) from its last read or write; the Rust side takes an exclusive lock on `<data folder>/.lock`, compares the file's current
stamp with it and only then renames the new file into place. If somebody else wrote the file in between (a second copy of this
app, an editor, a script), nothing is written, the app reads the file again, applies the same add/edit/delete to what is there
now and tries once more; a second conflict in a row is reported instead of overwriting anything. Tests: two stores each adding
25 entries at once lose nothing (TypeScript), two Rust threads appending 30 entries each lose nothing, and an external writer
appending between the read and the write loses nothing. The lock protects writers that use it (this app); an editor that does
not take the lock is caught by the stamp compare, but the few microseconds between that compare and the rename cannot be closed
without OS support that std does not offer.

**Note about the Mac app:** the Swift Money Bar has the same unlocked read-modify-write weakness when two writers hit one file
at the same millisecond. It was deliberately not changed.

## Export

Exporting a CSV: the page sends only the text and a suggested file name. The **Rust command opens the native save dialog
itself** and writes to the path the dialog returns (checked again: absolute, `.csv`, existing normal folder that is not the data
folder, no link at the target, not read-only, at most 32 MB). The UTF-8 BOM is added there. The temp file is made in the data
folder when that is on the same filesystem as the target, otherwise beside the target; leftover `.moneybar-export.tmp-*` files
older than an hour are removed from the folder just used and from the folder of the previous export in the same session. The
webview has no dialog or file-system permission at all.

## All checks

```sh
npm ci --ignore-scripts
npm test                      # vitest: core, store, Mac vectors as JSON fixtures
npx tsc --noEmit
(cd src-tauri && cargo test --locked && cargo clippy --all-targets -- -D warnings)
npm run build && npm run ui:smoke && npm run shots     # Playwright: keyboard, focus, RTL, small screens, screenshots
npm run tauri build -- --debug                          # app bundle for this OS
MONEYBAR_DATA_DIR=$(mktemp -d) MONEYBAR_NO_NOTIFICATIONS=1 src-tauri/target/debug/money-bar-cross   # a run against a temp folder
```

`MONEYBAR_SEED_SAMPLE=1` (honoured only together with `MONEYBAR_DATA_DIR`) fills an empty temp folder with fake data for
manual runs. `npm run dev` and the screenshots use an in-memory preview backend with made-up data: they never read a real file.

**Opt-in self test.** `MONEYBAR_SELFTEST=1` (honoured only together with `MONEYBAR_DATA_DIR`) makes the app, right after start,
do 50 sequential saves through the real command path with no outside writer and print `SELFTEST saves=50 failed=0 conflicts=0 ...`
to stderr (via the tray label). It must always report 0 conflicts.

## What was verified, and what was not

Verified on macOS (Apple silicon) only: vitest (235 passed, 1 skipped) and cargo test (`--locked`, 66 passed, 1 ignored), both
re-run 2026-10-12; tsc, clippy, a debug `tauri build`, a real 8-second run with the tray created and `entries.json` written by
the Rust side from synthetic data, that file decoded by the Mac app's own `Model.swift` (compiled in a scratch folder,
`loadError: none`) and a file written by that Model read back here and written back, Playwright screenshots and keyboard checks
in Chrome, 20,000-entry timing.

**Not verified by hand:** Windows and Linux. `ci.yml` (build, tests, screenshots) and the installer smoke test pass on all three
systems on GitHub, but nobody has used those builds by hand, and the tray icon is never clicked. Tray behaviour, popup
placement, autostart, notifications, the save dialog and the WebView2 / WebKitGTK rendering on those systems are untested.
Safari/WebKit rendering of the page was not checked either (Chrome was used).

## Known limits and differences from the Mac app

* Linux trays cannot report clicks or show text next to the icon: open the app from the tray menu ("Show Money Bar"); the text
  mode is shown as the tooltip only (on Windows too). On GNOME the AppIndicator extension is needed. On Wayland the compositor
  chooses where the popup opens.
* The popup uses native `<select>` and date inputs, so these look different on each OS. There is no Mac-style window blur:
  "glass" is a translucent panel over a tinted backdrop (CSS `backdrop-filter`).
* `entries.json` is pretty-printed with sorted keys but with `"key": value` spacing (Swift writes `"key" : value`); both apps
  read either.
* A `cents` written as `1e2` or `100.0` reads as the integer 100, and `100.5` is refused with a named error: the same as the Mac
  app (checked against Model.swift). Repeated JSON keys: the first value wins, as on the Mac (a plain `JSON.parse` would keep
  the last; this app uses its own strict parser). A trailing comma (`[1,]`) is accepted by the Mac's JSON reader but is reported
  here as a named error (and the file is then left alone): a deliberate difference.
* Category spelling (whitespace sets, case and diacritic folding, which spellings are the same category) matches Foundation
  exactly on 14,000 measured cases, including the zero width space counting as a space and the ZWNJ being kept after
  Arabic-script letters; see `tests/unicode-parity.test.ts`. Sorting of names uses UTF-16 order, the Mac uses Unicode order:
  only the order of equal-total categories with unusual letters can differ.
* Delete asks for a confirmation in the row (the Mac app deletes at once) and then offers Undo for 8 seconds. The note length
  counts code points, not graphemes.
* The category and menu-bar-mode pickers are custom keyboard listboxes (Enter/Space/arrows open, arrows/Home/End/letters move,
  Enter chooses, Escape closes only the menu), so no native menu window can take the focus and close the popup; tested in
  `ui:smoke` in Chrome. The other selects (settings) are native and the popup is told to stay open for 1.5 seconds when one is
  touched (`hold_popup_open`), which is **untested on Windows and Linux**.
* Days that a time zone skipped (Pacific/Apia 2011-12-30, Pacific/Kiritimati 1994-12-31) are refused like the Mac does, so a
  recurring rule skips them and never creates an entry the Mac then cannot read.
* Reports stop at the years 1 and 9999 (the next/previous buttons are disabled there).
* Chart fills (bars, lines, donut) are darkened or lightened only as far as needed for 3:1 against the card in every theme and
  mode (computed test); text colours keep 4.5:1. The Mono palette is a fixed ramp of eight greys.
* Budget notifications: the notification plugin does not report whether the system really showed one, so "delivered" means
  the system accepted the request (permission granted, no error). An alert counts as sent only then; a failed one is tried up
  to three times in all, a minute apart; the failed tries are saved in the `budgetAlerts` record (keys like
  `2026-10|food|tries80`, which the Mac app ignores) so they survive a restart, and switching the notification option off and
  on again resets them. More than three alerts due at once become one summary notification.
* The popup is 420 x 640 (smaller only when the screen work area is too small). No Windows installer signing or macOS
  notarisation is set up.
* The tray icon is a plain drawn coin, generated by `scripts/make-icons.mjs`.
* No sleep detection in Rust: nothing in this app depends on the clock gap, so there is nothing to replace.
* The folder of the last export is remembered only for the running session, not in `entries.json` (settings are the Mac's file
  format; adding a key would change the shared format).
* Rust 1.90 or newer is required (`File::try_lock`).

## Releasing

Releases are built by `.github/workflows/release.yml` when a version tag is pushed. The builds are unsigned (see the release
notes text in that file). Expect small fixes on the first public release.

1. Choose the new version, for example `0.2.0`, and change it in all three places so they match: `version` in
   `src-tauri/tauri.conf.json`, `version` in `src-tauri/Cargo.toml`, and `version` in `package.json`. Then run `cargo check` in
   `src-tauri` (and `npm install --package-lock-only`) so `Cargo.lock` and `package-lock.json` follow.
2. Commit the change, then tag it: `git tag v0.2.0`. The tag must be `v` plus the exact version; the workflow stops with an
   error if it differs from `tauri.conf.json` or if the three versions disagree.
3. Push the commit and the tag: `git push` and `git push origin v0.2.0`.
4. Open the repository on GitHub, then Actions, and wait for the `release` run (macOS Apple silicon and Intel, Windows, Linux).
5. Go to Releases, open the new draft, check that every installer is attached, read the notes, and click Publish release.
   Delete the draft and the tag if something is wrong.
