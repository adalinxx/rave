# Rave

Reviews of places that no company owns. Anyone can add a place, anyone can
review it, and nothing is ever taken down. Instead of one ranking for
everyone, each reader chooses whose reviews count first and whose labels
("paid", "spam", "closed", "duplicate") change what they see, and the page
always says why it shows what it shows.

Rave keeps its data on a Lattice chain and has no server of its own. The
page reads every record from a node, checks it against the chain's own
hashes, and does the ranking and filtering itself. Writes are signed in the
reader's Selfhold wallet, which holds their key.

## Web app

`app/` is the whole app: a static page with three tabs.

- **Explore**: a map, and the places in view with their ratings. Search and
  the category chips filter what is on screen.
- **A place**: two averages side by side, "People you follow" and
  "Everyone", how many reviews came in the last three months, star bars
  (past five ratings) that filter to one level, and the reviews. A line says
  how they are ordered and changes it. Each card shows the reviewer's name
  (from their Moniker card), how long and how many places they have
  reviewed, and the spread of their stars. Replies, owners' included, sit
  under the review they answer.
- **Write**: stars alone are a complete review; words and up to ten photos
  are optional. Edits keep the review's date and say Edited.
- **Add a place**: drop the pin on the door. Places already listed within
  50 m with a similar name are offered first.
- **Following**: newest reviews from the people you follow, and "Rated
  like you": people whose stars were within one of yours on places you both
  reviewed, worked out in the page.
- **A reviewer**: their history, Follow, and Use their labels.
- **You**: for each labeler you use, what each label does (Show, Warn or
  Hide). Labels hidden from a list are counted at its foot, with Show.

Reading needs nothing. Writing needs [Selfhold](https://chromewebstore.google.com/detail/amcobhbipbblfjonmoiicihhfglkhpce),
which asks before every write. Writes are free on the trial chain.

The map is drawn by [Leaflet](https://leafletjs.com) (vendored in
`app/vendor/leaflet`) over OpenStreetMap's tiles; the tile host sees which
map squares are viewed, nothing else. The font ships in `app/fonts` (SIL
Open Font License), so no font host sees who reads.

```sh
python3 -m http.server 8765   # from the repository root, then open http://127.0.0.1:8765/app/
```

The page reads the trial chain by default. A link may carry `?node=`,
`?chain=` and `?moniker=`, and Settings changes them; both are kept in the
browser.

## Records

All records follow one chain rule (the policy in `chain/`): every key
belongs to the account named in it, and that account must sign the write.

| Key | Owner |
|---|---|
| `user/<owner>/...` | `<owner>`: their own records |
| `index/<topic...>/<owner>` | `<owner>`: their entry under a shared topic, listed by prefix |

A record `user/<a>/post/<id>` states when it was written (`time`, in
milliseconds). The chain holds that to the block that admits it, at most 60
target block times earlier, and a changed record keeps its time. Everything
else is a convention clients share; values are JSON.

| Key | Value |
|---|---|
| `user/<a>/post/<pid>` | a place `{ kind: "place", name, lat, lon, category?, address?, url?, phone?, hours?, time }` |
| `index/geo/<g1>/…/<g6>/<pid>/<a>` | `"1"`: lists the place under its 6-character geohash, one character per segment |
| `user/<a>/post/<rid>` | a review `{ kind: "review", on: "<pa>/<pid>", stars: 1–5, body?, edited?, time }` |
| `user/<a>/post/<rid>/media/<n>` | the CID of its `<n>`th photo (`n` < 10) |
| `index/review/<pa>/<pid>/<a>` | `"<rid>"`: `<a>`'s one review of that place |
| `user/<a>/post/<xid>` | a reply `{ kind: "reply", on: "<author>/<id>", body, labels?, time }` |
| `index/reply/<author>/<id>/<xid>/<a>` | `"1"`: lists a reply under the review or place it answers |
| `index/helpful/<author>/<id>/<a>` | `"1"`: `<a>` found a review helpful |
| `user/<a>/follow/<b>` | `"1"`: `<a>` follows `<b>`'s reviews |
| `user/<a>/follow-labels/<b>` | `"1"`: `<a>` uses `<b>`'s labels |

A listing is a claim by whoever wrote it, so a reader checks it against the
record it lists: a place counts in a cell only when its own point is there,
and a review counts only when it is a review of that place. One review per
account per place follows from the listing's key.

**Labels are replies.** A reply with `labels` marks what it answers: `paid`,
`fake`, `spam` on a review; `closed` or `same-as:<author>/<id>` on a place.
Nothing is removed. A reader applies only the labels of accounts they chose,
and decides per labeler what each label does; with none chosen they see
every review as written. **Owners** reply like anyone else; a reply may
say it is the owner's, and the reader decides whether to believe it.
**Duplicates** stay listed: a `same-as` label tells readers who trust its
author, and the page explains why when asked.

**Photos** are not on the chain. One photo is one Volume, DAG-CBOR
`{ type, bytes }`, kept by the reviewer's own node (the page asks it to pin
the file through its operator routes, with the cookie the node writes; set
it in Settings). Readers' nodes fetch it from peers and check it against its
CID; the page shows only raster images.

Names come from [Moniker](https://github.com/adalinxx/moniker), the profile
chain Lattice apps share, through the
[Moniker SDK](https://github.com/adalinxx/moniker-sdk) (a submodule at
`app/vendor/moniker-sdk`, pinned to a release: clone with
`--recurse-submodules`).

## Client library

`client/` is the record code the page uses, and any other client can:

- `state.mjs`: reads state at a block by descending the trie, every node
  checked against its CID.
- `geo.mjs`: geohash, the cells covering a map view, distances.
- `write.mjs`: the writes for each act (`place`, `review`, `reply`,
  `helpful`, `follow`, `followLabels`) and `changes`, which turns them into
  actions against the state they were read from.
- `read.mjs`: places in cells, reviews of a place, replies, helpful marks,
  everything one account wrote, follows and labels.
- `trust.mjs`: what a reader sees: the two averages, the recent count and
  spread, the orders, what labels do, reviewer history, "Rated like you".
- `media.mjs`: photo Volumes and the node's operator routes.

## Chain

`chain/spec.json` is the spec a Rave chain is created from; it names the
policy module by CID, and `chain/policy.wasm` is that module. It is Stoa's
module, byte for byte ([Stoa](https://github.com/adalinxx/stoa)
`policy/`): the same ownership and post-time rule.

```sh
lattice child create Nexus/rave --spec chain/spec.json --policy-module chain/policy.wasm
```

The trial chain is `Nexus/testnet/rave-186079`, served by
`lattice-testnet-apps-iad.fly.dev` and `lattice-testnet-apps-ams.fly.dev`.

## Tests

```sh
node --test client/*.test.mjs
```

Every write the client makes goes through the chain's real policy module,
then onto an in-memory state that the reads take.

`e2e/ui/` is the acceptance suite: the real page in Chromium with the real
Selfhold extension, against a private Lattice stack seeded with demo data
(`scripts/seed.mjs`). Each test is something a person does, checked by what
the page then shows: exploring and filtering, reading a place, adding a
place and reviewing it with a new account, nearby duplicates offered first,
editing and deleting, declining in the wallet, helpful and replies, photos
kept by one's own node, following, labels and their modes, duplicates,
labelling a place closed, "Rated like you", and the phone layout.

```sh
cd e2e/ui && npm ci && npx playwright install chromium
LATTICE=<lattice-node>/.build/debug/lattice \
LATTICE_WALLET=<lattice-wallet>/dist npm test
```
