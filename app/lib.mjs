// The parts of the page that are pure: no network, no DOM, no storage. The
// page and its tests share them. Everything written by someone else is
// escaped on the way in.

import { labelName } from "../client/trust.mjs";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export const short = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "");

/** An account's name: from their Moniker card, else their shortened address. */
export const nameOf = (address, names) => names.get(address) || short(address);

export const initials = (name) =>
  String(name).replace(/^@/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0].toUpperCase()).join("") || "?";

export const plural = (n, word, many = `${word}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? word : many}`;

/** `link` as an http(s) URL, or null: anything else is never made a link. */
export function safeLink(link) {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** How long ago, in words a person says. */
export function ago(time, now = Date.now()) {
  if (!time) return "date unknown";
  const s = Math.max(0, Math.floor((now - time) / 1000));
  const units = [
    [31_536_000, "year"],
    [2_592_000, "month"],
    [604_800, "week"],
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ];
  for (const [size, unit] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${plural(n, unit)} ago`;
  }
  return "just now";
}

export const when = (time, now = Date.now()) =>
  time ? `<time datetime="${new Date(time).toISOString()}" title="${esc(new Date(time).toLocaleString())}">${ago(time, now)}</time>` : `<span>${ago(time, now)}</span>`;

/** "Mar 2026". */
export const monthYear = (time) => new Date(time).toLocaleDateString("en-US", { month: "short", year: "numeric" });

export const STAR_WORDS = ["Tap a star", "Not good", "Could be better", "OK", "Good", "Great"];

const STAR = "M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z";
export const starPath = STAR;

/** Five stars, `n` filled, read out as "n of 5 stars". */
export const stars = (n, size = 16) =>
  `<span class="stars" role="img" aria-label="${n} of 5 stars">${[1, 2, 3, 4, 5]
    .map((i) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR}" fill="${i <= n ? "var(--star)" : "var(--star-off)"}"/></svg>`)
    .join("")}</span>`;

/** An average to one decimal, or a dash. */
export const average = (value) => (value === null ? "–" : value.toFixed(1));

/** Five small bars of a reviewer's stars, one to five. */
export function sparkline(spread) {
  const max = Math.max(1, ...spread);
  const said = spread.map((n, i) => `${n} ${i + 1}-star`).join(", ");
  return `<span class="spark" role="img" aria-label="Their stars: ${said}">${spread
    .map((n) => `<i style="height:${Math.max(2, Math.round((n / max) * 14))}px"></i>`)
    .join("")}</span>`;
}

/** What a label says to a person. */
export function labelText(label) {
  const name = labelName(label);
  return { paid: "paid for", spam: "spam", fake: "fake", closed: "closed", "same-as": "a duplicate" }[name] ?? name;
}

export const CATEGORIES = ["Food", "Coffee", "Bar", "Shop", "Service", "Other"];

/** Metres or kilometres, as a person reads them. */
export function metres(m) {
  if (m < 1000) return `${Math.round(m / 10) * 10 || Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;
}

/**
 * The page's routes:
 *   #/                         Explore
 *   #/place/<author>/<id>      a place
 *   #/place/<author>/<id>/review  write or edit your review
 *   #/add                      add a place
 *   #/following, #/you, #/settings
 *   #/u/<address>              a reviewer
 */
export function parseRoute(hash) {
  const decode = (part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  const parts = hash.replace(/^#\/?/, "").split("?")[0].split("/").filter(Boolean).map(decode);
  const [head, a, b, c] = parts;
  if (head === "place" && a && b) return { view: c === "review" ? "write" : "place", place: { author: a, id: b } };
  if (head === "u" && a) return { view: "reviewer", address: a };
  if (["add", "following", "you", "settings"].includes(head)) return { view: head };
  return { view: "explore" };
}

export const placeHref = (p) => `#/place/${encodeURIComponent(p.author)}/${encodeURIComponent(p.id)}`;
export const userHref = (a) => `#/u/${encodeURIComponent(a)}`;

/** Words two names share, for "Is it one of these?". */
export function sameName(a, b) {
  const words = (s) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 3));
  const x = words(a);
  for (const w of words(b)) if (x.has(w)) return true;
  return false;
}
