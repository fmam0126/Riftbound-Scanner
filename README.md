# Riftbound Scanner

A React Native (Expo) app for scanning **Riftbound: League of Legends TCG** cards
with your phone camera and tracking what you own.

Point the camera at the collector number printed at the bottom-left of a card
(`OGN-010`, `SFD-001`, …) and the app identifies the card and marks it as owned.
Everything runs on-device — no images or text are ever uploaded.

---

## How it works

### 1. Reading the number

A real card prints its identifier in the bottom-left corner as
`OGN - 160/298`: set code, collector number, then the set total. TCGplayer stores
the same number in its `Number` field, so the two line up. The `/298` half is the
set size, carries no identifying information, and is present on every card — so
the parser tolerates it rather than treating it as noise
(`SET_TOTAL_SUFFIX` in `src/logic/parseOcr.ts`).

The user frames the **whole card** in an outline that is itself card-shaped
(63 × 88 mm). They never have to aim at the number: its position on the card is
known, so the app derives the crop from the outline instead.

A scan then runs these passes (`src/scan/ocr.ts`), stopping at the first usable
result:

1. **`label`** — the bottom-left strip of the card, where the number is printed.
   Cleanest input, so it runs first and is usually the only pass needed.
2. **`card`** — the whole card. Recovers a blurred or glared label by giving the
   matcher the card's *name* too, which is far more text to work with.
3. **`frame`** — the uncropped photo, in case the outline was misaligned.

Cropping is what makes this accurate: full-frame OCR returns the name, rules
text, flavour text and type line, all of which is noise around a six-character
identifier. The matcher tolerates the rest.

The label strip is taken as fractions of the outline, so it follows wherever the
user places the card. It deliberately overshoots the outline's left edge, because
clipping the leading characters of the set code (`0GN` for `OGN`) costs a whole
confidence tier, and the crop is clamped to the image so overshooting is free.
The geometry lives in `src/scan/geometry.ts`, free of native imports so it can be
unit tested.

### 1b. Scanning continuously

**Auto is off at startup.** The scanner never begins capturing until you ask it
to, so opening the app is quiet. Turn on **Auto** and a scan runs every 1.8 s
while the scanner tab is focused, so a card just has to be held in the outline.
The setting is not persisted — every launch starts with it off again.

Two rules keep the loop safe:

- **One capture at a time.** The loop schedules its next tick only after the
  previous pass resolves, so a slow OCR pass cannot cause overlapping captures.
  The **Scan** button runs through the same lock, so a tap during a timer tick
  cannot put two camera captures in flight at once. A pass already running when
  Auto is switched off is discarded rather than acted on.
- **A card is not counted twice.** The last **3 distinct cards** seen are
  remembered, and a repeat is acknowledged but not added. Without this a card
  resting under the camera would be added several times a second.

The window is measured in *cards*, not seconds. It advances when a **different**
card is seen — a repeat keeps its place rather than refreshing — so a card held
under the camera stays inside the window and is never re-added, while showing
three other cards in between pushes it out and lets you scan another copy. That
is the point: **owning a card never stops you scanning more of it.** The only
thing suppressed is the same card being seen again immediately.

Remembering the last few cards rather than only the most recent one matters
because a card swept past the camera can flicker between two readings; with a
single-entry window that flicker would make the real card count twice.

Both the decision (`isDuplicateSighting`) and the bookkeeping (`recordSighting`)
are pure functions, so the policy is unit tested rather than only observable
against a live camera — including the sequence for scanning three copies.

The loop pauses while the confirmation sheet is open or the tab is backgrounded.
The **Scan** button works at any time as an immediate retry, and Undo clears the
window so a card can be re-scanned immediately after being removed.

### 2. Matching a messy read

OCR on a 3-character code and a 3-digit number is unreliable, so the matcher
models the errors instead of hoping for clean input. `src/logic/normalize.ts`
encodes the glyph pairs ML Kit actually confuses:

```
0 <-> O <-> Q <-> D      1 <-> I <-> L      5 <-> S      8 <-> B
2 <-> Z                  6 <-> G            7 <-> T      4 <-> A
```

That makes reads like `0GN O1O` resolve to `OGN-010`, while `XGN 010` is still
rejected as a genuinely different set.

The matcher (`src/logic/match.ts`) is strict about what it *won't* guess:

- The **set code** may be corrected by confusions only. One genuinely wrong
  letter is enough to reject the candidate.
- The **number** must match exactly, or differ by a single digit **in the units
  place**. This is deliberate: treating any one-digit difference as a misread let
  `998` "match" `198` and `744` "match" `144`, which would silently file the wrong
  card. A wrong tens or hundreds digit moves the number too far to be a misread.
- **Printing prefixes matter** (`T01` is not `001`), which is what keeps promo
  reprints from colliding with their base cards.
- Confidence is derived from how much had to be corrected, and a **confidence of
  exactly 1 is reserved for a read that needed no correction at all**.

### 3. Confirming before saving

A confident match is saved immediately, with an **Undo** button. Anything the
matcher is unsure about opens a confirmation sheet listing every candidate, so a
bad read can never silently corrupt the collection.

The case that always asks is a **genuine tie** — two printings sharing a number
and differing only by an art qualifier, where neither ranks ahead. Note that a
read *omitting* the art letter is not a tie: reading `OGN-007` ranks the base
`OGN-007` strictly ahead of `OGN-007a`, because the trailing letter is too small
to depend on, so the base printing is recorded rather than prompting on every
scan. The alternate remains available in the candidate list.

### 4. The card database

`src/data/cards.json` ships inside the app bundle (≈820 KB, 1414 cards across 13
sets), so scanning works instantly and offline with no network call.

It is generated from [TCGCSV](https://tcgcsv.com/), which republishes TCGplayer's
catalogue. Riftbound is TCGplayer category **89**, and each set is a "group"
whose abbreviation is the printed set code.

```bash
npm run build:cards           # uses a 24h cache in .cache/
npm run build:cards:refresh   # ignores the cache, refetches everything
npm run verify:cards          # validates the committed JSON, no network
```

The generator is fussier than it looks, because real promo data is messy. It
handles alternate art (`007a`), signature printings (`190*`) and promo bundles
that publish the *same* collector number for different cards (disambiguated with
a `~2` suffix). It deliberately rejects values that are **not** a scannable card
identifier, so they cannot produce duplicate or unreachable keys:

| Value | Meaning | Why it is rejected |
| --- | --- | --- |
| `R01` | Fury Rune | Runes are not collectible cards |
| `T01 // T02` | double-sided token | Tokens have no unique number |
| `SP3/006` | Vendetta special art | Its digits duplicate the real card `VEN-006` |

Sealed product (booster boxes, champion decks, bundles) carries no `Number` field
at all and is skipped. Regenerating reports every skipped product, so a change
upstream is visible rather than silent.

---

## Requirements

- Node 20+ (Node 24 is used here; the build and test scripts rely on Node's
  native TypeScript type stripping)
- A physical iOS or Android device with a camera
- **A development build — Expo Go will not work.** The app depends on
  `@react-native-ml-kit/text-recognition`, a native module that Expo Go does not
  include. `expo-dev-client` is therefore a dependency, and the app must be
  launched from a development build rather than from Expo Go.

## Setup

```bash
npm install

# Build and install the development build on a connected device or simulator.
npx expo run:android     # or: npx expo run:ios
```

`expo run:*` performs a prebuild, compiles the native project and installs it.
Every later session only needs the bundler:

```bash
npx expo start
```

Because `expo-dev-client` is installed, `expo start` targets the development
build by default. You can confirm that from the banner it prints: it should say
**"Using development build"**, not "Using Expo Go". Press `s` to switch.

On first launch the app asks for camera access. Nothing else is requested — the
microphone permission is explicitly disabled in `app.json`.

### If scanning reports the native module is "not linked"

```
OCR pass "label" failed: The package '@react-native-ml-kit/text-recognition'
doesn't seem to be linked.
```

This means the app you are looking at is **not** the development build. The two
usual causes:

1. **It opened in Expo Go.** Expo Go has no ML Kit, so check the banner says
   "Using development build" and press `s` if not. Make sure the QR code you scan
   is from the development-build session.
2. **The development build predates `expo-dev-client`.** A build made before the
   package was installed has no dev-launcher and cannot load from Metro. Rebuild
   once with `npx expo run:android`.

The error is harmless in itself — the scan falls through all three OCR passes and
reports "No card recognised" — but no card will ever be read until the app is
running as the development build.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Start the Metro bundler for an installed dev build |
| `npm run android` / `npm run ios` | Prebuild, compile and install natively |
| `npm test` | Run the unit test suite (152 tests, no device needed) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run build:cards` | Regenerate the card database from TCGCSV |
| `npm run verify:cards` | Validate the committed card database offline |

Using the app: **Scan** to add cards, **Collection** to review progress (filter by
set, sort, long-press a row to remove a copy), **Browse** to search the full
database and add a card by hand when a scan will not read.

---

## Project layout

```
src/
  logic/            Pure, device-free matching — all the accuracy lives here
    normalize.ts    Glyph-confusion model, digit/place-weighted distances
    parseOcr.ts     OCR text -> structured card identifier
    match.ts        Identifier -> card, with confidence and ambiguity handling
  scan/
    geometry.ts     Where the number is on a card, and how that maps to a crop
    ocr.ts          Crop -> on-device ML Kit -> matcher
  state/            Collection state, AsyncStorage persistence
  screens/          Scan, Collection, Browse
  components/ui.tsx Shared presentational pieces
  data/cards.json   Generated card database (committed)
  types.ts          Shared domain types
scripts/
  build-card-db.ts  TCGCSV -> data/cards.json
  strip-image-metadata.ts  Remove EXIF from a JPEG without re-encoding it
tests/              152 unit tests over the pure logic, run against real data
testImage/
  ogn-160.jpg       Real card photo used to measure the card and label geometry
```

The test photo's EXIF has been removed — camera photos carry make, model,
software, timestamps and usually a GPS position, none of which belongs in a
repository. Use `npm run strip:metadata -- <in.jpg> <out.jpg>` before adding any
further photos; it edits the JPEG segments directly, so the image itself is
bit-for-bit unchanged (`ffmpeg -map_metadata -1` does **not** work for this, as
EXIF is inside the JPEG bitstream rather than container metadata).

The `src/logic` layer is deliberately free of React and native imports. That is
what lets the whole scan path be tested on a laptop, which is why the tests run
against the real generated card database rather than hand-written fixtures.

### Why there is no `babel.config.js`

Two conventions collide in this project, and the resolution is deliberate:

- `package.json` sets `"type": "module"` so the TypeScript helpers in `scripts/`
  and `tests/` can use ESM syntax under Node's native type stripping.
- Expo projects conventionally ship a CommonJS `babel.config.js` that does
  `module.exports = { presets: ['babel-preset-expo'] }`.

Because of `"type": "module"`, a `.js` Babel config is parsed as an ES module and
fails with `ReferenceError: module is not defined in ES module scope`. Babel
would normally fall back to `.cjs`, but that file would have to
`require('babel-preset-expo')` — and that package is **not** hoisted to the
project root, because only `expo` depends on it.

So there is no Babel config at all, which is the supported path: Expo's
`loadBabelConfig` checks for a config file in the project root and, finding none,
applies its own `expo/internal/babel-preset` (an internal re-export of
`babel-preset-expo`, resolved from inside `expo/` where it does exist).

The practical consequence: **do not add a `babel.config.js`.** If you need Babel
customisation, either use `babel.config.cjs` together with an explicit
`babel-preset-expo` devDependency, or drop `"type": "module"` and rename the
helper scripts to `.mts`.

## Testing

`npm test` covers the confusion model, OCR parsing, matching and the scan
geometry, including the specific misreads and formats the app is designed around:

- `OGN-010`, `OGN 010`, `OGN\n010` — the printed shapes
- `OGN - 160/298` — the full real-world format, as read from `testImage/ogn-160.jpg`
- `0GN O1O`, `0GN - 1GO/298` — every ambiguous glyph wrong, still resolves correctly
- `5FD 001` — a confused set code
- `OGN 998`, `OGN 744` — correctly rejected rather than force-matched
- `OGN 007` vs `OGN 007a` — base-versus-alternate handling
- `PR 001` — genuinely ambiguous, asks the user

The scan-geometry tests assert that the label strip covers the collector label's
measured position on the real photo, and that the card outline stays card-shaped
and fully on-screen across viewports from a 360 × 640 phone to a tablet in
landscape.

The test runner is Node's built-in one, so there is no bundler or transform step
in the test path. `tests/cardData.test.ts` separately covers the generator's
handling of the messy promo formats above.

## Known limitations

- **The camera path is not verified end-to-end on a device.** The matcher and the
  scan geometry are tested against real data and a real card photo, but ML Kit's
  behaviour on a live camera frame has not been observed. The label-strip
  fractions (`NUMBER_LABEL_IN_GUIDE` in `src/scan/geometry.ts`) were measured from
  `testImage/ogn-160.jpg` and may want tuning; the whole-card and full-frame
  passes exist to cover a miss. The scanner prints which pass ran and what it read
  under the shutter button, which is the fastest way to see what is happening.
- **Card images** are loaded from TCGplayer's CDN by URL, so they need a network
  connection. Set `imageUrl` to `null` in the generator to work fully offline.
- **Sets without cards** (Legacy, Radiance, Riftbound Bundles) appear in the
  database for completeness but have no scannable cards yet.
- **Prices are not included.** TCGCSV publishes them separately and they change
  daily, so a bundled snapshot would be misleading.

## Data attribution

Card data comes from [TCGCSV](https://tcgcsv.com/), which republishes TCGplayer's
catalogue. Riftbound and League of Legends are trademarks of Riot Games. This
project is unaffiliated with Riot Games or TCGplayer.
