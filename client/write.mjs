// Builds the transactions that write Rave's records. A record change is a
// general-state action `{ key, oldValue?, newValue? }`: consensus applies it
// only when `oldValue` is what the key holds now, so a change is always made
// against a state the writer has read.

import { encode } from "./geo.mjs";

const POST = /^user\/[^/]+\/post\/[^/]+$/;

/**
 * A record says when it was written, and the chain's policy holds that to
 * the block that creates it: a new one is stamped `time`, a changed one keeps
 * the time it has.
 */
function stamped(key, newValue, oldValue, time) {
  if (newValue === undefined || !POST.test(key)) return newValue;
  const parse = (value) => {
    try {
      return JSON.parse(value);
    } catch {}
  };
  const record = parse(newValue);
  if (typeof record !== "object" || record === null || Array.isArray(record)) return newValue;
  return JSON.stringify({ ...record, time: parse(oldValue)?.time ?? record.time ?? time });
}

/**
 * When a new post says it was written by default: a few seconds ago. The
 * chain refuses a post stamped after its block's time, and a writer's clock
 * may run ahead of the miner's; the policy's window reaches far further back.
 */
export const SKEW = 5000;

/**
 * The actions for a list of `[key, value]` writes against `state` (a view,
 * see state.mjs), as of `time` (when a new record says it was written). A
 * value of undefined deletes the key. A key written twice takes its last value.
 */
export async function changes(state, writes, time = Date.now() - SKEW) {
  const last = new Map(writes);
  const actions = await Promise.all(
    [...last].map(async ([key, value]) => {
      const oldValue = await state.get(key);
      const newValue = stamped(key, value, oldValue, time);
      return {
        key,
        ...(oldValue !== undefined && { oldValue }),
        ...(newValue !== undefined && { newValue }),
      };
    }),
  );
  // Writing what is already there changes nothing.
  return actions.filter((action) => action.oldValue !== action.newValue);
}

/** A transaction body carrying `actions`, signed for and paid by `owner`. */
export function transaction({ owner, actions, fee, nonce, chainPath }) {
  return {
    accountActions: fee > 0n ? [{ owner, delta: -fee }] : [],
    actions,
    depositActions: [],
    receiptActions: [],
    withdrawalActions: [],
    signers: [owner],
    nonce,
    chainPath: [...chainPath],
  };
}

/** A new record id. Ids carry no meaning; the time is in the record. */
export const newId = () =>
  [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// The record conventions in the README. Each returns the `[key, value]`
// writes for one act; a value of undefined deletes the key.

const json = (value) => (value === undefined ? undefined : JSON.stringify(value));
const flag = (on) => (on ? "1" : undefined);
const record = (a, id) => `user/${a}/post/${id}`;
const ref = ({ author, id }) => `${author}/${id}`;
const geoKey = (lat, lon, pid, a) => `index/geo/${encode(lat, lon).split("").join("/")}/${pid}/${a}`;

/** Keeps only the fields a record may carry, dropping empty ones. */
const fields = (value, names) =>
  Object.fromEntries(names.filter((name) => value[name] !== undefined && value[name] !== "").map((name) => [name, value[name]]));

const PLACE_FIELDS = ["name", "lat", "lon", "category", "address", "url", "phone", "hours"];

/**
 * `a` adds or edits their place `pid`: `{ name, lat, lon, category?,
 * address?, url?, phone?, hours? }`, listed under the geohash of its point.
 * `before` is the place as it stands, so a moved place leaves its old cell.
 * Undefined deletes it and its listing.
 */
export function place(a, pid, value, before) {
  const writes = [];
  if (before && (!value || encode(before.lat, before.lon) !== encode(value.lat, value.lon))) {
    writes.push([geoKey(before.lat, before.lon, pid, a), undefined]);
  }
  writes.push([record(a, pid), json(value && { kind: "place", ...fields(value, PLACE_FIELDS) })]);
  if (value) writes.push([geoKey(value.lat, value.lon, pid, a), "1"]);
  return writes;
}

/**
 * `a`'s review of the place `on` = `{ author, id }`: `{ stars: 1–5, body? }`
 * as record `rid`, and its listing under the place. A reader counts one
 * review per account per place: the one the listing names. Editing keeps the
 * record's id (and its time) and marks it `edited`. Undefined deletes both.
 */
export function review(a, rid, on, value, { edited, mediaCIDs = [], before = 0 } = {}) {
  const writes = [
    [
      record(a, rid),
      json(value && { kind: "review", on: ref(on), stars: value.stars, ...fields(value, ["body"]), ...(edited && { edited }) }),
    ],
    [`index/review/${on.author}/${on.id}/${a}`, value ? rid : undefined],
  ];
  // Media in order; slots past the new count are cleared.
  const count = value ? mediaCIDs.length : 0;
  for (let n = 0; n < Math.max(count, before); n++) writes.push([`${record(a, rid)}/media/${n}`, n < count ? mediaCIDs[n] : undefined]);
  return writes;
}

/**
 * `a` replies to `on` = `{ author, id }` (a review, or a place): `{ body,
 * labels? }`. A reply with labels is how anyone marks something: `paid`,
 * `spam`, `fake` on a review; `closed` or `same-as:<author>/<id>` on a place.
 * A reader applies only the labels of accounts they chose. An owner replies
 * like anyone else. Undefined deletes it.
 */
export const reply = (a, xid, on, value) => [
  [record(a, xid), json(value && { kind: "reply", on: ref(on), body: value.body ?? "", ...(value.labels?.length && { labels: value.labels }) })],
  [`index/reply/${on.author}/${on.id}/${xid}/${a}`, flag(value !== undefined)],
];

/** `a` marks a review helpful, or takes it back with `on` false. */
export const helpful = (a, review, on = true) => [[`index/helpful/${review.author}/${review.id}/${a}`, flag(on)]];

/**
 * `a`'s card, what Rave shows for them: `{ name, bio?, photo? }` (`photo` a
 * photo's CID, kept like a review's). Undefined deletes it.
 */
export const card = (a, value) => [[`user/${a}/card`, json(value && fields(value, ["name", "bio", "photo"]))]];

/** `a` follows `b`'s reviews, or stops. */
export const follow = (a, b, on = true) => [[`user/${a}/follow/${b}`, flag(on)]];

/** `a` uses `b`'s labels, or stops. */
export const followLabels = (a, b, on = true) => [[`user/${a}/follow-labels/${b}`, flag(on)]];
