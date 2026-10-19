// Reads Rave's records from a state view `{ get(key), list(prefix) }` (see
// state.mjs). Records are written by anyone, so every value is parsed as
// untrusted: a record that does not parse is skipped, never fatal, and a
// listing counts only when the record it lists agrees with it.

import { encode, PRECISION } from "./geo.mjs";

const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value, max = 5000) => (typeof value === "string" && value.length <= max ? value : undefined);
/** `"<author>/<id>"` as `{ author, id }`, or undefined. */
export const ref = (value) => {
  const [author, id, ...rest] = typeof value === "string" ? value.split("/") : [];
  return author && id && rest.length === 0 ? { author, id } : undefined;
};
async function collect(entries) {
  const found = [];
  for await (const entry of entries) found.push(entry);
  return found;
}
const timeOf = (record) => (Number.isSafeInteger(record.time) && record.time > 0 ? record.time : 0);

/** A record `user/<author>/post/<id>` of one kind, parsed, with its media CIDs. */
async function recordOf(state, author, id, kind) {
  if (!author || !id) return undefined;
  const [value, media] = await Promise.all([
    state.get(`user/${author}/post/${id}`),
    kind === "review" ? collect(state.list(`user/${author}/post/${id}/media/`)) : [],
  ]);
  return shape(author, id, parse(value), kind, media);
}

function shape(author, id, record, kind, media = []) {
  if (!isObject(record) || record.kind !== kind) return undefined;
  const base = { author, id, time: timeOf(record) };
  if (kind === "place") {
    const { lat, lon } = record;
    const name = text(record.name, 200)?.trim();
    if (!name || typeof lat !== "number" || typeof lon !== "number" || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
    const optional = Object.fromEntries(
      ["category", "address", "url", "phone", "hours"].flatMap((field) => (text(record[field], 500) ? [[field, record[field]]] : [])),
    );
    return { ...base, name, lat, lon, ...optional };
  }
  const on = ref(record.on);
  if (!on) return undefined;
  if (kind === "review") {
    if (!Number.isInteger(record.stars) || record.stars < 1 || record.stars > 5) return undefined;
    return {
      ...base,
      on,
      stars: record.stars,
      body: text(record.body) ?? "",
      ...(Number.isSafeInteger(record.edited) && record.edited > base.time && { edited: record.edited }),
      media: media
        .map(([key, cid]) => [Number(key.slice(key.lastIndexOf("/") + 1)), cid])
        .filter(([n, cid]) => Number.isInteger(n) && n >= 0 && n < 10 && typeof cid === "string")
        .sort(([a], [b]) => a - b)
        .map(([, cid]) => cid),
    };
  }
  return {
    ...base,
    on,
    body: text(record.body) ?? "",
    labels: Array.isArray(record.labels) ? record.labels.filter((label) => text(label, 200)) : [],
  };
}

/** `author`'s place `id`: `{ author, id, time, name, lat, lon, category?, address?, url?, phone?, hours? }`. */
export const place = (state, author, id) => recordOf(state, author, id, "place");

/**
 * The places listed in geohash cells (see geo.cover). A listing counts only
 * when the place it names is really at that point.
 */
export async function placesIn(state, cells) {
  const listed = (
    await Promise.all(cells.map((cell) => collect(state.list(`index/geo/${cell.split("").join("/")}/`))))
  ).flat();
  const found = await Promise.all(
    listed.map(async ([key]) => {
      const segments = key.split("/");
      if (segments.length !== 2 + PRECISION + 2) return undefined;
      const [id, author] = segments.slice(-2);
      const p = await place(state, author, id);
      return p && encode(p.lat, p.lon) === segments.slice(2, 2 + PRECISION).join("") ? p : undefined;
    }),
  );
  return found.filter(Boolean);
}

/**
 * The reviews of a place: for each account, the one review its listing
 * names, when that record is a review of this place.
 */
export async function reviews(state, on) {
  const prefix = `index/review/${on.author}/${on.id}/`;
  // Only `<prefix><account>` is an account's listing: the chain lets an
  // account write deeper keys under its name too, which would count it twice.
  const listed = (await collect(state.list(prefix))).filter(([key]) => !key.slice(prefix.length).includes("/"));
  const found = await Promise.all(
    listed.map(async ([key, rid]) => {
      const author = key.slice(prefix.length);
      const r = await recordOf(state, author, rid, "review");
      return r && r.on.author === on.author && r.on.id === on.id ? r : undefined;
    }),
  );
  return found.filter(Boolean);
}

/** One past the highest photo slot a record has: every slot to clear when it changes. */
export async function mediaSlots(state, author, id) {
  let slots = 0;
  for await (const [key] of state.list(`user/${author}/post/${id}/media/`)) {
    const n = Number(key.slice(key.lastIndexOf("/") + 1));
    if (Number.isSafeInteger(n) && n >= 0 && n < 1000) slots = Math.max(slots, n + 1);
  }
  return slots;
}

/** `a`'s current review of a place, or undefined. */
export async function reviewOf(state, a, on) {
  const rid = await state.get(`index/review/${on.author}/${on.id}/${a}`);
  const r = rid && (await recordOf(state, a, rid, "review"));
  return r && r.on.author === on.author && r.on.id === on.id ? r : undefined;
}

/** The replies to a review or a place, oldest first. */
export async function replies(state, on) {
  const prefix = `index/reply/${on.author}/${on.id}/`;
  // `<prefix><reply id>/<account>`, nothing deeper.
  const listed = (await collect(state.list(prefix))).filter(([key]) => key.slice(prefix.length).split("/").length === 2);
  const found = await Promise.all(
    listed.map(([key]) => {
      const [xid, author] = key.slice(prefix.length).split("/");
      return recordOf(state, author, xid, "reply");
    }),
  );
  return found.filter((r) => r && r.on.author === on.author && r.on.id === on.id).sort((a, b) => a.time - b.time);
}

/** The accounts that marked a review helpful. */
export async function helpful(state, on) {
  const prefix = `index/helpful/${on.author}/${on.id}/`;
  const listed = await collect(state.list(prefix));
  return new Set(listed.filter(([key, value]) => value === "1" && !key.slice(prefix.length).includes("/")).map(([key]) => key.slice(prefix.length)));
}

/**
 * Everything `a` wrote: `{ places, reviews, replies }`. A review counts only
 * while its place's listing for `a` still names it (an account has one
 * review per place).
 */
export async function by(state, a) {
  const prefix = `user/${a}/post/`;
  const all = await collect(state.list(prefix));
  const entries = all.filter(([key]) => !key.slice(prefix.length).includes("/"));
  const out = { places: [], reviews: [], replies: [] };
  const media = new Map();
  for (const [key, cid] of all) {
    const [id, slot, n] = key.slice(prefix.length).split("/");
    if (slot === "media") media.set(id, [...(media.get(id) ?? []), [`m/${n}`, cid]]);
  }
  const reviewsFound = [];
  for (const [key, value] of entries) {
    const id = key.slice(prefix.length);
    const record = parse(value);
    if (!isObject(record)) continue;
    if (record.kind === "place") {
      const p = shape(a, id, record, "place");
      if (p) out.places.push(p);
    } else if (record.kind === "review") {
      const r = shape(a, id, record, "review", media.get(id) ?? []);
      if (r) reviewsFound.push(r);
    } else if (record.kind === "reply") {
      const r = shape(a, id, record, "reply");
      if (r) out.replies.push(r);
    }
  }
  const current = await Promise.all(
    reviewsFound.map(async (r) => ((await state.get(`index/review/${r.on.author}/${r.on.id}/${a}`)) === r.id ? r : undefined)),
  );
  out.reviews = current.filter(Boolean);
  return out;
}

/** The accounts `a` follows. */
export async function follows(state, a) {
  const prefix = `user/${a}/follow/`;
  return (await collect(state.list(prefix))).filter(([, v]) => v === "1").map(([key]) => key.slice(prefix.length));
}

/** The accounts whose labels `a` uses. */
export async function labelers(state, a) {
  const prefix = `user/${a}/follow-labels/`;
  return (await collect(state.list(prefix))).filter(([, v]) => v === "1").map(([key]) => key.slice(prefix.length));
}

/**
 * The labels one account put on things, from its labelled replies:
 * `"<author>/<id>"` → `[{ label, by, reply }]`.
 */
export function labelsFrom(replies) {
  const labelled = new Map();
  for (const r of replies) {
    for (const label of r.labels) {
      const key = `${r.on.author}/${r.on.id}`;
      labelled.set(key, [...(labelled.get(key) ?? []), { label, by: r.author, reply: r }]);
    }
  }
  return labelled;
}
