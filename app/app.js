// Rave in the browser: reads every record from a node by CID, decides here
// what to show (by whom the reader follows and whose labels they use), and
// asks the reader's Selfhold wallet to sign each write. No server of its own.
//
// An account is shown by its Rave card (`user/<a>/card` on Rave's chain) and
// the @handle Moniker verifies for it, read through the Moniker SDK.
import * as sdk from "./vendor/lattice-sdk.js";
import { createMoniker, DEFAULTS as MONIKER, isHandle } from "./vendor/moniker-sdk/src/index.mjs";
import * as geo from "../client/geo.mjs";
import { mediaVolume, operator } from "../client/media.mjs";
import * as read from "../client/read.mjs";
import { tip, view, volumeLoader } from "../client/state.mjs";
import * as trust from "../client/trust.mjs";
import * as write from "../client/write.mjs";
import {
  CATEGORIES, STAR_WORDS, ago, average, bylineHTML, esc, initials, labelText, metres, monthYear, nameOf, parseRoute, placeHref,
  plural, safeLink, sameName, sparkline, starPath, stars, userHref, when,
} from "./lib.mjs";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// ------------------------------------------------------------- settings

// Per-reader choices live in this browser.
const store = {
  get(key, fallback) {
    try {
      const value = localStorage.getItem(`rave:${key}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === undefined) localStorage.removeItem(`rave:${key}`);
      else localStorage.setItem(`rave:${key}`, JSON.stringify(value));
    } catch {
      /* private window: choices last for this visit */
    }
  },
};
export const DEFAULTS = {
  node: "https://lattice-testnet-apps-iad.fly.dev",
  chain: "Nexus/testnet/rave-186079",
  view: { lat: 40.7411, lon: -73.9897, zoom: 16 },
};
/** `url` as a node address the SDK will dial (https, or http on loopback), else null. */
const nodeAddress = (url) => {
  try {
    return sdk.normalizeNodeURL(url);
  } catch {
    return null;
  }
};
// A link may carry ?node=, ?chain= or ?moniker=: they hold for this visit
// only. Only Settings keeps a choice, so a link can't change what later
// visits read (or which handles they take as verified).
const linked = (param) => new URLSearchParams(location.search).get(param) || null;
const settings = {
  node: nodeAddress(linked("node") ?? store.get("node", DEFAULTS.node)) ?? DEFAULTS.node,
  chain: linked("chain") ?? store.get("chain", DEFAULTS.chain),
  moniker: linked("moniker") ?? store.get("monikerChain", null) ?? MONIKER.chain.join("/"),
  // The reader's own node, which keeps their photos: its operator address and cookie.
  ownNode: store.get("ownNode", ""),
  ownCookie: store.get("ownCookie", ""),
};
const chainPath = () => settings.chain.split("/");
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

// ---------------------------------------------------------------- wallet

// The reader's account: the address Selfhold gave this site. The wallet
// holds the key and asks the reader to approve every write.
let connected = null;
const wallet = () => window.lattice ?? null;

class NoWallet extends Error {}
/** An error already in the page's words. */
class Said extends Error {}
/** The reader closed a step the write needed (making their card): nothing to say. */
class Cancelled extends Said {}
/** The form was made from an older picture of the chain: it is drawn again, with this said. */
class Redraw extends Said {}
let redrawNote = "";

function walletMessage(error) {
  const text = String(error?.message ?? error);
  if (/just declined|ask again in a moment/i.test(text)) return "Selfhold waits a few seconds after a decline. Try again in a moment.";
  if (/declined|rejected|denied/i.test(text)) return "You declined it in Selfhold. Nothing was sent.";
  if (/locked/i.test(text)) return "Unlock Selfhold, then try again.";
  return text;
}

async function connectWallet() {
  if (!wallet()) throw new NoWallet();
  const address = await wallet().connect();
  setConnected(address);
  return address;
}
/** The reader's address, connecting first if needed. */
const me = async () => connected ?? (await connectWallet());

function setConnected(address) {
  if (address === connected) return;
  connected = address;
  reader = null;
  render();
}

// The wallet takes one request from a page at a time: writes wait their turn.
let walletTurn = Promise.resolve();
const DECLINE_PAUSE = 5500;
function viaWallet(ask) {
  const run = walletTurn.then(ask, ask);
  walletTurn = run.then(
    () => {},
    (error) => (/declined/i.test(String(error?.message ?? error)) ? new Promise((resolve) => setTimeout(resolve, DECLINE_PAUSE)) : undefined),
  );
  return run;
}

function needWallet(why) {
  $("#gw-why").textContent = why ?? "";
  if (!$("#getwallet").open) $("#getwallet").showModal();
}

// --------------------------------------------------------------- network

const browserFetch = (...args) => fetch(...args);
let nodes = new sdk.ChainNodes(settings.node, { fetch: browserFetch });

function readFailure(error) {
  if (error instanceof sdk.ChainOfflineError) return "No node serves Rave right now.";
  if (error?.status === 404 || /HTTP 404/.test(error?.message ?? "")) return `${hostOf(settings.node)} doesn't serve this Rave chain.`;
  if (error instanceof TypeError) return `Couldn't reach ${hostOf(settings.node)}.`;
  return `Couldn't read Rave from ${hostOf(settings.node)}: ${error?.message ?? error}`;
}

// The chain's state at the node's tip, read by CID. Reads within a few
// seconds share one tip, so a page drawn from many reads is one moment.
let current = null; // { at, promise }
function chainState({ fresh = false } = {}) {
  if (!fresh && current && Date.now() - current.at < 4000) return current.promise;
  const promise = nodes.read(chainPath(), async (node) => {
    const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node.url}/volumes`, { chainPath: chainPath() }));
    const { hash, generalStateCID } = await tip(sdk, node.url, chainPath(), volumes);
    return { hash, ...view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID) };
  });
  current = { at: Date.now(), promise };
  promise.catch(() => {
    if (current?.promise === promise) current = null;
  });
  return promise;
}

// Writes the reader has sent that are not in a block yet, by key. Every read
// sees them, so what the reader just did shows at once, marked as waiting.
const pending = new Map(); // key -> { value, batch }

/** A state view with the reader's pending writes laid over it. */
function overlaid(base) {
  return {
    hash: base.hash,
    async get(key) {
      return pending.has(key) ? pending.get(key).value : base.get(key);
    },
    async *list(prefix) {
      const extra = [...pending.keys()].filter((key) => key.startsWith(prefix)).sort();
      let i = 0;
      for await (const [key, value] of base.list(prefix)) {
        while (i < extra.length && extra[i] < key) {
          const v = pending.get(extra[i]).value;
          if (v !== undefined) yield [extra[i], v];
          i++;
        }
        if (i < extra.length && extra[i] === key) {
          const v = pending.get(key).value;
          if (v !== undefined) yield [key, v];
          i++;
        } else yield [key, value];
      }
      for (; i < extra.length; i++) {
        const v = pending.get(extra[i]).value;
        if (v !== undefined) yield [extra[i], v];
      }
    },
  };
}
const state = async (options) => overlaid(await chainState(options));
const isPending = (key) => pending.has(key);
const recordKey = (author, id) => `user/${author}/post/${id}`;

/** The fee `path`'s nodes ask of a transaction (minRelayFee), or 0 when they don't say. */
async function feeFor(path = chainPath()) {
  try {
    const info = await nodes.read(path, async (node) => {
      const url = new URL(`${node.url}/api/chain/info`);
      url.searchParams.set("chainPath", path.join("/"));
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });
    return BigInt(info?.minRelayFee ?? 0);
  } catch {
    return 0n;
  }
}

/**
 * Sends `build(address)`'s writes through the wallet. `as` is the account
 * the form was drawn for, if one was: a write never goes from another. An
 * account with no Rave card yet is asked for one first, and it goes in the
 * same transaction; `card` sends one as given. Resolves once the wallet has
 * sent them (they then show as pending); `landed` settles when they are in a
 * block. Throws NoWallet or Said.
 */
async function send(build, { status = () => {}, what = "This", as, card } = {}) {
  let address;
  try {
    address = await me();
  } catch (error) {
    if (error instanceof NoWallet) throw error;
    throw new Said(walletMessage(error));
  }
  if (as && as !== address) throw new Said("Selfhold is connected to another account than this was drawn for. Look again, then try.");
  if (!card && !(await hasCard(address))) {
    card = await askCard({ why: `${what} goes out under your Rave card. Make it first: it's what people see on what you write.` });
    if (!card) throw new Cancelled("");
  }
  status("Preparing…");
  let actions;
  const fee = await feeFor();
  try {
    await viaWallet(async () => {
      status("Approve it in Selfhold…");
      // Made against the newest state, so each oldValue is what the key holds.
      const base = await chainState({ fresh: true });
      actions = await write.changes(overlaid(base), [...(card ? write.card(address, card) : []), ...(await build(address))]);
      if (!actions.length) return;
      // A key still waiting on an earlier write can't be changed yet.
      if (actions.some((a) => pending.has(a.key))) throw new Said(`Your last change is still landing. Try again once it has.`);
      return wallet().writeRecords({ chainPath: chainPath(), actions, fee: String(fee) });
    });
  } catch (error) {
    if (error instanceof Said) throw error;
    // Sent, though the node did not confirm it: it is on its way, and the landing poll decides.
    if (!/may still land/i.test(String(error?.message ?? error))) throw new Said(walletMessage(error));
  }
  if (!actions.length) return { landed: Promise.resolve(true) };
  // A card is remembered until a block has it, so a reload doesn't ask again.
  if (card) store.set(cardKey(address), Date.now());
  const batch = {};
  for (const a of actions) pending.set(a.key, { value: a.newValue, batch });
  reader = null;
  render();
  const landed = landing(actions, batch).then((ok) => {
    for (const a of actions) if (pending.get(a.key)?.batch === batch) pending.delete(a.key);
    current = null;
    reader = null;
    if (!ok) toast(`${what} didn't land in a block after 15 minutes. It wasn't saved; try again.`, { bad: true });
    render();
    return ok;
  });
  return { landed };
}

// A card this browser sent and no block had yet, per account: when it was sent.
const cardKey = (account) => `card-sent:${account}`;
/** Whether `account` has a card: on the chain, waiting in this page, or sent from this browser in the last 15 minutes. */
async function hasCard(account) {
  const key = `user/${account}/card`;
  if ((await (await chainState()).get(key)) !== undefined) {
    store.set(cardKey(account), undefined);
    return true;
  }
  return pending.has(key) || Date.now() - store.get(cardKey(account), 0) < 15 * 60_000;
}

async function landing(actions, batch) {
  const started = Date.now();
  while (Date.now() - started < 15 * 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const now = await chainState({ fresh: true });
      let landed = true;
      for (const a of actions) if ((await now.get(a.key)) !== a.newValue) landed = false;
      if (landed) return true;
    } catch {
      /* one poll missed */
    }
  }
  return false;
}

// ---------------------------------------------------------------- photos

// A photo is a file kept by its author's own node as a Volume, named in the
// review by CID (client/media.mjs). The page reads it through the reader's
// node, which fetches it from peers, checks it against the CID, and shows
// only raster images: an SVG is a document that can run script.
const PHOTO_TYPES = /^image\/(png|jpeg|webp|gif|avif)$/;
const PHOTO_MAX = 2_000_000;
const photos = new Map(); // cid -> Promise<object URL | null>
function photoURL(cid) {
  if (!photos.has(cid)) {
    const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${settings.node}/volumes`, { chainPath: chainPath() }));
    const pending = (async () => {
      // A node reading it from the author's node may answer busy: ask again.
      let volume;
      for (let wait = 1000; !volume; wait *= 2) {
        volume = await volumes.get(cid).catch((error) => {
          if (wait > 8000) throw error;
          return new Promise((resolve) => setTimeout(resolve, wait));
        });
      }
      const file = sdk.decodeDagCbor(volume.bytes(cid));
      if (typeof file?.type !== "string" || !PHOTO_TYPES.test(file.type) || !(file.bytes instanceof Uint8Array) || file.bytes.length > PHOTO_MAX) return null;
      return URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
    })().catch(() => {
      photos.delete(cid);
      return null;
    });
    photos.set(cid, pending);
  }
  return photos.get(cid);
}
function showPhotos(root) {
  for (const img of $$("img[data-media]", root)) {
    photoURL(img.dataset.media).then((url) => {
      if (url) {
        img.src = url;
        img.hidden = false;
      }
    });
  }
}

/** A picture made small enough to keep: at most 1600 px on a side, JPEG. */
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  return { type: "image/jpeg", bytes: new Uint8Array(await blob.arrayBuffer()) };
}

// ---------------------------------------------------------------- names

// An account is shown by its Rave card, read from this chain, and the
// @handle Moniker verifies for it, through the Moniker SDK. Moniker's own
// hosts serve only Moniker's chain: another chain is read from the reader's
// node alone.
const monikerNodes = settings.moniker === MONIKER.chain.join("/") ? [settings.node, ...MONIKER.nodes.filter((n) => n !== settings.node)] : [settings.node];
const moniker = createMoniker({ sdk, chain: settings.moniker.split("/"), nodes: monikerNodes, freshFor: 3000 });
/** A Moniker client for writing, proposing the fee Moniker's nodes ask. */
const monikerWriter = async () => createMoniker({ sdk, chain: settings.moniker.split("/"), nodes: monikerNodes, freshFor: 3000, fee: await feeFor(settings.moniker.split("/")) });

const known = new Map(); // address -> { card?, handle? }
// When each account was last read: its handle is checked again after this long.
const asked = new Map();
const VERIFIED_FOR = 10_000;
async function learnNames(addresses) {
  const wanted = [...new Set(addresses)].filter((a) => a && !(Date.now() - (asked.get(a) ?? 0) < VERIFIED_FOR));
  if (!wanted.length) return;
  wanted.forEach((a) => asked.set(a, Date.now()));
  try {
    const [cards, handles] = await Promise.all([state().then((s) => read.cards(s, wanted)), moniker.handlesOf(wanted).catch(() => [])]);
    wanted.forEach((a, i) => known.set(a, { card: cards[i], handle: handles[i] }));
  } catch {
    wanted.forEach((a) => asked.delete(a));
    return;
  }
  showNames(wanted);
}
/** Fills in every byline and avatar of `addresses` already on the page. */
function showNames(addresses) {
  for (const a of addresses) {
    const who = known.get(a);
    if (!who) continue;
    for (const el of $$(`[data-name="${CSS.escape(a)}"]`)) el.innerHTML = bylineHTML(a, who);
    for (const el of $$(`[data-initials="${CSS.escape(a)}"]`)) {
      if (!el.querySelector("img")) el.textContent = initials(nameOf(a, who));
      const cid = who.card?.photo;
      if (cid) photoURL(cid).then((url) => url && el.isConnected && (el.innerHTML = `<img alt="" src="${esc(url)}">`));
    }
  }
}
const nameTag = (a) => `<span data-name="${esc(a)}">${bylineHTML(a, known.get(a))}</span>`;
const avatarTag = (a) => `<span class="avatar" data-initials="${esc(a)}" aria-hidden="true">${known.has(a) ? esc(initials(nameOf(a, known.get(a)))) : ""}</span>`;

// ---------------------------------------------------------- the reader

// The connected reader's card and handle, whom they follow and whose labels they use, from the chains.
let reader = null; // { address, card, handle, follows: Set, labelers: Set, hash }
async function readerOf(s) {
  if (!connected) return { address: null, follows: new Set(), labelers: new Set() };
  if (reader && reader.address === connected && reader.hash === s.hash && !pending.size) return reader;
  const [follows, labelers, card, handle] = await Promise.all([
    read.follows(s, connected), read.labelers(s, connected), read.card(s, connected), moniker.handleOf(connected).catch(() => undefined),
  ]);
  known.set(connected, { card, handle });
  reader = { address: connected, hash: s.hash, card, handle, follows: new Set(follows), labelers: new Set(labelers) };
  return reader;
}

/** What the reader chose for each label of each labeler: "show", "warn" or "hide". */
const modes = () => store.get("modes", {});
const modeOf = (labeler, name) => modes()[`${labeler}/${name}`] ?? trust.DEFAULT_MODES[name] ?? "warn";

/** The labels the reader's labelers put on things: "<author>/<id>" → [{ label, by, reply }]. */
async function labelsFor(s, who) {
  const all = new Map();
  await Promise.all(
    [...who.labelers].map(async (labeler) => {
      const { replies } = await read.by(s, labeler);
      for (const [key, list] of read.labelsFrom(replies)) all.set(key, [...(all.get(key) ?? []), ...list]);
    }),
  );
  return all;
}

// ------------------------------------------------------------------ map

let map = null;
let markers = null;
function ensureMap() {
  if (map || !window.L) return map;
  const saved = store.get("view", DEFAULTS.view);
  map = L.map("map", { zoomControl: false, attributionControl: true }).setView([saved.lat, saved.lon], saved.zoom);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  // Tiles are pictures of the map only; no Rave data goes to the tile host.
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  markers = L.layerGroup().addTo(map);
  // For tests and scripted tours: move the map by [dLat, dLon].
  window.addEventListener("rave-test-pan", (e) => {
    const c = map.getCenter();
    map.setView([c.lat + e.detail[0], c.lng + e.detail[1]], map.getZoom(), { animate: false });
  });
  let timer;
  map.on("moveend", () => {
    const c = map.getCenter();
    store.set("view", { lat: c.lat, lon: c.lng, zoom: map.getZoom() });
    clearTimeout(timer);
    timer = setTimeout(() => mapMoved(), 250);
  });
  const locate = document.createElement("button");
  Object.assign(locate, { type: "button", className: "locate", title: "Near me" });
  locate.setAttribute("aria-label", "Near me");
  locate.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;
  locate.addEventListener("click", () =>
    navigator.geolocation?.getCurrentPosition(
      (p) => map.setView([p.coords.latitude, p.coords.longitude], 16),
      () => toast("Couldn't get your location. Move the map instead."),
      { timeout: 10_000 },
    ));
  $("#map").append(locate);
  return map;
}
const pinIcon = (on) => L.divIcon({ className: "", html: `<div class="pin${on ? " on" : ""}"></div>`, iconSize: [28, 28], iconAnchor: [14, 28] });
function showPins(places, { on, fit = false } = {}) {
  if (!ensureMap()) return;
  markers.clearLayers();
  for (const p of places) {
    const c = map.getCenter().lng;
    const lon = p.lon + 360 * Math.round((c - p.lon) / 360);
    const marker = L.marker([p.lat, lon], { icon: pinIcon(on && p.author === on.author && p.id === on.id), title: p.name, keyboard: false });
    marker.on("click", () => (location.hash = placeHref(p)));
    marker.addTo(markers);
  }
  if (fit && places.length) {
    if (places.length === 1) map.setView([places[0].lat, places[0].lon], Math.max(map.getZoom(), 16));
    else map.fitBounds(places.map((p) => [p.lat, p.lon]), { padding: [40, 40], maxZoom: 16 });
  }
}
/** A longitude in [-180, 180). */
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
/** The map's view as a box in real longitudes (east < west when it spans ±180°), or null when it's the whole world. */
function viewBox() {
  const b = map.getBounds();
  if (b.getEast() - b.getWest() >= 360) return null;
  const west = wrapLon(b.getWest());
  let east = west + (b.getEast() - b.getWest());
  if (east >= 180) east -= 360;
  return { south: b.getSouth(), north: b.getNorth(), west, east };
}
const inBox = (box, p) =>
  p.lat >= box.south && p.lat <= box.north && (box.west <= box.east ? p.lon >= box.west && p.lon <= box.east : p.lon >= box.west || p.lon <= box.east);
let onMapMoved = () => {};
const mapMoved = () => onMapMoved();

// --------------------------------------------------------------- toasts

function toast(message, { bad = false, ms = 6000 } = {}) {
  const box = document.createElement("div");
  box.className = `toast${bad ? " bad" : ""}`;
  box.setAttribute("role", bad ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = message;
  const close = Object.assign(document.createElement("button"), { type: "button", textContent: "×", title: "Dismiss" });
  close.addEventListener("click", () => box.remove());
  box.append(text, close);
  $("#toasts").append(box);
  if (!bad) setTimeout(() => box.remove(), ms);
}

// --------------------------------------------------------------- render

let renderToken = 0;
let shownView = null;
async function render() {
  const token = ++renderToken;
  const route = parseRoute(location.hash);
  const viewChanged = shownView !== route.view + JSON.stringify(route);
  shownView = route.view + JSON.stringify(route);
  document.body.className = `view-${route.view}${["explore", "add", "edit"].includes(route.view) ? " with-map" : ""}`;
  for (const tab of $$("#tabs a")) {
    const on = tab.dataset.tab === ({ place: "explore", write: "explore", add: "explore", edit: "explore", reviewer: "following", settings: "you" }[route.view] ?? route.view);
    if (on) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (document.body.classList.contains("with-map") || matchMedia("(min-width: 900px)").matches) {
    ensureMap();
    // The map was hidden while the view changed: it measures itself again.
    map?.invalidateSize();
  }
  onMapMoved = () => {};
  const panel = $("#panel");
  if (viewChanged) {
    panel.scrollTop = 0;
    panel.innerHTML = "";
    delete panel.dataset.place;
  }
  const stale = () => token !== renderToken;
  try {
    const views = { explore, place, write: writeView, add: addView, edit: addView, following, reviewer, you, settings: settingsView };
    await views[route.view](panel, route, stale, viewChanged);
  } catch (error) {
    if (stale()) return;
    console.warn(error);
    panel.innerHTML = `<div class="wrap"><div class="notice bad" role="alert"><b>${esc(readFailure(error))}</b><p style="margin:6px 0 0">Rave reads everything from a node. Try again, or choose another node in Settings.</p></div>
      <div class="actions"><button class="btn" type="button" data-retry>Try again</button><a class="btn quiet" href="#/settings">Settings</a></div></div>`;
    $("[data-retry]", panel).addEventListener("click", () => {
      current = null;
      render();
    });
  }
}

/** Set the panel's HTML unless a newer render started. */
const paint = (panel, stale, html) => {
  if (stale()) return false;
  panel.innerHTML = html;
  return true;
};

// --------------------------------------------------------------- Explore

let exploreQuery = "";
let exploreCategory = "All";
async function explore(panel, route, stale) {
  if (!$("#explore-top", panel)) {
    panel.innerHTML = `<div id="explore-top">
      <div class="search" role="search"><input id="q" type="search" placeholder="Search this area" aria-label="Search this area" value="${esc(exploreQuery)}" autocomplete="off"></div>
      <div class="chips" role="group" aria-label="Category">${["All", ...CATEGORIES].map((c) => `<button type="button" class="chip" data-cat="${c}" aria-pressed="${c === exploreCategory}">${c}</button>`).join("")}</div>
    </div><div id="explore-list"><p class="skeleton">Looking around…</p></div>`;
    $("#q", panel).addEventListener("input", (e) => {
      exploreQuery = e.target.value;
      drawList();
    });
    $$("[data-cat]", panel).forEach((b) =>
      b.addEventListener("click", () => {
        exploreCategory = b.dataset.cat;
        $$("[data-cat]", panel).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        drawList();
      }));
    if (!$(".fab")) {
      const add = Object.assign(document.createElement("a"), { className: "btn small fab", href: "#/add", textContent: "+ Add a place" });
      $("#map").append(add);
    }
  }
  let found = []; // [{ place, summary, dist }]
  let tooWide = false;
  const drawList = () => {
    const list = $("#explore-list", panel);
    if (!list) return;
    if (tooWide) {
      list.innerHTML = `<div class="empty"><p>Zoom in to see places.</p></div>`;
      showPins([]);
      return;
    }
    const q = exploreQuery.trim().toLowerCase();
    const shown = found.filter(({ place: p }) =>
      (exploreCategory === "All" || (p.category ?? "Other") === exploreCategory) &&
      (!q || p.name.toLowerCase().includes(q) || (p.category ?? "").toLowerCase().includes(q) || (p.address ?? "").toLowerCase().includes(q)));
    showPins(shown.map((f) => f.place));
    if (!found.length) {
      list.innerHTML = `<div class="empty"><p>No places here yet.</p><a class="btn" href="#/add">Add the first one</a></div>`;
      return;
    }
    if (!shown.length) {
      list.innerHTML = `<div class="empty"><p>Nothing here matches “${esc(exploreQuery.trim() || exploreCategory)}”.</p></div>`;
      return;
    }
    list.innerHTML = `<div class="list-head"><h1 class="small muted" style="font-weight:600">${plural(shown.length, "place")} in this area</h1></div>` +
      shown.map(({ place: p, summary: s, dist }) => `<a class="row" href="${placeHref(p)}">
        <span class="tile" aria-hidden="true">${esc([...p.name][0]?.toUpperCase() ?? "?")}</span>
        <span class="main"><span class="name">${esc(p.name)}</span>
          <span class="sub">${esc(p.category ?? "Place")} · ${metres(dist)}${isPending(recordKey(p.author, p.id)) ? ` · <span class="pending-note">Waiting for a block…</span>` : ""}</span></span>
        <span class="rating">${s.everyone.count ? `${oneStar}<span aria-label="${average(s.everyone.average)} stars from ${plural(s.everyone.count, "review")}">${average(s.everyone.average)} <span class="muted" style="font-weight:400">(${s.everyone.count})</span></span>` : `<span class="none">No reviews</span>`}</span>
      </a>`).join("");
  };
  let loads = 0;
  const load = async () => {
    if (!map) return;
    // Only the newest load for the newest view may draw.
    const mine = ++loads;
    const box = viewBox();
    const cells = box && geo.cover(box);
    tooWide = !cells;
    if (tooWide) return drawList();
    const s = await state();
    const who = await readerOf(s);
    const center = map.getCenter();
    const here = { lat: center.lat, lon: wrapLon(center.lng) };
    const places = (await read.placesIn(s, cells))
      .filter((p) => inBox(box, p))
      .map((p) => ({ place: p, dist: geo.distance(here, p) }))
      .sort((x, y) => x.dist - y.dist)
      .slice(0, 80);
    const withScores = await Promise.all(places.map(async (x) => ({ ...x, summary: trust.summary(await read.reviews(s, x.place), who.follows) })));
    if (stale() || mine !== loads) return;
    found = withScores;
    drawList();
  };
  onMapMoved = () => load().catch((error) => {
    if (!stale()) $("#explore-list", panel).innerHTML = `<div class="notice bad" role="alert">${esc(readFailure(error))} <button class="linkish" type="button" data-retry>Try again</button></div>`;
    $("[data-retry]", panel)?.addEventListener("click", () => onMapMoved());
  });
  await load();
}

// ----------------------------------------------------------------- Place

const placeUI = { key: "", star: 0, order: "followed", reveal: new Set(), showHidden: false };

async function place(panel, route, stale, arrived) {
  const key = `${route.place.author}/${route.place.id}`;
  // Each visit starts as the reader's choices have it: nothing revealed, no filter.
  if (arrived || placeUI.key !== key) Object.assign(placeUI, { key, star: 0, order: "followed", reveal: new Set(), showHidden: false });
  if (!panel.dataset.place || panel.dataset.place !== key) panel.innerHTML = `<p class="skeleton">Loading…</p>`;
  panel.dataset.place = key;
  const s = await state();
  const p = await read.place(s, route.place.author, route.place.id);
  if (stale()) return;
  if (!p) {
    paint(panel, stale, `<div class="top"><a class="back" href="#/">${backIcon}Explore</a></div><div class="empty"><p>This place isn't on Rave, or its author removed it.</p></div>`);
    return;
  }
  const who = await readerOf(s);
  const [all, placeReplies, labels] = await Promise.all([read.reviews(s, p), read.replies(s, p), labelsFor(s, who)]);
  const extras = await Promise.all(all.map(async (r) => {
    const [helpers, replies, history] = await Promise.all([read.helpful(s, r), read.replies(s, r), read.by(s, r.author)]);
    return [r, { helpers, replies, history: trust.history(history.reviews) }];
  }));
  if (stale()) return;
  const extra = new Map(extras.map(([r, x]) => [`${r.author}/${r.id}`, x]));
  learnNames([p.author, ...all.map((r) => r.author), ...placeReplies.map((r) => r.author), ...extras.flatMap(([, x]) => x.replies.map((r) => r.author)), ...who.labelers]);
  const summary = trust.summary(all, who.follows);
  const mine = who.address && all.find((r) => r.author === who.address);
  // The place's own labels, from the reader's labelers: closed, same-as.
  const placeVerdict = trust.verdict(labels.get(key), modeOf);
  const dupOf = placeVerdict.labels.find((l) => l.label.startsWith("same-as:"));
  const dup = dupOf && read.ref(dupOf.label.slice("same-as:".length));
  const dupPlace = dup && (await read.place(s, dup.author, dup.id));
  // Reviews: one star level at a time, ordered as the reader chose, labels applied.
  let list = trust.order(all, placeUI.order, { followed: who.follows, helpfulCount: (r) => extra.get(`${r.author}/${r.id}`).helpers.size });
  if (placeUI.star) list = list.filter((r) => r.stars === placeUI.star);
  const judged = list.map((r) => ({ r, v: trust.verdict(labels.get(`${r.author}/${r.id}`), modeOf) }));
  const hidden = judged.filter((j) => j.v.mode === "hide");
  const visible = placeUI.showHidden ? judged : judged.filter((j) => j.v.mode !== "hide");
  const facts = [
    p.address && `<span>${esc(p.address)}</span>`,
    p.hours && `<span>${esc(p.hours)}</span>`,
    p.phone && `<span><a href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${esc(p.phone)}</a></span>`,
    safeLink(p.url) && `<span><a href="${esc(safeLink(p.url))}" target="_blank" rel="noopener noreferrer nofollow">${esc(new URL(safeLink(p.url)).host)}</a></span>`,
    `<span><a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=18/${p.lat}/${p.lon}" target="_blank" rel="noopener">Open in a map</a> · added by <a href="${userHref(p.author)}">${nameTag(p.author)}</a> ${when(p.time)}</span>`,
  ].filter(Boolean);
  const followedScore = who.address
    ? summary.followed.count
      ? `<div class="score"><b>${average(summary.followed.average)}</b><span class="who">People you follow · ${summary.followed.count}</span></div>`
      : `<div class="score"><b>–</b><span class="who">No one you follow has reviewed it</span></div>`
    : `<div class="score"><b>–</b><span class="who"><a href="#/you">Connect</a> to see people you follow</span></div>`;
  const bars = summary.everyone.count >= trust.SPREAD_MIN
    ? `<div class="bars" role="group" aria-label="Filter by stars">${[5, 4, 3, 2, 1].map((n) => {
        const count = summary.spread[n - 1];
        const pct = Math.round((count / summary.everyone.count) * 100);
        return `<button type="button" class="bar" data-star="${n}" aria-pressed="${placeUI.star === n}" aria-label="${n} star: ${plural(count, "review")}${placeUI.star === n ? ", showing only these" : ""}"><span>${n} ★</span><span class="track"><span class="fill" style="width:${pct}%"></span></span><span class="n">${count}</span></button>`;
      }).join("")}</div>`
    : "";
  const html = `
    <div class="top"><a class="back" href="#/">${backIcon}Explore</a></div>
    <div class="place-head">
      <h1 class="title">${esc(p.name)}</h1>
      <div class="muted">${esc(p.category ?? "Place")}${isPending(recordKey(p.author, p.id)) ? ` · <span class="pending-note">Waiting for a block…</span>` : ""}</div>
    </div>
    <div class="facts">${facts.join("")}</div>
    ${placeVerdict.labels.filter((l) => l.mode !== "show" || l.label.startsWith("same-as:")).map((l) =>
      l.label.startsWith("same-as:")
        ? `<div class="notice" data-dup>Possibly the same place as ${dupPlace ? `<a href="${placeHref(dupPlace)}">${esc(dupPlace.name)}</a>` : "another listing"}. <button type="button" class="linkish" data-why>Why?</button><div data-why-text hidden class="small" style="margin-top:6px">Anyone can add a place, so the same place can be listed twice. ${nameTag(l.by)}, whose labels you use, says so${l.reply.body ? `: “${esc(l.reply.body)}”` : "."} Rave never merges listings; you can read both.</div></div>`
        : `<div class="notice">Labelled ${esc(labelText(l.label))} by ${nameTag(l.by)}${l.reply.body ? `: “${esc(l.reply.body)}”` : ""}</div>`).join("")}
    <div class="scores">${followedScore}<div class="score"><b>${average(summary.everyone.average)}</b><span class="who">Everyone · ${summary.everyone.count}</span></div></div>
    <div class="recent">${plural(summary.recent, "review")} in the last 3 months</div>
    ${bars}
    <div class="actions">
      <a class="btn" href="${placeHref(p)}/review">${mine ? "Edit your review" : "Write a review"}</a>
      ${who.address === p.author ? `<a class="btn quiet" href="${placeHref(p)}/edit">Edit details</a>` : ""}
      <button type="button" class="btn quiet" data-label-place>Label…</button>
    </div>
    ${placeReplies.length ? `<h2 class="section-title" style="font-size:16px">Notes on this place</h2><div style="padding:0 16px"><div class="replies" style="margin-left:0">${placeReplies.map((x) => replyHTML(x)).join("")}</div></div>` : ""}
    <div class="order">
      <h2 style="font-size:18px">Reviews</h2>
      <label class="order-pick"><span class="sr">Order: </span><select id="order">${Object.entries(trust.ORDERS).map(([k, v]) => `<option value="${k}"${k === placeUI.order ? " selected" : ""}>${v}</option>`).join("")}</select></label>
    </div>
    ${placeUI.star ? `<div class="footer-note">Showing ${placeUI.star}-star reviews only · <button type="button" class="linkish" data-star="${placeUI.star}">Show all</button></div>` : ""}
    <div id="reviews">${visible.length ? visible.map(({ r, v }) => reviewHTML(r, v, extra.get(`${r.author}/${r.id}`), who)).join("") : `<div class="empty"><p>${all.length ? "No reviews match." : "No reviews yet. Be the first."}</p></div>`}</div>
    ${hidden.length ? `<div class="footer-note" data-hidden-note>${hidden.length} hidden by your labelers · <button type="button" class="linkish" data-show-hidden>${placeUI.showHidden ? "Hide them" : "Show"}</button></div>` : ""}`;
  if (!paint(panel, stale, html)) return;
  if (matchMedia("(min-width: 900px)").matches) showPins([p], { on: p, fit: true });
  showPhotos(panel);
  showNames([p.author, ...all.map((r) => r.author)]);
  wirePlace(panel, p, all, who);
}

const oneStar = `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="${starPath}" fill="var(--star)"/></svg>`;
const backIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke-width="2.2" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`;

function replyHTML(x) {
  const pendingNote = isPending(recordKey(x.author, x.id)) ? `<span class="pending-note">Waiting for a block…</span>` : when(x.time);
  return `<div class="reply${isPending(recordKey(x.author, x.id)) ? " pending" : ""}">
    <div class="by"><a href="${userHref(x.author)}">${nameTag(x.author)}</a> · ${pendingNote}${x.labels.map((l) => ` <span class="badge label">${esc(labelText(l))}</span>`).join("")}</div>
    ${x.body ? `<p>${esc(x.body)}</p>` : ""}
  </div>`;
}

function reviewHTML(r, v, x, who) {
  const key = `${r.author}/${r.id}`;
  const waiting = isPending(recordKey(r.author, r.id)) || isPending(`index/review/${r.on.author}/${r.on.id}/${r.author}`);
  const follows = who.follows.has(r.author);
  const isMe = who.address === r.author;
  const hist = x.history;
  const head = `<div class="who-line">${avatarTag(r.author)}<div class="id">
      <span><a href="${userHref(r.author)}">${nameTag(r.author)}</a>${isMe ? `<span class="badge">You</span>` : follows ? `<span class="badge">You follow</span>` : ""}</span>
      <span class="hist">${plural(hist.count, "review")}${hist.since ? ` · since ${monthYear(hist.since)}` : ""} ${sparkline(hist.spread)}</span>
    </div></div>`;
  if (v.mode !== "show" && !placeUI.reveal.has(key) && !(v.mode === "hide" && placeUI.showHidden)) {
    const why = v.labels.filter((l) => l.mode === v.mode).map((l) => `${esc(labelText(l.label))} by ${nameTag(l.by)}`).join(", ");
    return `<article class="review" data-review="${esc(key)}">${head}<div class="folded" style="margin-top:8px"><span>Labelled ${why}</span><button type="button" class="linkish" data-reveal="${esc(key)}">Show</button></div></article>`;
  }
  const labelsNote = v.labels.filter((l) => l.mode !== "show").map((l) => `<span class="badge label">${esc(labelText(l.label))} · ${nameTag(l.by)}</span>`).join(" ");
  const helped = who.address && x.helpers.has(who.address);
  return `<article class="review${waiting ? " pending" : ""}" data-review="${esc(key)}">
    ${head}
    <div class="rv-meta">${stars(r.stars)}${waiting ? `<span class="pending-note">Waiting for a block…</span>` : `${when(r.time)}${r.edited ? " · Edited" : ""}`} ${labelsNote}</div>
    ${r.body ? `<p class="rv-body">${esc(r.body)}</p>` : ""}
    ${r.media.length ? `<div class="photos">${r.media.map((cid) => `<img alt="Photo from this review" data-media="${esc(cid)}" hidden>`).join("")}</div>` : ""}
    ${waiting ? "" : `<div class="rv-acts">
      <button type="button" data-helpful="${esc(key)}" aria-pressed="${!!helped}">Helpful${x.helpers.size ? ` · ${x.helpers.size}` : ""}</button>
      <button type="button" data-reply="${esc(key)}">Reply</button>
      ${isMe ? "" : `<button type="button" data-label-review="${esc(key)}">Label…</button>`}
    </div>`}
    ${x.replies.length ? `<div class="replies">${x.replies.map(replyHTML).join("")}</div>` : ""}
  </article>`;
}

function wirePlace(panel, p, all, who) {
  $("#order", panel)?.addEventListener("change", (e) => {
    placeUI.order = e.target.value;
    render();
  });
  $$("[data-star]", panel).forEach((b) => b.addEventListener("click", () => {
    const n = Number(b.dataset.star);
    placeUI.star = placeUI.star === n ? 0 : n;
    render();
  }));
  $$("[data-reveal]", panel).forEach((b) => b.addEventListener("click", () => {
    placeUI.reveal.add(b.dataset.reveal);
    render();
  }));
  $("[data-show-hidden]", panel)?.addEventListener("click", () => {
    placeUI.showHidden = !placeUI.showHidden;
    render();
  });
  $("[data-why]", panel)?.addEventListener("click", (e) => {
    const t = $("[data-why-text]", panel);
    t.hidden = !t.hidden;
    e.target.setAttribute("aria-expanded", String(!t.hidden));
  });
  const reviewOf = (key) => all.find((r) => `${r.author}/${r.id}` === key);
  $$("[data-helpful]", panel).forEach((b) => b.addEventListener("click", async () => {
    const r = reviewOf(b.dataset.helpful);
    const on = b.getAttribute("aria-pressed") !== "true";
    b.disabled = true;
    try {
      await send((a) => write.helpful(a, r, on), { what: "Your helpful mark", as: who.address });
    } catch (error) {
      b.disabled = false;
      failed(error, "Marking a review helpful");
    }
  }));
  $$("[data-reply]", panel).forEach((b) => b.addEventListener("click", () => openReply(reviewOf(b.dataset.reply), who.address)));
  $$("[data-label-review]", panel).forEach((b) => b.addEventListener("click", () => openLabel(reviewOf(b.dataset.labelReview), "review", who.address)));
  $("[data-label-place]", panel)?.addEventListener("click", () => openLabel(p, "place", who.address));
}

/** A failed write, said where the reader is looking. */
function failed(error, what) {
  if (error instanceof NoWallet) return needWallet(`${what} needs Selfhold.`);
  if (error instanceof Cancelled) return;
  toast(error instanceof Said ? error.message : walletMessage(error), { bad: true });
}

// ------------------------------------------------------------- dialogs

for (const dialog of $$("dialog")) {
  dialog.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]") && !dialog.hasAttribute("data-busy")) dialog.close();
  });
  dialog.addEventListener("cancel", (e) => dialog.hasAttribute("data-busy") && e.preventDefault());
}
// Enter in a field sends, as the dialog's main button does.
for (const [form, button] of [["#card-dialog form", "#cd-send"], ["#handle-dialog form", "#hd-send"]]) {
  $(form).addEventListener("submit", (e) => {
    e.preventDefault();
    $(button).click();
  });
}

/** Runs a dialog's send: the button and fields lock while the wallet is asked. */
async function sendFromDialog(dialog, statusEl, button, build, what, done, as) {
  const lock = (on) => {
    dialog.toggleAttribute("data-busy", on);
    button.disabled = on;
    $$("textarea, input, [data-close]", dialog).forEach((f) => (f.disabled = on));
  };
  lock(true);
  statusEl.classList.remove("bad");
  try {
    const { landed } = await send(build, { status: (t) => (statusEl.textContent = t), what, as });
    lock(false);
    dialog.close();
    done?.(landed);
  } catch (error) {
    lock(false);
    if (error instanceof NoWallet) {
      statusEl.textContent = "";
      return needWallet(`${what} needs Selfhold.`);
    }
    statusEl.textContent = error instanceof Said ? error.message : walletMessage(error);
    if (!(error instanceof Cancelled)) statusEl.classList.add("bad");
  }
}

function openReply(target, as) {
  const dialog = $("#reply-dialog");
  $("#rd-about").innerHTML = `To ${nameTag(target.author)}'s review. Replies are public, and anyone can reply, owners included.`;
  $("#rd-body").value = "";
  $("#rd-status").textContent = "";
  dialog.showModal();
  $("#rd-body").focus();
  $("#rd-send").onclick = () => {
    const body = $("#rd-body").value.trim();
    if (!body) {
      $("#rd-status").textContent = "Write something first.";
      return;
    }
    sendFromDialog(dialog, $("#rd-status"), $("#rd-send"), (a) => write.reply(a, write.newId(), target, { body }), "Your reply", undefined, as);
  };
}

async function openLabel(target, kind, as) {
  const dialog = $("#label-dialog");
  const choices = kind === "place" ? [["closed", "Closed"], ["same-as", "Duplicate"]] : [["paid", "Paid for"], ["fake", "Fake"], ["spam", "Spam"]];
  let picked = choices[0][0];
  let dup = null;
  $("#ld-title").textContent = kind === "place" ? `Label ${target.name}` : "Label this review";
  $("#ld-body").value = "";
  $("#ld-status").textContent = "";
  const drawChoices = () => {
    $("#ld-labels").innerHTML = choices.map(([k, v]) => `<button type="button" class="chip" role="radio" aria-checked="${k === picked}" data-pick="${k}">${v}</button>`).join("");
    $$("[data-pick]", dialog).forEach((b) => b.addEventListener("click", () => {
      picked = b.dataset.pick;
      drawChoices();
    }));
    $("#ld-dup").hidden = picked !== "same-as";
  };
  drawChoices();
  if (kind === "place") {
    // A duplicate is one of the places nearby.
    const s = await state();
    const near = (await read.placesIn(s, geo.around(target, 100))).filter((q) => !(q.author === target.author && q.id === target.id) && geo.distance(q, target) <= 100);
    $("#ld-dup").innerHTML = near.length
      ? `<fieldset style="border:0;padding:0;margin:0"><legend class="small" style="font-weight:600">The same place as</legend>${near.map((q, i) => `<label style="display:flex;gap:8px;align-items:center;min-height:36px"><input type="radio" name="dup" value="${i}"${i === 0 ? " checked" : ""}> ${esc(q.name)} <span class="muted small">${metres(geo.distance(q, target))}</span></label>`).join("")}</fieldset>`
      : `<p class="small muted" style="margin:0">No other place within 100 m to mark it a duplicate of.</p>`;
    dup = near;
  }
  dialog.showModal();
  $("#ld-send").onclick = () => {
    let label = picked;
    if (picked === "same-as") {
      const i = Number($("input[name=dup]:checked", dialog)?.value);
      const other = dup?.[i];
      if (!other) {
        $("#ld-status").textContent = "Pick the place it duplicates.";
        return;
      }
      label = `same-as:${other.author}/${other.id}`;
    }
    const body = $("#ld-body").value.trim();
    sendFromDialog(dialog, $("#ld-status"), $("#ld-send"), (a) => write.reply(a, write.newId(), target, { body, labels: [label] }), "Your label", () =>
      toast("Labelled. People who use your labels will see it."), as);
  };
}

// ----------------------------------------------------------------- Write

const drafts = new Map(); // place key -> { stars, body }
async function writeView(panel, route, stale) {
  const key = `${route.place.author}/${route.place.id}`;
  const s = await state();
  const p = await read.place(s, route.place.author, route.place.id);
  if (stale()) return;
  if (!p) return paint(panel, stale, `<div class="empty"><p>This place isn't on Rave.</p></div>`);
  const drawnFor = connected;
  const mine = connected ? await read.reviewOf(s, connected, p) : undefined;
  if (stale()) return;
  const draft = drafts.get(key) ?? { stars: mine?.stars ?? 0, body: mine?.body ?? "", media: mine?.media ?? [] };
  drafts.set(key, draft);
  const html = `
    <div class="top"><h1 style="font-size:18px">${esc(p.name)}</h1><a class="back" href="${placeHref(p)}" aria-label="Close" style="padding:0 8px"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke-width="2.2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></a></div>
    <div class="star-pick">
      <div role="radiogroup" aria-label="Stars" id="pick"></div>
      <div class="star-word" id="star-word"></div>
      <div class="small muted">Stars alone are a complete review.</div>
    </div>
    <div class="form">
      <label class="field">Add a few words (optional)<textarea id="body" rows="5" maxlength="5000" placeholder="What should someone know before they go?">${esc(draft.body)}</textarea></label>
      <div class="field" style="gap:8px"><span>Photos (optional, up to 10)</span>
        <div class="photos" id="w-photos"></div>
        ${settings.ownNode && settings.ownCookie
          ? `<label class="btn quiet" style="align-self:flex-start" id="w-add-photo">Add photos<input id="photo-file" type="file" accept="image/png,image/jpeg,image/webp" multiple class="sr"></label><p class="small muted" style="margin:0" id="w-photo-note">Your node, ${esc(hostOf(settings.ownNode))}, keeps them. People see them while it's online.</p>`
          : `<p class="small muted" style="margin:0">Photos are kept by your own Lattice node, not by Rave. <a href="#/settings">Add your node in Settings</a> to attach some.</p>`}
      </div>
      <p class="small muted" style="margin:0">Your review is public and signed by your key.${mine ? " Editing keeps its date and marks it edited; earlier versions stay in the chain's history." : " You can edit or delete it later; earlier versions stay in the chain's history."}</p>
      <p class="status${redrawNote ? " bad" : ""}" id="w-status" role="status">${esc(redrawNote)}</p>
      <button type="button" class="btn wide" id="post">${mine ? "Save changes" : "Post review"}</button>
      ${mine ? `<button type="button" class="linkish" id="delete" style="align-self:center;color:var(--bad)">Delete your review</button>` : ""}
    </div>`;
  if (!paint(panel, stale, html)) return;
  redrawNote = "";
  if (matchMedia("(min-width: 900px)").matches) showPins([p], { on: p, fit: true });
  const drawStars = () => {
    $("#pick").innerHTML = [1, 2, 3, 4, 5].map((i) => `<button type="button" role="radio" aria-checked="${draft.stars === i}" aria-label="${i} of 5 stars" data-stars="${i}" tabindex="${(draft.stars || 1) === i ? 0 : -1}"><svg width="44" height="44" viewBox="0 0 24 24" aria-hidden="true"><path d="${starPath}" fill="${i <= draft.stars ? "var(--star)" : "transparent"}" stroke="${i <= draft.stars ? "var(--star)" : "var(--faint)"}" stroke-width="1.4"/></svg></button>`).join("");
    $("#star-word").textContent = STAR_WORDS[draft.stars];
    $("#post").disabled = !draft.stars;
    $$("[data-stars]").forEach((b) => b.addEventListener("click", () => {
      draft.stars = Number(b.dataset.stars);
      drawStars();
      $(`[data-stars="${draft.stars}"]`).focus();
    }));
  };
  drawStars();
  $("#pick").addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    draft.stars = Math.min(5, Math.max(1, (draft.stars || 0) + step));
    drawStars();
    $(`[data-stars="${draft.stars}"]`).focus();
  });
  $("#body").addEventListener("input", (e) => (draft.body = e.target.value));
  const local = new Map(); // cid -> object URL of a photo added here
  const drawPhotos = () => {
    $("#w-photos").innerHTML = draft.media.map((cid, i) => `<span style="position:relative;flex:none"><img alt="Photo ${i + 1}" data-media="${esc(cid)}" ${local.has(cid) ? `src="${local.get(cid)}"` : "hidden"} style="height:96px"><button type="button" class="chip" data-remove="${i}" aria-label="Remove photo ${i + 1}" style="position:absolute;right:4px;top:4px;min-height:28px;padding:0 9px">×</button></span>`).join("");
    showPhotos($("#w-photos"));
    $$("[data-remove]").forEach((b) => b.addEventListener("click", () => {
      draft.media.splice(Number(b.dataset.remove), 1);
      drawPhotos();
    }));
    if ($("#w-add-photo")) $("#w-add-photo").hidden = draft.media.length >= 10;
  };
  drawPhotos();
  $("#photo-file")?.addEventListener("change", async (e) => {
    const files = [...e.target.files].slice(0, 10 - draft.media.length);
    e.target.value = "";
    const note = $("#w-photo-note");
    const post = $("#post");
    post.disabled = true;
    try {
      for (const [i, file] of files.entries()) {
        note.textContent = `Keeping photo ${i + 1} of ${files.length} on your node…`;
        const small = await shrink(file);
        if (small.bytes.length > PHOTO_MAX) throw new Error(`${file.name} is too large even made smaller`);
        const volume = mediaVolume(sdk, small.type, small.bytes);
        await operator(settings.ownNode, settings.ownCookie).pin(volume);
        local.set(volume.cid, URL.createObjectURL(new Blob([small.bytes], { type: small.type })));
        draft.media.push(volume.cid);
        drawPhotos();
      }
      note.textContent = `Your node, ${hostOf(settings.ownNode)}, keeps them. People see them while it's online.`;
      note.classList.remove("bad");
    } catch (error) {
      note.textContent = `Your node didn't keep it: ${error.message}. Check its address and cookie in Settings, and that it allows this site (rpcAllowedOrigins).`;
      note.classList.add("bad");
    } finally {
      post.disabled = !draft.stars;
    }
  });
  const statusEl = $("#w-status");
  const run = async (build, what, after) => {
    const buttons = $$("#post, #delete");
    buttons.forEach((b) => (b.disabled = true));
    statusEl.classList.remove("bad");
    try {
      await send(build, { status: (t) => (statusEl.textContent = t), what, as: drawnFor });
      drafts.delete(key);
      after();
    } catch (error) {
      buttons.forEach((b) => (b.disabled = false));
      $("#post").disabled = !draft.stars;
      if (error instanceof NoWallet) {
        statusEl.textContent = "";
        return needWallet("Posting a review needs Selfhold.");
      }
      if (error instanceof Redraw) {
        // What they typed stays; the form is drawn again as an edit of the review they have.
        redrawNote = error.message;
        return render();
      }
      statusEl.textContent = error instanceof Said ? error.message : walletMessage(error);
      if (!(error instanceof Cancelled)) statusEl.classList.add("bad");
    }
  };
  $("#post").addEventListener("click", () => {
    if (!draft.stars) return;
    const value = { stars: draft.stars, body: draft.body.trim() };
    const mediaCIDs = [...draft.media];
    run(async (a) => {
      // The newest state: an edit of the review the account has now.
      const now = await state({ fresh: true });
      const existing = await read.reviewOf(now, a, p);
      // A review this form wasn't made from (it was drawn before connecting)
      // is never overwritten unseen.
      if (existing?.id !== mine?.id) throw new Redraw("You've already reviewed this place. What you wrote is kept here: save it to replace that review.");
      return existing
        ? write.review(a, existing.id, p, value, { edited: Date.now(), mediaCIDs, before: await read.mediaSlots(now, a, existing.id) })
        : write.review(a, write.newId(), p, value, { mediaCIDs });
    }, "Your review", () => {
      toast(mine ? "Saved. It shows as edited." : "Your review is up. It shows as waiting until its block lands.");
      location.hash = placeHref(p);
    });
  });
  $("#delete")?.addEventListener("click", () => {
    run(async (a) => {
      const now = await state({ fresh: true });
      const existing = await read.reviewOf(now, a, p);
      return existing ? write.review(a, existing.id, p, undefined, { before: await read.mediaSlots(now, a, existing.id) }) : [];
    }, "Deleting your review", () => {
      toast("Your review is deleted.");
      location.hash = placeHref(p);
    });
  });
}

// ------------------------------------------------------------- Add place

const newPlace = { name: "", category: "", address: "", url: "", phone: "", hours: "" };
const editDraft = { key: "" };
async function addView(panel, route, stale, arrived) {
  ensureMap();
  markers?.clearLayers();
  // Editing: only a place's author can change its details.
  const editing = route.view === "edit" ? route.place : null;
  const drawnFor = connected;
  let before = null;
  if (editing) {
    const s = await state();
    before = await read.place(s, editing.author, editing.id);
    if (stale()) return;
    if (!before || connected !== before.author) {
      paint(panel, stale, `<div class="top"><a class="back" href="${before ? placeHref(before) : "#/"}">${backIcon}Back</a></div><div class="empty"><p>Only the person who added a place can edit its details.</p>${connected ? "" : connectButton()}</div>`);
      return wireConnect(panel);
    }
    if (arrived || editDraft.key !== `${before.author}/${before.id}`) {
      Object.assign(editDraft, { key: `${before.author}/${before.id}`, name: before.name, category: before.category ?? "Other", address: before.address ?? "", url: before.url ?? "", phone: before.phone ?? "", hours: before.hours ?? "" });
      map.setView([before.lat, before.lon], 18);
    }
  }
  const form = editing ? editDraft : newPlace;
  if (!$("#add-form", panel)) {
    panel.innerHTML = `
      <div class="top"><a class="back" href="${editing ? placeHref(editing) : "#/"}">${backIcon}Cancel</a></div>
      <div class="form" id="add-form">
        <h1 class="title" style="font-size:22px">${editing ? "Edit place" : "Add a place"}</h1>
        <p class="small muted" style="margin:0">Move the map so the pin sits on the door.</p>
        <label class="field">Name<input id="a-name" type="text" maxlength="200" autocomplete="off" value="${esc(form.name)}"></label>
        <div id="a-matches"></div>
        <div class="field" style="gap:8px"><span id="cat-label">Category</span><div class="chips wrapping" role="radiogroup" aria-labelledby="cat-label">${CATEGORIES.map((c) => `<button type="button" class="chip" role="radio" aria-checked="${form.category === c}" data-cat="${c}">${c}</button>`).join("")}</div></div>
        <details><summary>More details (optional)</summary>
          <div class="form" style="padding:12px 0 0">
            <label class="field">Address<input id="a-address" maxlength="300" value="${esc(form.address)}"></label>
            <label class="field">Website<input id="a-url" type="url" maxlength="300" placeholder="https://" value="${esc(form.url)}"></label>
            <label class="field">Phone<input id="a-phone" type="tel" maxlength="40" value="${esc(form.phone)}"></label>
            <label class="field">Hours<input id="a-hours" maxlength="200" placeholder="Mon–Fri 8–6" value="${esc(form.hours)}"></label>
          </div>
        </details>
        <p class="small muted" style="margin:0">${editing ? "Moving the pin moves the place. Its reviews stay with it." : "Only you can edit this place's details. Anyone can review it."}</p>
        <p class="status" id="a-status" role="status"></p>
        <button type="button" class="btn wide" id="a-add" disabled>${editing ? "Save changes" : "Add place"}</button>
      </div>`;
    for (const f of ["name", "address", "url", "phone", "hours"]) {
      $(`#a-${f}`, panel).addEventListener("input", (e) => {
        form[f] = e.target.value;
        if (f === "name") checkNear();
        ready();
      });
    }
    $$("[data-cat]", panel).forEach((b) => b.addEventListener("click", () => {
      form.category = b.dataset.cat;
      $$("[data-cat]", panel).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      ready();
    }));
    $("#a-add", panel).addEventListener("click", add);
  }
  if (!$(".crosshair")) {
    const pin = document.createElement("div");
    pin.className = "crosshair";
    pin.innerHTML = `<svg width="34" height="44" viewBox="0 0 24 32" aria-hidden="true"><path d="M12 1C6 1 1.5 5.5 1.5 11.2 1.5 19 12 31 12 31s10.5-12 10.5-19.8C22.5 5.5 18 1 12 1z" fill="var(--accent)"/><circle cx="12" cy="11" r="4" fill="#fff"/></svg>`;
    $("#map").append(pin);
  }
  let near = [];
  const ready = () => {
    const ok = form.name.trim() && form.category;
    $("#a-add").disabled = !ok;
    if (!editing) $("#a-add").textContent = near.some((q) => sameName(q.name, form.name)) ? "No, add a new place" : "Add place";
  };
  const checkNear = () => {
    const box = $("#a-matches");
    if (!box) return;
    const name = form.name.trim();
    const likely = editing ? [] : near.filter((q) => !name || sameName(q.name, name));
    box.innerHTML = name && likely.length
      ? `<section class="matches" aria-label="Possible matches"><h2>Is it one of these?</h2>${likely.map((q) => `<a href="${placeHref(q)}"><span><b>${esc(q.name)}</b><br><span class="small muted">${metres(q.dist)} · ${esc(q.category ?? "Place")}</span></span><span aria-hidden="true">›</span></a>`).join("")}</section>`
      : "";
    ready();
  };
  // Places within 50 m of the pin, as the map moves.
  let looks = 0;
  const look = async () => {
    const mine = ++looks;
    const c = map.getCenter();
    const point = { lat: c.lat, lon: wrapLon(c.lng) };
    const s = await state();
    const found = await read.placesIn(s, geo.around(point, 50));
    if (stale() || mine !== looks) return;
    near = found.map((q) => ({ ...q, dist: geo.distance(q, point) })).filter((q) => q.dist <= 50).sort((a, b) => a.dist - b.dist);
    showPins(editing ? near.filter((q) => !(q.author === editing.author && q.id === editing.id)) : near);
    checkNear();
  };
  onMapMoved = () => look().catch(() => {});
  async function add() {
    const c = map.getCenter();
    const value = {
      name: form.name.trim(),
      lat: Math.round(c.lat * 1e6) / 1e6,
      lon: Math.round(c.lng * 1e6) / 1e6,
      category: form.category,
      address: form.address.trim(),
      url: safeLink(form.url.trim()) ? form.url.trim() : "",
      phone: form.phone.trim(),
      hours: form.hours.trim(),
    };
    if (form.url.trim() && !value.url) {
      $("#a-status").textContent = "The website must start with https:// or http://.";
      $("#a-status").classList.add("bad");
      return;
    }
    const pid = editing ? editing.id : write.newId();
    const button = $("#a-add");
    button.disabled = true;
    $("#a-status").classList.remove("bad");
    try {
      let author;
      await send(async (a) => {
        author = a;
        // An edit moves the listing from where the place stands now.
        return write.place(a, pid, value, editing ? await read.place(await state({ fresh: true }), a, pid) : undefined);
      }, { status: (t) => ($("#a-status").textContent = t), what: editing ? "Your changes" : "Your place", as: drawnFor });
      Object.assign(form, { name: "", category: "", address: "", url: "", phone: "", hours: "" });
      if (editing) {
        editDraft.key = "";
        toast("Saved.");
        location.hash = placeHref({ author, id: pid });
        return;
      }
      toast("Added. Now say what you thought of it.");
      location.hash = `${placeHref({ author, id: pid })}/review`;
    } catch (error) {
      button.disabled = false;
      if (error instanceof NoWallet) {
        $("#a-status").textContent = "";
        return needWallet("Adding a place needs Selfhold.");
      }
      $("#a-status").textContent = error instanceof Said ? error.message : walletMessage(error);
      if (!(error instanceof Cancelled)) $("#a-status").classList.add("bad");
    }
  }
  await look();
}

// -------------------------------------------------------------- Following

async function following(panel, route, stale) {
  if (!connected) {
    return paint(panel, stale, `<h1 class="title wrap" style="padding-bottom:0">Following</h1>
      <div class="empty"><p>Follow people whose taste you trust, and their reviews show here and count first on every place.</p>${connectButton()}</div>`) && wireConnect(panel);
  }
  panel.innerHTML ||= `<p class="skeleton">Loading…</p>`;
  const s = await state();
  const who = await readerOf(s);
  const [mineAll, feedLists] = await Promise.all([read.by(s, who.address), Promise.all([...who.follows].map((b) => read.by(s, b)))]);
  const feed = feedLists.flatMap((x) => x.reviews).sort((a, b) => b.time - a.time).slice(0, 60);
  const placesById = new Map();
  await Promise.all(feed.map(async (r) => {
    const k = `${r.on.author}/${r.on.id}`;
    if (!placesById.has(k)) placesById.set(k, await read.place(s, r.on.author, r.on.id));
  }));
  const suggestions = await trust.ratedLikeYou(mineAll.reviews, (on) => read.reviews(s, on), { skip: new Set([who.address, ...who.follows]) });
  if (stale()) return;
  learnNames([...feed.map((r) => r.author), ...suggestions.map((x) => x.author)]);
  const html = `
    <h1 class="title wrap" style="padding-bottom:0">Following</h1>
    <p class="muted" style="margin:0;padding:0 16px">${who.follows.size ? `Newest reviews from the ${plural(who.follows.size, "person", "people")} you follow` : "You don't follow anyone yet."}</p>
    <section aria-labelledby="rly" style="margin-top:12px">
      <h2 id="rly" style="font-size:16px;padding:0 16px">Rated like you</h2>
      ${suggestions.length
        ? `<p class="small muted" style="margin:2px 0 0;padding:0 16px">Their stars were within one of yours on places you both reviewed</p>
           <div class="cards">${suggestions.map((x) => `<div class="card"><a href="${userHref(x.author)}">${avatarTag(x.author)}${nameTag(x.author)}</a><span class="small muted">${x.agree} of ${x.common} places in common</span><button type="button" class="btn small" data-follow="${esc(x.author)}">Follow</button></div>`).join("")}</div>`
        : `<p class="small muted" style="margin:2px 0 0;padding:0 16px">${mineAll.reviews.length ? "No one has reviewed enough of the same places as you yet." : "Review a few places, and people whose stars match yours show up here."}</p>`}
    </section>
    <section aria-label="Recent reviews" style="margin-top:12px">
      ${feed.length ? feed.map((r) => {
        const p = placesById.get(`${r.on.author}/${r.on.id}`);
        if (!p) return "";
        return `<article class="feed-item">
          <div style="display:flex;justify-content:space-between;gap:8px"><a href="${userHref(r.author)}" style="font-weight:700;color:var(--ink);text-decoration:none">${nameTag(r.author)}</a><span class="small muted">${when(r.time)}</span></div>
          <a class="place" href="${placeHref(p)}"><span class="tile" aria-hidden="true">${esc([...p.name][0]?.toUpperCase() ?? "?")}</span><span><b>${esc(p.name)}</b><br><span class="small muted">${esc(p.category ?? "Place")}</span></span></a>
          <div style="margin-top:8px">${stars(r.stars)}</div>
          ${r.body ? `<p class="rv-body">${esc(r.body)}</p>` : ""}
        </article>`;
      }).join("") : who.follows.size ? `<div class="empty"><p>The people you follow haven't reviewed anything yet.</p></div>` : ""}
    </section>`;
  if (!paint(panel, stale, html)) return;
  $$("[data-follow]", panel).forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await send((a) => write.follow(a, b.dataset.follow), { what: "Following", as: who.address });
    } catch (error) {
      b.disabled = false;
      failed(error, "Following someone");
    }
  }));
}

// -------------------------------------------------------------- Reviewer

async function reviewer(panel, route, stale) {
  const a = route.address;
  if (!/^[a-z0-9]{20,}$/.test(a)) return paint(panel, stale, `<div class="empty"><p>That isn't an account address.</p></div>`);
  panel.innerHTML ||= `<p class="skeleton">Loading…</p>`;
  const s = await state();
  const who = await readerOf(s);
  const [theirs, card, handle] = await Promise.all([read.by(s, a), read.card(s, a), moniker.handleOf(a).catch(() => undefined)]);
  const placesOf = await Promise.all(theirs.reviews.map((r) => read.place(s, r.on.author, r.on.id)));
  if (stale()) return;
  known.set(a, { card, handle });
  asked.set(a, Date.now());
  const about = [
    handle && `<a href="${esc(moniker.pageURL(handle))}" target="_blank" rel="noopener">@${esc(handle)} on Moniker</a>`,
    card?.bio && esc(card.bio),
  ].filter(Boolean).join(" · ");
  const h = trust.history(theirs.reviews);
  const rows = theirs.reviews.map((r, i) => [r, placesOf[i]]).filter(([, p]) => p).sort(([x], [y]) => y.time - x.time);
  const max = Math.max(1, ...h.spread);
  const isMe = who.address === a;
  const follows = who.follows.has(a);
  const usesLabels = who.labelers.has(a);
  const followPending = isPending(`user/${who.address}/follow/${a}`);
  const labelsPending = isPending(`user/${who.address}/follow-labels/${a}`);
  const html = `
    <div class="top"><button type="button" class="back" data-back>${backIcon}Back</button></div>
    <header class="profile">${avatarTag(a)}<div><h1 class="title" style="font-size:24px">${nameTag(a)}</h1>${about ? `<div class="small muted">${about}</div>` : ""}</div></header>
    ${isMe ? "" : `<div class="two">
      <button type="button" class="btn${follows ? " quiet" : ""}" data-toggle-follow aria-pressed="${follows}"${followPending ? " disabled" : ""}>${followPending ? "Saving…" : follows ? "Following" : "Follow"}</button>
      <button type="button" class="btn${usesLabels ? " quiet" : ""}" data-toggle-labels aria-pressed="${usesLabels}"${labelsPending ? " disabled" : ""}>${labelsPending ? "Saving…" : usesLabels ? "Using their labels" : "Use their labels"}</button>
    </div>`}
    <section class="history" aria-label="History">
      <div style="display:flex;flex-direction:column;gap:4px;font-size:14px">
        <div><span class="big">${h.count}</span> ${h.count === 1 ? "review" : "reviews"}</div>
        <div class="muted">${h.since ? `Reviewing since ${monthYear(h.since)}` : "No reviews yet"}</div>
        <div class="muted">${plural(theirs.places.length, "place")} added · ${plural(theirs.replies.filter((x) => x.labels.length).length, "label")}</div>
      </div>
      <div class="spread" role="img" aria-label="Their stars: ${h.spread.map((n, i) => `${n} ${i + 1}-star`).join(", ")}">${h.spread.map((n, i) => `<div><span style="height:${Math.round((n / max) * 46) + 2}px"></span>${i + 1}</div>`).join("")}</div>
    </section>
    <h2 class="section-title" style="font-size:16px">Reviews</h2>
    ${rows.length ? rows.map(([r, p]) => `<a class="row" href="${placeHref(p)}"><span class="main"><span class="name">${esc(p.name)}</span><span class="sub">${ago(r.time)}${r.body ? ` · ${esc(r.body.slice(0, 80))}${r.body.length > 80 ? "…" : ""}` : ""}</span></span><span class="rating">${r.stars} ★</span></a>`).join("") : `<div class="empty"><p>No reviews yet.</p></div>`}`;
  if (!paint(panel, stale, html)) return;
  showNames([a]);
  $("[data-back]", panel).addEventListener("click", () => (history.length > 1 ? history.back() : (location.hash = "#/following")));
  showPins(rows.map(([, p]) => p), { fit: true });
  const toggle = (attr, make, on, what) => $(`[${attr}]`, panel)?.addEventListener("click", async (e) => {
    const button = e.currentTarget; // before any await: it is null after
    button.disabled = true;
    try {
      await send((me) => make(me, a, !on), { what, as: who.address });
    } catch (error) {
      button.disabled = false;
      failed(error, what);
    }
  });
  toggle("data-toggle-follow", write.follow, follows, "Following");
  toggle("data-toggle-labels", write.followLabels, usesLabels, "Using their labels");
}

// ------------------------------------------------------------------- You

const connectButton = () => wallet()
  ? `<button type="button" class="btn" data-connect>Connect Selfhold</button>`
  : `<button type="button" class="btn" data-get-wallet>Add Selfhold to write</button>`;
function wireConnect(panel) {
  $("[data-connect]", panel)?.addEventListener("click", async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await connectWallet();
    } catch (error) {
      button.disabled = false;
      toast(walletMessage(error), { bad: true });
    }
  });
  $("[data-get-wallet]", panel)?.addEventListener("click", () => needWallet(""));
}

async function you(panel, route, stale) {
  if (!connected) {
    return paint(panel, stale, `<h1 class="title wrap" style="padding-bottom:0">You</h1>
      <div class="empty"><p>Reading Rave needs nothing. To review places, follow people or choose labelers, connect your Selfhold wallet: it holds your key and asks you before every write.</p>${connectButton()}</div>
      <nav aria-label="Settings"><a class="nav-row" href="#/settings"><span>Settings</span><span class="muted">${esc(hostOf(settings.node))} ›</span></a></nav>`) && wireConnect(panel);
  }
  panel.innerHTML ||= `<p class="skeleton">Loading…</p>`;
  const s = await state();
  const who = await readerOf(s);
  const [mine, carded] = await Promise.all([read.by(s, who.address), hasCard(who.address)]);
  if (stale()) return;
  learnNames([...who.follows, ...who.labelers]);
  const labelNames = ["paid", "fake", "spam", "closed", "same-as"];
  const waiting = handleWaits.get(who.address);
  const handleLine = waiting !== undefined && who.handle !== (waiting || undefined)
    ? `${waiting ? `@${esc(waiting)}` : "No handle"} · <span class="pending-note">Waiting for a block…</span>`
    : who.handle
      ? `<a href="${esc(moniker.pageURL(who.handle))}" target="_blank" rel="noopener">@${esc(who.handle)} on Moniker</a> · <button type="button" class="linkish small" data-handle>Change</button> · <button type="button" class="linkish small" data-stop-handle>Stop showing it</button>`
      : `No handle yet · <button type="button" class="linkish small" data-handle>Use a handle</button>`;
  const html = `
    <header class="profile" style="padding-top:20px">${avatarTag(who.address)}<div><h1 class="title" style="font-size:24px">${nameTag(who.address)}</h1>
      ${who.card?.bio ? `<div class="small muted">${esc(who.card.bio)}</div>` : ""}
      <div class="small muted" data-handle-line>${handleLine}</div></div></header>
    ${carded
      ? `<div class="actions" style="padding:8px 16px 0"><button type="button" class="btn quiet small" data-edit-card>Edit your card</button></div>`
      : `<div class="notice" style="margin:12px 16px 0">People see your reviews under your Rave card: a name, a few words, a photo if you like. Your account itself is never shown. <div class="actions" style="padding:8px 0 0"><button type="button" class="btn small" data-edit-card>Make your card</button></div></div>`}
    <nav aria-label="Your things" style="margin-top:16px">
      <a class="nav-row" href="${userHref(who.address)}"><span>Your reviews</span><span class="muted">${mine.reviews.length} ›</span></a>
      <a class="nav-row" href="#/following"><span>People you follow</span><span class="muted">${who.follows.size} ›</span></a>
    </nav>
    <section aria-labelledby="labels-title">
      <h2 class="section-title" id="labels-title">Labels</h2>
      <p class="small muted" style="margin:0;padding:0 16px">Labels are replies from accounts you chose. Nothing is ever deleted; you decide what each label does on your screen. To use someone's labels, open their page and tap Use their labels.</p>
      ${who.labelers.size ? [...who.labelers].map((l) => `<div class="labeler"><div class="head"><a href="${userHref(l)}" style="font-weight:700;color:var(--ink);text-decoration:none">${nameTag(l)}</a></div>
        ${labelNames.map((name) => `<div class="line"><span>${esc(labelText(name))}</span><div class="seg" role="radiogroup" aria-label="${esc(labelText(name))} from ${esc(nameOf(l, known.get(l)))}">${["show", "warn", "hide"].map((m) => `<button type="button" role="radio" aria-checked="${modeOf(l, name) === m}" data-mode="${esc(`${l}/${name}`)}" data-value="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}</div></div>`).join("")}
      </div>`).join("") : `<p class="small muted" style="padding:8px 16px 0;margin:0">You don't use anyone's labels yet, so you see every review as written.</p>`}
    </section>
    <nav aria-label="Settings" style="margin:20px 0 24px">
      <a class="nav-row" href="#/settings"><span>Settings</span><span class="muted">${esc(hostOf(settings.node))} ›</span></a>
      <button type="button" class="nav-row" data-disconnect style="width:100%;background:none;border-left:0;border-right:0;border-bottom:0;cursor:pointer;font-size:16px"><span>Disconnect this site</span><span></span></button>
    </nav>`;
  if (!paint(panel, stale, html)) return;
  $$("[data-mode]", panel).forEach((b) => b.addEventListener("click", () => {
    store.set("modes", { ...modes(), [b.dataset.mode]: b.dataset.value });
    $$(`[data-mode="${CSS.escape(b.dataset.mode)}"]`, panel).forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  }));
  $("[data-disconnect]", panel).addEventListener("click", async () => {
    await wallet()?.disconnect().catch(() => {});
    setConnected(null);
  });
  showNames([who.address, ...who.follows, ...who.labelers]);
  $("[data-edit-card]", panel)?.addEventListener("click", async (e) => {
    const button = e.currentTarget; // before any await: it is null after
    const card = await askCard({ card: who.card });
    if (!card) return;
    button.disabled = true;
    try {
      await send(() => [], { what: "Your card", card, as: who.address });
      toast("Your card is saved. It shows as waiting until its block lands.");
    } catch (error) {
      button.disabled = false;
      failed(error, "Saving your card");
    }
  });
  $("[data-handle]", panel)?.addEventListener("click", () => openHandle(who.address));
  $("[data-stop-handle]", panel)?.addEventListener("click", async (e) => {
    const button = e.currentTarget; // before any await: it is null after
    button.disabled = true;
    try {
      const writer = await within(15_000, monikerWriter());
      await viaWallet(() => writer.stopShowing({ wallet: wallet() }));
      toast("Your handle stops showing once its block lands.");
      waitForHandle(who.address, "");
    } catch (error) {
      button.disabled = false;
      toast(walletMessage(error), { bad: true });
    }
  });
}

// A handle the reader asked to show ("" for none), until Moniker says so.
const handleWaits = new Map(); // address -> handle

/** `promise`, or a rejection after `ms`: a read that hangs doesn't hold a dialog forever. */
const within = (ms, promise) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("The node didn't answer in time. Try again.")), ms))]);

/** Polls until Moniker verifies `handle` for `account` ("" for none), then draws again. */
async function waitForHandle(account, handle) {
  handleWaits.set(account, handle);
  render();
  const started = Date.now();
  while (Date.now() - started < 15 * 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (((await moniker.handleOf(account).catch(() => null)) ?? "") === handle) break;
  }
  if (handleWaits.get(account) === handle) handleWaits.delete(account);
  asked.delete(account);
  reader = null;
  render();
}

/** The dialog that shows one of the account's Moniker names, or claims a free one and shows it. */
async function openHandle(account) {
  const dialog = $("#handle-dialog");
  const list = $("#hd-names");
  $("#hd-new").value = "";
  $("#hd-status").textContent = "";
  $("#hd-status").classList.remove("bad");
  $$("input, button", dialog).forEach((f) => (f.disabled = false));
  list.innerHTML = `<p class="small muted" style="margin:0">Looking up your names…</p>`;
  dialog.showModal();
  // Closing the dialog stops whatever it is waiting for, short of the wallet.
  let open = true;
  dialog.addEventListener("close", () => (open = false), { once: true });
  let names = [];
  try {
    names = await within(15_000, moniker.names(account));
  } catch {
    /* none listed: a new one can still be claimed */
  }
  if (!open) return;
  list.innerHTML = names.length
    ? `<fieldset style="border:0;padding:0;margin:0"><legend class="small" style="font-weight:600">Your names on Moniker</legend>${names.map((n, i) => `<label style="display:flex;gap:8px;align-items:center;min-height:40px"><input type="radio" name="handle" value="${esc(n.handle)}"${i === 0 ? " checked" : ""}> @${esc(n.handle)}</label>`).join("")}</fieldset>`
    : `<p class="small muted" style="margin:0">You have no names on Moniker yet. Claim a free one below.</p>`;
  $("#hd-send").onclick = async () => {
    const typed = $("#hd-new").value.trim().replace(/^@/, "");
    const h = typed || $("input[name=handle]:checked", dialog)?.value;
    const status = $("#hd-status");
    status.classList.remove("bad");
    const say = (text) => {
      status.textContent = text;
      status.classList.add("bad");
    };
    if (!h) return say("Pick one of your names, or type a free one.");
    if (!isHandle(h)) return say("A handle is lowercase letters, digits and _.");
    // Fields lock while it works; Cancel stays open until the wallet is asked.
    const lock = (on, { asking = false } = {}) => {
      dialog.toggleAttribute("data-busy", on && asking);
      $$("input, button:not([data-close])", dialog).forEach((f) => (f.disabled = on));
      $("[data-close]", dialog).disabled = on && asking;
    };
    lock(true);
    try {
      const writer = await within(15_000, monikerWriter());
      const entry = await within(15_000, writer.name(h));
      if (!open) return;
      if (entry && entry.owner !== account && entry.pointer !== account) {
        lock(false);
        return say(`@${h} is someone else's${entry.price !== undefined ? ": it's for sale on Moniker" : ""}.`);
      }
      lock(true, { asking: true });
      if (!entry) {
        // A free name: claimed, pointed at you, then shown.
        status.textContent = "Approve two in Selfhold: Moniker gives you the name, then shows it.";
        await viaWallet(async () => {
          await writer.claim(h, { point: true }, { wallet: wallet() });
          // Shown once the claim is in Moniker's state.
          for (let tries = 0; !(await within(10_000, writer.name(h)).catch(() => undefined)); tries++) {
            if (tries >= 60) throw new Error(`@${h} isn't in a block yet. Use it again in a moment.`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          await writer.showName(h, { wallet: wallet() });
        });
      } else {
        status.textContent = "Approve it in Selfhold: Moniker shows the name for you.";
        await viaWallet(() => writer.showName(h, { wallet: wallet() }));
      }
      lock(false);
      dialog.close();
      toast(`You show @${h} once Moniker's block lands.`);
      waitForHandle(account, h);
    } catch (error) {
      lock(false);
      say(walletMessage(error));
    }
  };
}

/**
 * Asks for the reader's Rave card: `{ name, bio?, photo? }`, or null if they
 * close the dialog. `card` fills it in to edit; `why` says what it is for.
 */
function askCard({ card, why = "" } = {}) {
  const dialog = $("#card-dialog");
  $("#cd-title").textContent = card ? "Edit your card" : "Make your Rave card";
  $("#cd-why").textContent = why;
  $("#cd-why").hidden = !why;
  $("#cd-name").value = card?.name ?? "";
  $("#cd-bio").value = card?.bio ?? "";
  $("#cd-status").textContent = "";
  $("#cd-status").classList.remove("bad");
  $("#cd-send").disabled = false;
  let photo = card?.photo;
  const box = $("#cd-photo");
  box.innerHTML = settings.ownNode && settings.ownCookie
    ? `<label class="btn quiet small" style="align-self:flex-start">${photo ? "Change photo" : "Add a photo"}<input id="cd-file" type="file" accept="image/png,image/jpeg,image/webp" class="sr"></label><span class="small muted" id="cd-photo-note">Your node, ${esc(hostOf(settings.ownNode))}, keeps it.</span>`
    : `<span class="small muted">To add a photo, <a href="#/settings">add your node in Settings</a>: it keeps your photos.</span>`;
  $("#cd-file")?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const note = $("#cd-photo-note");
    note.classList.remove("bad");
    note.textContent = "Keeping it on your node…";
    // The card waits for its photo.
    $("#cd-send").disabled = true;
    try {
      const small = await shrink(file);
      if (small.bytes.length > PHOTO_MAX) throw new Error(`${file.name} is too large even made smaller`);
      const volume = mediaVolume(sdk, small.type, small.bytes);
      await within(60_000, operator(settings.ownNode, settings.ownCookie).pin(volume));
      photo = volume.cid;
      note.innerHTML = `<img alt="Your photo" src="${esc(URL.createObjectURL(new Blob([small.bytes], { type: small.type })))}" style="height:48px;width:48px;border-radius:24px;object-fit:cover;vertical-align:middle"> Your node keeps it.`;
    } catch (error) {
      note.textContent = `Your node didn't keep it: ${error.message}.`;
      note.classList.add("bad");
    } finally {
      $("#cd-send").disabled = false;
    }
  });
  dialog.showModal();
  $("#cd-name").focus();
  return new Promise((resolve) => {
    let made = null;
    $("#cd-send").onclick = () => {
      const name = $("#cd-name").value.trim();
      if (!name) {
        $("#cd-status").textContent = "Give your card a name.";
        $("#cd-status").classList.add("bad");
        return;
      }
      made = { name, bio: $("#cd-bio").value.trim() || undefined, photo };
      dialog.close();
    };
    dialog.addEventListener("close", () => resolve(made), { once: true });
  });
}

// --------------------------------------------------------------- Settings

async function settingsView(panel, route, stale) {
  paint(panel, stale, `
    <div class="top"><a class="back" href="#/you">${backIcon}You</a></div>
    <div class="form"><h1 class="title" style="font-size:22px">Settings</h1>
      <p class="small muted" style="margin:0">Rave reads from any node that serves its chain, and checks everything it reads against the chain's own hashes, so a node can refuse to answer but can't change what you see.</p>
      <label class="field">Node<input id="s-node" value="${esc(settings.node)}" inputmode="url"></label>
      <label class="field">Rave chain<input id="s-chain" value="${esc(settings.chain)}"></label>
      <label class="field">Names (Moniker chain)<input id="s-moniker" value="${esc(settings.moniker)}"></label>
      <h2 style="font-size:16px;margin-top:8px">Your node, for photos</h2>
      <p class="small muted" style="margin:0">Photos aren't stored on the chain: your own Lattice node keeps them and serves them to readers. Give its operator address and the cookie it writes at each start (<code>chains/Nexus/.cookie</code>), and let it accept this site (<code>rpcAllowedOrigins</code>: <code>${esc(location.origin)}</code>).</p>
      <label class="field">Operator address<input id="s-own" value="${esc(settings.ownNode)}" placeholder="http://127.0.0.1:8080" inputmode="url"></label>
      <label class="field">Cookie<input id="s-cookie" value="${esc(settings.ownCookie)}" autocomplete="off" spellcheck="false"></label>
      <p class="status" id="s-status" role="status"></p>
      <button type="button" class="btn wide" id="s-save">Save</button>
      <button type="button" class="linkish" id="s-reset" style="align-self:center">Back to the defaults</button>
    </div>`);
  $("#s-save", panel).addEventListener("click", () => {
    const node = nodeAddress($("#s-node").value.trim());
    if (!node) {
      $("#s-status").textContent = "A node address starts with https:// (or http:// on this computer).";
      $("#s-status").classList.add("bad");
      return;
    }
    store.set("node", node);
    store.set("chain", $("#s-chain").value.trim() || DEFAULTS.chain);
    const m = $("#s-moniker").value.trim();
    store.set("monikerChain", m && m !== MONIKER.chain.join("/") ? m : undefined);
    store.set("ownNode", $("#s-own").value.trim().replace(/\/+$/, "") || undefined);
    store.set("ownCookie", $("#s-cookie").value.trim() || undefined);
    location.reload();
  });
  $("#s-reset", panel).addEventListener("click", () => {
    for (const k of ["node", "chain", "monikerChain"]) store.set(k, undefined);
    location.reload();
  });
}

// ------------------------------------------------------------------ boot

$("#getwallet [data-close]")?.addEventListener("click", () => $("#getwallet").close());
window.addEventListener("hashchange", () => render());
// Selfhold may arrive after this page: it says so with an event.
window.addEventListener("lattice#initialized", async () => {
  setConnected((await wallet()?.address().catch(() => null)) ?? null);
  render();
});
(async () => {
  setConnected((await wallet()?.address().catch(() => null)) ?? null);
  render();
})();
