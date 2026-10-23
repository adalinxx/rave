// Rave's records through the chain's own policy module (chain/policy.wasm):
// every write a client makes is checked the way a node checks it, then
// applied to an in-memory state that the reads take.
//
//   node --test client/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as geo from "./geo.mjs";
import * as read from "./read.mjs";
import * as trust from "./trust.mjs";
import * as write from "./write.mjs";

const sdk = await import(new URL("../app/vendor/lattice-sdk.js", import.meta.url));
const PATH = ["Nexus", "rave"];
const spec = JSON.parse(readFileSync(new URL("../chain/spec.json", import.meta.url), "utf8"));
const policy = new WebAssembly.Module(readFileSync(new URL("../chain/policy.wasm", import.meta.url)));
const [ANA, BEN, CAT, DEV, EVE] = ["ana", "ben", "cat", "dev", "eve"];

// --- the chain's policy, as a node runs it

const u32 = (value) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};
const i64 = (value) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value));
  return bytes;
};
// The spec as the policy reads it: DAG-CBOR {"targetBlockTime": <ms>}.
const target = spec.targetBlockTime;
const SPEC = Uint8Array.of(0xa1, 0x6f, ...new TextEncoder().encode("targetBlockTime"), 0x19, target >> 8, target & 0xff);

function admits(body, timestamp) {
  const text = new TextEncoder();
  const { bytes } = sdk.encodeTransactionBody(body);
  const parts = [
    text.encode("LWPCTX"),
    Uint8Array.of(0, 2, 0, 1, 0),
    new Uint8Array(8),
    i64(timestamp),
    u32(SPEC.length),
    SPEC,
    u32(PATH.length),
    ...PATH.flatMap((segment) => [u32(text.encode(segment).length), text.encode(segment)]),
    Uint8Array.of(1),
    u32(bytes.length),
    bytes,
    Uint8Array.of(0, 0),
  ];
  const context = Uint8Array.from(parts.flatMap((part) => [...part]));
  const { exports } = new WebAssembly.Instance(policy);
  const pointer = exports.lattice_alloc(context.length);
  new Uint8Array(exports.memory.buffer).set(context, pointer);
  return exports.lattice_validate_transaction(pointer, context.length) === 1;
}

/** An in-memory chain: writes go through the policy and land if it admits them. */
function chain() {
  const kv = new Map();
  let clock = 1_800_000_000_000;
  const state = {
    get: async (key) => kv.get(key),
    async *list(prefix) {
      for (const key of [...kv.keys()].sort()) if (key.startsWith(prefix)) yield [key, kv.get(key)];
    },
  };
  return {
    state,
    kv,
    now: () => clock,
    tick: (ms) => (clock += ms),
    /** `signer` writes; true when the policy admitted it and it landed. */
    async write(signer, writes) {
      clock += 1000;
      const actions = await write.changes(state, writes, clock - 500);
      const body = write.transaction({ owner: signer, actions, fee: 0n, nonce: 0n, chainPath: PATH });
      if (!admits(body, clock)) return false;
      for (const a of actions) {
        if (kv.get(a.key) !== a.oldValue) return false;
        if (a.newValue === undefined) kv.delete(a.key);
        else kv.set(a.key, a.newValue);
      }
      return true;
    },
  };
}

const NOODLES = { name: "Marigold Noodle Bar", lat: 40.7411, lon: -73.9897, category: "Food" };
async function withPlace() {
  const c = chain();
  assert.ok(await c.write(ANA, write.place(ANA, "p1", NOODLES)));
  return c;
}
const P1 = { author: ANA, id: "p1" };

// --- geohash

test("geohash matches the published reference points", () => {
  assert.equal(geo.encode(57.64911, 10.40744, 11), "u4pruydqqvj");
  assert.equal(geo.encode(-25.382708, -49.265506, 8), "6gkzwgjz");
  const b = geo.bounds("u4pruydqqvj");
  assert.ok(b.south <= 57.64911 && 57.64911 <= b.north && b.west <= 10.40744 && 10.40744 <= b.east);
});

test("cover returns cells that hold every point in the box, and refuses a view too wide", () => {
  const box = { south: 40.73, west: -74.0, north: 40.75, east: -73.98 };
  const cells = geo.cover(box);
  assert.ok(cells.length <= 16 && cells.length > 0);
  for (let lat = box.south; lat <= box.north; lat += 0.002) {
    for (let lon = box.west; lon <= box.east; lon += 0.002) {
      const hash = geo.encode(lat, lon);
      assert.ok(cells.some((cell) => hash.startsWith(cell)), `${lat},${lon} uncovered`);
    }
  }
  assert.equal(geo.cover({ south: -60, west: -170, north: 70, east: 170 }), undefined);
  // Across the antimeridian: both sides.
  const wrapped = geo.cover({ south: -17.8, west: 179.9, north: -17.7, east: -179.9 });
  assert.ok(wrapped.some((c) => geo.encode(-17.75, 179.95).startsWith(c)) && wrapped.some((c) => geo.encode(-17.75, -179.95).startsWith(c)));
});

test("distance is in metres", () => {
  const d = geo.distance({ lat: 40.7411, lon: -73.9897 }, { lat: 40.7415, lon: -73.9897 });
  assert.ok(Math.abs(d - 44.5) < 1, String(d));
});

// --- places

test("a place is found by the area it is in, and only there", async () => {
  const c = await withPlace();
  const here = geo.cover({ south: 40.74, west: -73.99, north: 40.742, east: -73.989 });
  const [found] = await read.placesIn(c.state, here);
  assert.equal(found.name, NOODLES.name);
  assert.equal(found.category, "Food");
  assert.ok(found.time > 0, "a place says when it was added");
  const elsewhere = geo.cover({ south: 51.5, west: -0.13, north: 51.51, east: -0.12 });
  assert.deepEqual(await read.placesIn(c.state, elsewhere), []);
});

test("moving a place moves its listing, and keeps its time", async () => {
  const c = await withPlace();
  const before = await read.place(c.state, ANA, "p1");
  const moved = { ...NOODLES, lat: 40.7611, lon: -73.9797 };
  assert.ok(await c.write(ANA, write.place(ANA, "p1", moved, before)));
  const old = geo.cover({ south: 40.74, west: -73.99, north: 40.742, east: -73.989 });
  assert.deepEqual(await read.placesIn(c.state, old), []);
  const [found] = await read.placesIn(c.state, geo.cover({ south: 40.76, west: -73.98, north: 40.762, east: -73.979 }));
  assert.equal(found.time, before.time);
  assert.equal([...c.kv.keys()].filter((k) => k.startsWith("index/geo/")).length, 1);
});

test("a listing that lies about where a place is counts for nothing", async () => {
  const c = await withPlace();
  // Ben's place is in New York, but he also lists it in London: the key is
  // his, so the chain takes it, but the place is not there.
  assert.ok(await c.write(BEN, write.place(BEN, "p1", { ...NOODLES, name: "Ben's" })));
  const london = geo.encode(51.505, -0.125).split("").join("/");
  assert.ok(await c.write(BEN, [[`index/geo/${london}/p1/${BEN}`, "1"]]));
  assert.deepEqual(await read.placesIn(c.state, geo.cover({ south: 51.5, west: -0.13, north: 51.51, east: -0.12 })), []);
});

test("only a place's author can change it", async () => {
  const c = await withPlace();
  assert.equal(await c.write(BEN, write.place(ANA, "p1", { ...NOODLES, name: "Closed forever" })), false);
  assert.equal((await read.place(c.state, ANA, "p1")).name, NOODLES.name);
});

// --- reviews

test("stars alone are a review; one review per account per place", async () => {
  const c = await withPlace();
  assert.ok(await c.write(BEN, write.review(BEN, "r1", P1, { stars: 4 })));
  assert.ok(await c.write(CAT, write.review(CAT, "r2", P1, { stars: 2, body: "Salty broth." })));
  // A second review from Ben replaces his first in the listing.
  assert.ok(await c.write(BEN, write.review(BEN, "r3", P1, { stars: 5 })));
  const found = await read.reviews(c.state, P1);
  assert.deepEqual(found.map((r) => [r.author, r.stars]).sort(), [[BEN, 5], [CAT, 2]]);
  assert.equal(found.find((r) => r.author === CAT).body, "Salty broth.");
  // His older record no longer counts in his history either.
  assert.deepEqual((await read.by(c.state, BEN)).reviews.map((r) => r.id), ["r3"]);
});

test("editing a review keeps its time and marks it edited", async () => {
  const c = await withPlace();
  assert.ok(await c.write(BEN, write.review(BEN, "r1", P1, { stars: 4 })));
  const first = await read.reviewOf(c.state, BEN, P1);
  c.tick(60_000);
  assert.ok(await c.write(BEN, write.review(BEN, "r1", P1, { stars: 2, body: "Went downhill." }, { edited: c.now() })));
  const edited = await read.reviewOf(c.state, BEN, P1);
  assert.equal(edited.time, first.time);
  assert.equal(edited.stars, 2);
  assert.ok(edited.edited > edited.time);
});

test("a review with a time outside its block is refused by the chain", async () => {
  const c = await withPlace();
  const stale = c.now() - spec.targetBlockTime * 61;
  const actions = await write.changes(c.state, write.review(BEN, "r1", P1, { stars: 3 }), stale);
  assert.equal(admits(write.transaction({ owner: BEN, actions, fee: 0n, nonce: 0n, chainPath: PATH }), c.now()), false);
});

test("a review's listing must name a review of that place", async () => {
  const c = await withPlace();
  assert.ok(await c.write(ANA, write.place(ANA, "p2", { ...NOODLES, name: "Other" })));
  // Ben's record reviews p2, but he lists it under p1.
  assert.ok(await c.write(BEN, write.review(BEN, "r1", { author: ANA, id: "p2" }, { stars: 1 })));
  assert.ok(await c.write(BEN, [[`index/review/${ANA}/p1/${BEN}`, "r1"]]));
  assert.deepEqual(await read.reviews(c.state, P1), []);
  // And nobody can list a review in someone else's name.
  assert.equal(await c.write(CAT, [[`index/review/${ANA}/p1/${BEN}`, "r9"]]), false);
});

test("out-of-range stars and other kinds are not reviews", async () => {
  const c = await withPlace();
  assert.ok(await c.write(BEN, [[`user/${BEN}/post/r1`, JSON.stringify({ kind: "review", on: "ana/p1", stars: 6 })], [`index/review/ana/p1/${BEN}`, "r1"]]));
  assert.ok(await c.write(CAT, [[`user/${CAT}/post/r1`, JSON.stringify({ kind: "reply", on: "ana/p1", body: "x" })], [`index/review/ana/p1/${CAT}`, "r1"]]));
  // A record that is not JSON has no time, so the chain refuses it outright.
  assert.equal(await c.write(DEV, [[`user/${DEV}/post/r1`, "not json"], [`index/review/ana/p1/${DEV}`, "r1"]]), false);
  assert.deepEqual(await read.reviews(c.state, P1), []);
});

test("deleting a review removes it and its listing", async () => {
  const c = await withPlace();
  assert.ok(await c.write(BEN, write.review(BEN, "r1", P1, { stars: 4 }, { mediaCIDs: ["bafy1", "bafy2"] })));
  assert.deepEqual((await read.reviewOf(c.state, BEN, P1)).media, ["bafy1", "bafy2"]);
  assert.ok(await c.write(BEN, write.review(BEN, "r1", P1, undefined, { before: 2 })));
  assert.equal(await read.reviewOf(c.state, BEN, P1), undefined);
  assert.deepEqual([...c.kv.keys()].filter((k) => k.includes(BEN)), []);
});

test("an account counts once per place, however many listings it writes", async () => {
  const c = await withPlace();
  assert.ok(await c.write(BEN, write.review(BEN, "r1", P1, { stars: 5 })));
  // Deeper keys under Ben's name are his to write, and must not count again.
  assert.ok(await c.write(BEN, [[`index/review/${ANA}/p1/x1/${BEN}`, "r1"], [`index/review/${ANA}/p1/x2/${BEN}`, "r1"]]));
  assert.deepEqual((await read.reviews(c.state, P1)).map((r) => r.author), [BEN]);
  const R1 = { author: BEN, id: "r1" };
  assert.ok(await c.write(CAT, [...write.helpful(CAT, R1), [`index/helpful/${BEN}/r1/x/${DEV}`, "1"]]) === false);
  assert.ok(await c.write(CAT, [...write.helpful(CAT, R1), [`index/helpful/${BEN}/r1/x/${CAT}`, "1"]]));
  assert.deepEqual([...(await read.helpful(c.state, R1))], [CAT]);
  assert.ok(await c.write(CAT, [...write.reply(CAT, "x1", R1, { body: "hi" }), [`index/reply/${BEN}/r1/x1/y/${CAT}`, "1"]]));
  assert.equal((await read.replies(c.state, R1)).length, 1);
});

test("mediaSlots counts to the highest slot, gaps included", async () => {
  const c = await withPlace();
  assert.ok(await c.write(BEN, [...write.review(BEN, "r1", P1, { stars: 4 }), [`user/${BEN}/post/r1/media/2`, "bafy3"]]));
  assert.equal(await read.mediaSlots(c.state, BEN, "r1"), 3);
});

// --- replies, labels, helpful, follows

test("replies sit under what they answer; labels are replies", async () => {
  const c = await withPlace();
  assert.ok(await c.write(BEN, write.review(BEN, "r1", P1, { stars: 2, body: "Slow." })));
  const R1 = { author: BEN, id: "r1" };
  assert.ok(await c.write(ANA, write.reply(ANA, "x1", R1, { body: "Owner here: we were short-staffed, sorry." })));
  assert.ok(await c.write(EVE, write.reply(EVE, "x2", R1, { body: "Looks paid.", labels: ["paid"] })));
  assert.ok(await c.write(EVE, write.reply(EVE, "x3", P1, { body: "Same place as p9.", labels: ["same-as:ana/p9"] })));
  const thread = await read.replies(c.state, R1);
  assert.deepEqual(thread.map((r) => r.body), ["Owner here: we were short-staffed, sorry.", "Looks paid."]);
  const eves = await read.by(c.state, EVE);
  const labels = read.labelsFrom(eves.replies);
  assert.deepEqual(labels.get("ben/r1").map((l) => l.label), ["paid"]);
  assert.deepEqual(labels.get("ana/p1").map((l) => l.label), ["same-as:ana/p9"]);
  // No one replies in someone else's name.
  assert.equal(await c.write(EVE, write.reply(ANA, "x4", R1, { body: "fake owner" })), false);
});

test("helpful marks are one per account, and can be taken back", async () => {
  const c = await withPlace();
  assert.ok(await c.write(BEN, write.review(BEN, "r1", P1, { stars: 4 })));
  const R1 = { author: BEN, id: "r1" };
  assert.ok(await c.write(CAT, write.helpful(CAT, R1)));
  assert.ok(await c.write(DEV, write.helpful(DEV, R1)));
  assert.deepEqual([...(await read.helpful(c.state, R1))].sort(), [CAT, DEV]);
  assert.ok(await c.write(DEV, write.helpful(DEV, R1, false)));
  assert.deepEqual([...(await read.helpful(c.state, R1))], [CAT]);
});

test("follows and label follows are each account's own", async () => {
  const c = chain();
  assert.ok(await c.write(ANA, [...write.follow(ANA, BEN), ...write.follow(ANA, CAT), ...write.followLabels(ANA, EVE)]));
  assert.deepEqual(await read.follows(c.state, ANA), [BEN, CAT]);
  assert.deepEqual(await read.labelers(c.state, ANA), [EVE]);
  assert.ok(await c.write(ANA, write.follow(ANA, CAT, false)));
  assert.deepEqual(await read.follows(c.state, ANA), [BEN]);
  assert.equal(await c.write(BEN, write.follow(ANA, DEV)), false);
});

// --- cards

test("a card is its account's own: name, a few words, a photo", async () => {
  const c = chain();
  assert.ok(await c.write(ANA, write.card(ANA, { name: "Ana Diaz", bio: "Tacos, mostly.", photo: "bafyphoto", extra: "dropped" })));
  assert.deepEqual(await read.card(c.state, ANA), { name: "Ana Diaz", bio: "Tacos, mostly.", photo: "bafyphoto" });
  assert.deepEqual(JSON.parse(c.kv.get(`user/${ANA}/card`)), { name: "Ana Diaz", bio: "Tacos, mostly.", photo: "bafyphoto" });
  // Nobody writes another's card.
  assert.equal(await c.write(BEN, write.card(ANA, { name: "Not Ana" })), false);
  assert.deepEqual(await read.cards(c.state, [ANA, BEN]), [{ name: "Ana Diaz", bio: "Tacos, mostly.", photo: "bafyphoto" }, undefined]);
  // A card with no name, or that isn't JSON, is no card.
  assert.ok(await c.write(BEN, [[`user/${BEN}/card`, JSON.stringify({ bio: "nameless" })]]));
  assert.equal(await read.card(c.state, BEN), undefined);
  assert.ok(await c.write(CAT, [[`user/${CAT}/card`, "{"]]));
  assert.equal(await read.card(c.state, CAT), undefined);
  // Deleted with undefined.
  assert.ok(await c.write(ANA, write.card(ANA, undefined)));
  assert.equal(await read.card(c.state, ANA), undefined);
});

test("a card and a first review go in one transaction", async () => {
  const c = await withPlace();
  assert.ok(await c.write(BEN, [...write.card(BEN, { name: "Ben" }), ...write.review(BEN, "r1", P1, { stars: 4 })]));
  assert.equal((await read.card(c.state, BEN)).name, "Ben");
  assert.equal((await read.reviewOf(c.state, BEN, P1)).stars, 4);
});

test("a new post is stamped a few seconds back, so a fast clock isn't refused; an edit keeps its time", async () => {
  const c = chain();
  const before = Date.now();
  const [created] = await write.changes(c.state, write.place(ANA, "p1", NOODLES));
  const { time } = JSON.parse(created.newValue);
  assert.ok(Math.abs(before - write.SKEW - time) < 1000, String(before - time));
  c.kv.set(created.key, created.newValue);
  const [edited] = await write.changes(c.state, write.place(ANA, "p1", { ...NOODLES, name: "Renamed" }));
  assert.equal(JSON.parse(edited.newValue).time, time);
});

// --- what a reader sees

const r = (author, stars, time, extra = {}) => ({ author, id: `${author}-r`, stars, time, on: P1, ...extra });

test("summary: two averages, recent count and the spread", () => {
  const now = 1_800_000_000_000;
  const day = 86_400_000;
  const list = [r(ANA, 5, now - day), r(BEN, 4, now - 10 * day), r(CAT, 1, now - 200 * day), r(DEV, 2, now - 5 * day)];
  const s = trust.summary(list, new Set([ANA, BEN]), now);
  assert.deepEqual(s.everyone, { average: 3, count: 4 });
  assert.deepEqual(s.followed, { average: 4.5, count: 2 });
  assert.equal(s.recent, 3);
  assert.deepEqual(s.spread, [1, 1, 0, 1, 1]);
  assert.deepEqual(trust.summary([], new Set(), now).everyone, { average: null, count: 0 });
});

test("orders say why: followed first, newest, most helpful, lowest", () => {
  const list = [r(ANA, 5, 3), r(BEN, 1, 2), r(CAT, 3, 1)];
  const ids = (l) => l.map((x) => x.author);
  assert.deepEqual(ids(trust.order(list, "followed", { followed: new Set([CAT]) })), [CAT, ANA, BEN]);
  assert.deepEqual(ids(trust.order(list, "newest")), [ANA, BEN, CAT]);
  assert.deepEqual(ids(trust.order(list, "helpful", { helpfulCount: (x) => (x.author === BEN ? 3 : 0) })), [BEN, ANA, CAT]);
  assert.deepEqual(ids(trust.order(list, "lowest")), [BEN, CAT, ANA]);
});

test("labels do what the reader chose, per labeler, strongest wins", () => {
  const labels = [{ label: "paid", by: EVE }, { label: "spam", by: DEV }];
  assert.equal(trust.verdict(labels).mode, "hide");
  const modes = (by, name) => (by === DEV ? "show" : name === "paid" ? "warn" : "hide");
  const v = trust.verdict(labels, modes);
  assert.equal(v.mode, "warn");
  assert.deepEqual(v.labels.map((l) => [l.by, l.mode]), [[EVE, "warn"], [DEV, "show"]]);
  assert.equal(trust.verdict([{ label: "same-as:ana/p9", by: EVE }]).mode, "show");
  assert.equal(trust.verdict([]).mode, "show");
});

test("history: count, first review and spread", () => {
  const h = trust.history([r(ANA, 5, 30), r(ANA, 4, 10), r(ANA, 4, 0)]);
  assert.deepEqual(h, { count: 3, since: 10, spread: [0, 0, 0, 2, 1] });
});

test("rated like you: stars within one on places in common", async () => {
  const places = { p1: [r(BEN, 4, 1), r(CAT, 1, 1), r(DEV, 5, 1)], p2: [r(BEN, 2, 1), r(CAT, 5, 1), r(DEV, 2, 1)], p3: [r(BEN, 5, 1)] };
  const mine = [r(ANA, 5, 1, { on: { author: ANA, id: "p1" } }), r(ANA, 3, 1, { on: { author: ANA, id: "p2" } })];
  const found = await trust.ratedLikeYou(mine, async (on) => places[on.id]);
  assert.deepEqual(found.map((f) => [f.author, f.agree, f.common]), [[BEN, 2, 2], [DEV, 2, 2]]);
  assert.deepEqual((await trust.ratedLikeYou(mine, async (on) => places[on.id], { skip: new Set([BEN]) })).map((f) => f.author), [DEV]);
});
