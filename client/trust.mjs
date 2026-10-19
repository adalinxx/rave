// What a reader sees, computed from what they chose: whose reviews they
// follow, whose labels they use and what each label does. Nothing here is
// global; two readers may see the same place differently, and each can see why.

const DAY = 86_400_000;
/** "Recent" is the last three months: what most people trust (BrightLocal 2026). */
export const RECENT = 91 * DAY;

const mean = (list) => (list.length ? list.reduce((sum, r) => sum + r.stars, 0) / list.length : null);

/**
 * A place's numbers: `everyone` and `followed` as `{ average, count }`
 * (average null with no reviews), how many came in the last three months,
 * and the count at each star (`spread[0]` is one star).
 */
export function summary(reviews, followed = new Set(), now = Date.now()) {
  const mine = reviews.filter((r) => followed.has(r.author));
  const spread = [0, 0, 0, 0, 0];
  for (const r of reviews) spread[r.stars - 1]++;
  return {
    everyone: { average: mean(reviews), count: reviews.length },
    followed: { average: mean(mine), count: mine.length },
    recent: reviews.filter((r) => r.time && now - r.time <= RECENT).length,
    spread,
  };
}

/** Distribution bars are shown only past this many ratings: five say little. */
export const SPREAD_MIN = 6;

export const ORDERS = {
  followed: "People you follow first, then newest",
  newest: "Newest first",
  helpful: "Most helpful first",
  lowest: "Lowest rated first",
};

/**
 * Reviews in one of the ORDERS. `helpfulCount(review)` is how many marked it
 * helpful. Ties fall back to newest, so the order is the same on every read.
 */
export function order(reviews, how, { followed = new Set(), helpfulCount = () => 0 } = {}) {
  const newest = (a, b) => b.time - a.time || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0);
  const by = {
    followed: (a, b) => Number(followed.has(b.author)) - Number(followed.has(a.author)) || newest(a, b),
    newest,
    helpful: (a, b) => helpfulCount(b) - helpfulCount(a) || newest(a, b),
    lowest: (a, b) => a.stars - b.stars || newest(a, b),
  }[how] ?? newest;
  return [...reviews].sort(by);
}

/** A label's name without its argument: `same-as:<a>/<id>` is `same-as`. */
export const labelName = (label) => label.split(":")[0];

/** What a label does when the reader has not said: the common harms hide, the rest warn. */
export const DEFAULT_MODES = { spam: "hide", fake: "hide", paid: "warn", closed: "warn", "same-as": "show" };

/**
 * What the reader's labelers' labels do to one item: the strongest mode any
 * of them asks for ("hide" over "warn" over "show"), and the labels that
 * asked. `modes(labeler, name)` is the reader's choice for that label from
 * that labeler.
 */
export function verdict(labels = [], modes = (_, name) => DEFAULT_MODES[name] ?? "warn") {
  const rank = { show: 0, warn: 1, hide: 2 };
  let mode = "show";
  const applied = [];
  for (const l of labels) {
    const m = modes(l.by, labelName(l.label));
    if (!(m in rank)) continue;
    applied.push({ ...l, mode: m });
    if (rank[m] > rank[mode]) mode = m;
  }
  return { mode, labels: applied };
}

/** One reviewer's track record: `{ count, since, spread }` (since: their first review's time, or 0). */
export function history(reviews) {
  const spread = [0, 0, 0, 0, 0];
  let since = 0;
  for (const r of reviews) {
    spread[r.stars - 1]++;
    if (r.time && (!since || r.time < since)) since = r.time;
  }
  return { count: reviews.length, since, spread };
}

/**
 * Accounts that rate like the reader: on places both reviewed, their stars
 * were within one of the reader's. `mine` is the reader's reviews;
 * `others(place)` gives everyone's reviews of a place. Returns
 * `[{ author, agree, common }]` with at least `minCommon` places in common
 * and agreement on at least `share` of them, best first, leaving out the
 * reader and anyone in `skip`.
 */
export async function ratedLikeYou(mine, others, { skip = new Set(), minCommon = 2, share = 0.6, limit = 10 } = {}) {
  const tally = new Map();
  const lists = await Promise.all(mine.map((r) => others(r.on)));
  mine.forEach((my, i) => {
    for (const r of lists[i]) {
      if (r.author === my.author || skip.has(r.author)) continue;
      const t = tally.get(r.author) ?? { author: r.author, agree: 0, common: 0 };
      t.common++;
      if (Math.abs(r.stars - my.stars) <= 1) t.agree++;
      tally.set(r.author, t);
    }
  });
  return [...tally.values()]
    .filter((t) => t.common >= minCommon && t.agree / t.common >= share)
    .sort((a, b) => b.agree - a.agree || b.agree / b.common - a.agree / a.common || (a.author < b.author ? -1 : 1))
    .slice(0, limit);
}
