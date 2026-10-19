// Rave's acceptance tests: the real page (app/) in Chromium with the real
// Selfhold wallet extension, against a private Lattice stack (stack.mjs)
// seeded with the demo data (scripts/seed.mjs). Each test is one thing a
// person does, checked by what the page then shows. Run with node --test; see README.
//
//   LATTICE=<lattice-node>/.build/debug/lattice \
//   LATTICE_WALLET=<lattice-wallet>/dist npm test
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { after, before, test as nodeTest } from "node:test";
import { chromium, expect as baseExpect } from "playwright/test";
import { seed } from "../../scripts/seed.mjs";
import { newAccount, writeAs } from "./helpers.mjs";
import * as write from "../../client/write.mjs";
import { start } from "./stack.mjs";

const built = process.env.LATTICE_WALLET && fileURLToPath(new URL(process.env.LATTICE_WALLET, `file://${process.cwd()}/`));
if (!built) throw new Error("LATTICE_WALLET: the built Selfhold extension (its dist/ directory)");
// Selfhold as installed by someone whose node runs on this machine: allowed
// to reach it (what Chrome's Allow prompt would grant).
const installed = mkdtempSync(`${tmpdir()}/rave-ui-wallet-`);
cpSync(built, installed, { recursive: true });
const manifest = JSON.parse(readFileSync(`${installed}/manifest.json`, "utf8"));
manifest.host_permissions = [...manifest.host_permissions, "http://127.0.0.1/*"];
writeFileSync(`${installed}/manifest.json`, JSON.stringify(manifest));

// Writes wait for a block: generous waits.
const expect = baseExpect.configure({ timeout: 90_000 });

let stack;
let people; // the seeded accounts, by name
let browser; // for visitors without the wallet
before(async () => {
  stack = await start();
  const seeded = await seed(stack.info.node, stack.info.chain, stack.info.moniker);
  people = Object.fromEntries(seeded.map((p) => [p.name, p]));
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await stack?.stop();
});

const MARIGOLD = () => ({ author: people["Dana Okafor"].address, id: "marigold" });
const DUPLICATE = () => ({ author: people["Mo Haddad"].address, id: "marigold2" });
const placeHash = (p) => `#/place/${p.author}/${p.id}`;
const AREA = { lat: 40.7415, lon: -73.9887, zoom: 17 };

/** The page, pointed at the stack, the map at `view`; tiles are not fetched. */
async function prepare(context, view = AREA) {
  await context.route("https://tile.openstreetmap.org/**", (route) => route.fulfill({ status: 204 }));
  await context.addInitScript(({ node, chain, moniker, view }) => {
    if (sessionStorage.getItem("rave-test")) return;
    sessionStorage.setItem("rave-test", "1");
    localStorage.clear();
    localStorage.setItem("rave:node", JSON.stringify(node));
    localStorage.setItem("rave:chain", JSON.stringify(chain));
    localStorage.setItem("rave:monikerChain", JSON.stringify(moniker));
    localStorage.setItem("rave:view", JSON.stringify(view));
  }, { node: stack.info.node, chain: stack.info.chain, moniker: stack.info.moniker, view });
}

/**
 * A browser with Selfhold holding `who`'s key, its node the stack's. Every
 * wallet window is answered once its button wakes: approved, or declined
 * while `context.decline` is set. Answers are recorded.
 */
async function withWallet(who, { view, viewport = { width: 1280, height: 900 } } = {}) {
  const context = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/rave-ui-browser-`), {
    headless: false,
    viewport,
    args: ["--headless=new", `--disable-extensions-except=${installed}`, `--load-extension=${installed}`],
  });
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent("serviceworker")];
  const origin = worker.url().split("/").slice(0, 3).join("/");
  context.answers = [];
  context.notes = [];
  context.on("page", async (opened) => {
    await opened.waitForLoadState().catch(() => {});
    if (!opened.url().includes("/approve/index.html")) return;
    await opened.bringToFront();
    const approve = opened.getByRole("button", { name: /^(Connect|Sign write|Pay .+)$/ });
    const rest = opened.getByRole("button", { name: /^See the rest/ });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await approve.isEnabled().catch(() => false))) {
      if (await rest.isVisible().catch(() => false)) await rest.click().catch(() => {});
      await opened.waitForTimeout(250);
    }
    if (!(await approve.isEnabled().catch(() => false))) {
      context.notes.push((await opened.locator("body").innerText().catch(() => "?")).replace(/\s+/g, " ").slice(0, 400));
      return;
    }
    const label = (await approve.textContent()).trim();
    if (context.decline && label !== "Connect") {
      await opened.getByRole("button", { name: "Decline" }).click();
      context.answers.push(`declined ${label}`);
      return;
    }
    await approve.click();
    context.answers.push(label);
  });
  const setup = await context.newPage();
  await setup.goto(`${origin}/popup/index.html`);
  const created = await setup.evaluate((privHex) => chrome.runtime.sendMessage({ type: "createWallet", password: "rave-test-pass", privHex }), who.keyHex);
  if (!created?.ok) throw new Error(`wallet setup: ${created?.error}`);
  await setup.evaluate(async (url) => {
    const { settings } = await chrome.storage.local.get("settings");
    const endpoints = { ...(settings?.endpoints ?? {}), Nexus: { url, acceptsSubmit: true, source: "user" } };
    await chrome.storage.local.set({ settings: { ...settings, nodeMode: "custom", endpoints } });
  }, stack.info.node);
  await setup.close();
  await prepare(context, view);
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

/** Connects the page to Selfhold from the You tab, as a person would. */
async function connect(page) {
  await page.goto(`${stack.info.app}#/you`);
  await page.getByRole("button", { name: "Connect Selfhold" }).click();
  await expect(page.getByRole("link", { name: /Your reviews/ })).toBeVisible();
}

/** No write of the reader's is still waiting for its block. */
const landed = (page) => expect(page.locator(".pending-note")).toHaveCount(0);

/** A test with its failures explained: what the page showed and its errors. */
const contexts = [];
function test(name, body) {
  nodeTest(name, { timeout: 300_000 }, async () => {
    const pages = [];
    const errors = [];
    const watch = (page) => {
      pages.push(page);
      page.on("pageerror", (error) => errors.push(error.message));
    };
    try {
      await body({ watch });
    } catch (error) {
      const shown = await pages.at(-1)?.locator("#panel").innerText().catch(() => "(no page)");
      const answers = contexts.map((c) => `[${c.answers}] ${c.notes.join(" || ")}`).join(" ; ");
      error.message += `\n--- page:\n${String(shown).slice(0, 900)}\n--- page errors: ${errors.join(" | ") || "none"}\n--- wallet: ${answers}`;
      throw error;
    } finally {
      while (contexts.length) await contexts.pop().close().catch(() => {});
    }
    assert.deepEqual(errors, [], "the page threw");
  });
}
async function visitor(watch, view) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  contexts.push(Object.assign(context, { answers: [], notes: [] }));
  await prepare(context, view);
  const page = await context.newPage();
  watch(page);
  return page;
}
async function person(watch, who, options) {
  const { context, page } = await withWallet(who, options);
  contexts.push(context);
  watch(page);
  return { context, page };
}

// ------------------------------------------------------------- reading

test("a visitor explores the area: places on the list with their ratings, searched and filtered", async ({ watch }) => {
  const page = await visitor(watch);
  await page.goto(stack.info.app);
  const list = page.locator("#explore-list");
  await expect(list.locator("a.row", { hasText: "Marigold Noodle Bar" })).toContainText("(7)");
  await expect(list.locator("a.row", { hasText: "Second Shift Coffee" })).toContainText("4.0");
  await expect(list.locator("a.row", { hasText: "Marigold Noodles" })).toContainText("No reviews");
  await expect(page.locator("#map .pin")).not.toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search this area" }).fill("pho");
  await expect(list.locator("a.row")).toHaveCount(1);
  await expect(list.locator("a.row")).toContainText("Pho Linh");
  await page.getByRole("searchbox", { name: "Search this area" }).fill("");
  await page.getByRole("button", { name: "Coffee" }).click();
  await expect(list.locator("a.row")).toHaveCount(1);
  await expect(list.locator("a.row")).toContainText("Second Shift Coffee");
  await page.getByRole("button", { name: "Bar", exact: true }).click();
  await expect(list.locator("a.row")).toContainText("The Low Tide");
});

test("a visitor reads a place: two scores, recent count, star bars that filter, and orders that say why", async ({ watch }) => {
  const page = await visitor(watch);
  await page.goto(stack.info.app + placeHash(MARIGOLD()));
  await expect(page.locator("h1.title")).toHaveText("Marigold Noodle Bar");
  await expect(page.locator(".score").nth(1)).toContainText("Everyone · 7");
  await expect(page.locator(".score").nth(1).locator("b")).toHaveText("3.7");
  await expect(page.locator(".score").first()).toContainText("Connect to see people you follow");
  await expect(page.locator(".recent")).toHaveText("7 reviews in the last 3 months");
  // Names come from Moniker cards.
  await expect(page.locator("article.review", { hasText: "Hand-pulled noodles" })).toContainText("Dana Okafor");
  // Someone who follows no labelers sees every review as written.
  await expect(page.locator("article.review")).toHaveCount(7);
  await expect(page.locator("[data-hidden-note]")).toHaveCount(0);
  // A bar filters to one star level; pressing it again shows all.
  await page.getByRole("button", { name: /^5 star: 3 reviews/ }).click();
  await expect(page.locator("article.review")).toHaveCount(3);
  await expect(page.getByRole("button", { name: /^5 star/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^5 star/ }).click();
  await expect(page.locator("article.review")).toHaveCount(7);
  // The order line says why reviews are in that order, and changes it.
  await expect(page.locator("#order option:checked")).toHaveText("People you follow first, then newest");
  await page.locator("#order").selectOption({ label: "Lowest rated first" });
  await expect(page.locator("article.review").first().locator(".stars")).toHaveAttribute("aria-label", "1 of 5 stars");
  // Each card carries the reviewer's history; the owner's reply sits under the review it answers.
  await expect(page.locator("article.review", { hasText: "Hand-pulled" }).locator(".hist")).toContainText("6 reviews · since");
  await expect(page.locator("article.review", { hasText: "lukewarm" }).locator(".reply")).toContainText("Owner here.");
});

test("a place with five ratings or fewer shows no star bars", async ({ watch }) => {
  const page = await visitor(watch);
  await page.goto(stack.info.app + `#/place/${people["Mo Haddad"].address}/harborhw`);
  await expect(page.locator("h1.title")).toHaveText("Harbor Hardware");
  await expect(page.locator(".score").nth(1)).toContainText("Everyone · 1");
  await expect(page.locator(".bars")).toHaveCount(0);
});

test("a visitor without Selfhold is told how to write, and keeps their review", async ({ watch }) => {
  const page = await visitor(watch);
  await page.goto(stack.info.app + placeHash(MARIGOLD()) + "/review");
  await page.getByRole("radio", { name: "4 of 5 stars" }).click();
  await expect(page.locator("#star-word")).toHaveText("Good");
  await page.locator("#body").fill("Draft kept.");
  await page.getByRole("button", { name: "Post review" }).click();
  await expect(page.locator("#getwallet")).toBeVisible();
  await expect(page.locator("#getwallet")).toContainText("Posting a review needs Selfhold.");
  await page.getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("#body")).toHaveValue("Draft kept.");
  await expect(page.getByRole("radio", { name: "4 of 5 stars" })).toHaveAttribute("aria-checked", "true");
});

test("a node that can't be reached is said so, with Try again", async ({ watch }) => {
  const page = await visitor(watch);
  await page.goto(`${stack.info.app}?node=${encodeURIComponent("http://127.0.0.1:9")}${placeHash(MARIGOLD())}`);
  await expect(page.locator("#panel [role=alert]")).toContainText(/Couldn't reach|No node serves/);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

// ------------------------------------------------------------- writing

test("a newcomer with no coins connects Selfhold, adds a place and reviews it; both land", async ({ watch }) => {
  const me = newAccount();
  const { context, page } = await person(watch, me, { view: { lat: 40.7395, lon: -73.9921, zoom: 18 } });
  await connect(page);
  await page.goto(`${stack.info.app}#/add`);
  await page.locator("#a-name").fill("Corner Deli");
  await page.getByRole("radio", { name: "Food" }).click();
  await page.locator("summary").click();
  await page.locator("#a-address").fill("1 W 20th St");
  await page.getByRole("button", { name: "Add place" }).click();
  // On to the review, the place shown as waiting until its block lands.
  await expect(page.locator("#star-word")).toHaveText("Tap a star");
  await expect(page.getByRole("button", { name: "Post review" })).toBeDisabled();
  await page.getByRole("radio", { name: "5 of 5 stars" }).click();
  await page.locator("#body").fill("Good sandwiches, open late.");
  await page.getByRole("button", { name: "Post review" }).click();
  await expect(page.locator("h1.title")).toHaveText("Corner Deli");
  await expect(page.locator("article.review")).toContainText("Good sandwiches, open late.");
  await landed(page);
  await expect(page.locator(".score").nth(1)).toContainText("Everyone · 1");
  await expect(page.locator("article.review .rv-meta time")).toBeVisible();
  assert.deepEqual(context.answers, ["Connect", "Sign write", "Sign write"]);
  // It is on the map's list for anyone now.
  const other = await visitor(watch, { lat: 40.7395, lon: -73.9921, zoom: 17 });
  await other.goto(stack.info.app);
  await expect(other.locator("a.row", { hasText: "Corner Deli" })).toContainText("5.0");
});

test("adding a place that's already listed nearby offers the existing ones first", async ({ watch }) => {
  const { page } = await person(watch, newAccount(), { view: { lat: 40.74169, lon: -73.98947, zoom: 18 } });
  await page.goto(`${stack.info.app}#/add`);
  await page.locator("#a-name").fill("Marigold noodle");
  const matches = page.getByRole("region", { name: "Possible matches" });
  await expect(matches).toContainText("Is it one of these?");
  await expect(matches.getByRole("link", { name: /Marigold Noodle Bar/ })).toBeVisible();
  await expect(matches.getByRole("link", { name: /Marigold Noodles/ })).toBeVisible();
  await page.getByRole("radio", { name: "Food" }).click();
  await expect(page.locator("#a-add")).toHaveText("No, add a new place");
  await matches.getByRole("link", { name: /Marigold Noodle Bar/ }).click();
  await expect(page.locator("h1.title")).toHaveText("Marigold Noodle Bar");
});

test("only a place's author can edit its details; moving the pin moves the place", async ({ watch }) => {
  const me = newAccount();
  const at = { lat: 40.7388, lon: -73.9930 };
  await writeAs(stack.info.node, stack.info.chain, me, write.place(me.address, "kiosk", { name: "News Kiosk", category: "Shop", ...at }));
  const { page } = await person(watch, me);
  await connect(page);
  await page.goto(`${stack.info.app}#/place/${me.address}/kiosk`);
  await page.getByRole("link", { name: "Edit details" }).click();
  await expect(page.locator("h1.title")).toHaveText("Edit place");
  await expect(page.locator("#a-name")).toHaveValue("News Kiosk");
  await page.locator("#a-name").fill("Corner News");
  await page.getByRole("radio", { name: "Service" }).click();
  // About 60 m north.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("rave-test-pan", { detail: [0.00055, 0] })));
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator("h1.title")).toHaveText("Corner News");
  await landed(page);
  await expect(page.locator(".place-head")).toContainText("Service");
  // Found where it is now, not where it was.
  const other = await visitor(watch, { lat: at.lat + 0.00055, lon: at.lon, zoom: 19 });
  await other.goto(stack.info.app);
  await expect(other.locator("a.row", { hasText: "Corner News" })).toBeVisible();
  // Someone else sees no Edit details, and the edit page refuses them.
  const stranger = await visitor(watch);
  await stranger.goto(`${stack.info.app}#/place/${me.address}/kiosk`);
  await expect(stranger.locator("h1.title")).toHaveText("Corner News");
  await expect(stranger.getByRole("link", { name: "Edit details" })).toHaveCount(0);
  await stranger.goto(`${stack.info.app}#/place/${me.address}/kiosk/edit`);
  await expect(stranger.locator("#panel")).toContainText("Only the person who added a place can edit its details.");
});

test("a label is text, never markup", async ({ watch }) => {
  const labeller = newAccount();
  const reader = newAccount();
  const ninth = { author: people["Tess Ward"].address, id: "ninth" };
  const target = { author: people["Ari Chen"].address, id: "r-ninth" };
  await writeAs(stack.info.node, stack.info.chain, labeller, write.reply(labeller.address, "evil", target, { body: "", labels: ['<img src=x onerror="window.pwned=1">'] }));
  await writeAs(stack.info.node, stack.info.chain, reader, write.followLabels(reader.address, labeller.address));
  const { page } = await person(watch, reader);
  await connect(page);
  await page.goto(stack.info.app + placeHash(ninth));
  const folded = page.locator("article.review .folded");
  await expect(folded).toContainText('Labelled <img src=x onerror="window.pwned=1">');
  assert.equal(await page.locator("#panel img[src=x]").count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
});

test("a reviewer edits their review (it keeps its date and says Edited), then deletes it", async ({ watch }) => {
  const me = newAccount();
  const { page } = await person(watch, me);
  await connect(page);
  await page.goto(stack.info.app + placeHash(MARIGOLD()) + "/review");
  await page.getByRole("radio", { name: "3 of 5 stars" }).click();
  await page.getByRole("button", { name: "Post review" }).click();
  await expect(page.locator(".score").nth(1)).toContainText("Everyone · 8");
  await landed(page);
  await page.getByRole("link", { name: "Edit your review" }).click();
  await expect(page.getByRole("radio", { name: "3 of 5 stars" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("radio", { name: "1 of 5 stars" }).click();
  await page.locator("#body").fill("Changed my mind.");
  await page.getByRole("button", { name: "Save changes" }).click();
  const mine = page.locator("article.review", { hasText: "Changed my mind." });
  await expect(mine).toBeVisible();
  await landed(page);
  await expect(mine.locator(".rv-meta")).toContainText("Edited");
  await expect(mine.locator(".stars")).toHaveAttribute("aria-label", "1 of 5 stars");
  await expect(mine).toContainText("You");
  await expect(page.locator(".score").nth(1)).toContainText("Everyone · 8");
  await page.getByRole("link", { name: "Edit your review" }).click();
  await page.getByRole("button", { name: "Delete your review" }).click();
  await expect(page.locator(".score").nth(1)).toContainText("Everyone · 7");
  await expect(page.locator("article.review", { hasText: "Changed my mind." })).toHaveCount(0);
  await landed(page);
  await expect(page.getByRole("link", { name: "Write a review" })).toBeVisible();
});

test("a write declined in Selfhold sends nothing and says so", async ({ watch }) => {
  const { context, page } = await person(watch, newAccount());
  await connect(page);
  context.decline = true;
  await page.goto(stack.info.app + placeHash(MARIGOLD()) + "/review");
  await page.getByRole("radio", { name: "2 of 5 stars" }).click();
  await page.getByRole("button", { name: "Post review" }).click();
  await expect(page.locator("#w-status")).toHaveText("You declined it in Selfhold. Nothing was sent.");
  await expect(page.getByRole("button", { name: "Post review" })).toBeEnabled();
  assert.deepEqual(context.answers, ["Connect", "declined Sign write"]);
  await page.goto(stack.info.app + placeHash(MARIGOLD()));
  await expect(page.locator(".score").nth(1)).toContainText("Everyone · 7");
});

test("helpful marks count once per person, and replies sit under the review", async ({ watch }) => {
  const { page } = await person(watch, newAccount());
  await connect(page);
  await page.goto(stack.info.app + placeHash(MARIGOLD()));
  const card = page.locator("article.review", { hasText: "Dan dan noodles" });
  await card.getByRole("button", { name: "Helpful" }).click();
  await landed(page);
  await expect(card.getByRole("button", { name: "Helpful · 1" })).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: "Reply" }).click();
  await page.locator("#rd-body").fill("Agreed on the heat.");
  await page.locator("#rd-send").click();
  await expect(card.locator(".reply", { hasText: "Agreed on the heat." })).toBeVisible();
  await landed(page);
  // Pressing Helpful again takes it back.
  await card.getByRole("button", { name: "Helpful · 1" }).click();
  await landed(page);
  await expect(card.getByRole("button", { name: "Helpful", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("a reviewer whose own node keeps photos adds one, and anyone sees it", async ({ watch }) => {
  const { page } = await person(watch, newAccount());
  await connect(page);
  await page.goto(`${stack.info.app}#/settings`);
  await page.getByLabel("Operator address").fill(stack.info.rpc);
  await page.getByLabel("Cookie").fill(stack.info.cookie());
  await page.getByRole("button", { name: "Save" }).click();
  const bakery = `#/place/${people["Tess Ward"].address}/ninth`;
  await page.goto(stack.info.app + bakery);
  await page.getByRole("link", { name: "Write a review" }).click();
  await page.getByRole("radio", { name: "4 of 5 stars" }).click();
  await page.locator("#body").fill("The rye, sliced.");
  // A picture to attach: a screenshot of part of this page.
  const picture = await page.screenshot({ clip: { x: 0, y: 0, width: 120, height: 80 } });
  await page.locator("#photo-file").setInputFiles({ name: "rye.png", mimeType: "image/png", buffer: picture });
  await expect(page.locator("#w-photos img")).toBeVisible();
  await expect(page.locator("#w-photo-note")).toContainText("keeps them");
  await page.getByRole("button", { name: "Post review" }).click();
  const mine = page.locator("article.review", { hasText: "The rye, sliced." });
  await expect(mine).toBeVisible();
  await landed(page);
  await expect(mine.locator(".photos img")).toBeVisible();
  // Another reader's browser reads it through the node, checked against its CID.
  const other = await visitor(watch);
  await other.goto(stack.info.app + bakery);
  const photo = other.locator("article.review", { hasText: "The rye, sliced." }).locator(".photos img");
  await expect(photo).toBeVisible();
  assert.ok(await photo.evaluate((img) => img.naturalWidth > 0), "the photo decodes");
});

test("without a node of their own, a reviewer is told where photos are kept", async ({ watch }) => {
  const page = await visitor(watch);
  await page.goto(stack.info.app + placeHash(MARIGOLD()) + "/review");
  await expect(page.locator("#w-photos").locator("..")).toContainText("Photos are kept by your own Lattice node, not by Rave.");
  await expect(page.getByRole("link", { name: "Add your node in Settings" })).toBeVisible();
});

// ------------------------------------------------------- choosing whom to trust

test("following someone puts their score first and their reviews in Following", async ({ watch }) => {
  const { page } = await person(watch, newAccount());
  await connect(page);
  await page.goto(`${stack.info.app}#/u/${people["Dana Okafor"].address}`);
  await expect(page.locator("h1.title")).toHaveText("Dana Okafor");
  await expect(page.locator(".history")).toContainText("6 reviews");
  await page.getByRole("button", { name: "Follow", exact: true }).click();
  await expect(page.getByRole("button", { name: "Following" })).toBeVisible();
  await page.goto(stack.info.app + placeHash(MARIGOLD()));
  await expect(page.locator(".score").first()).toContainText("People you follow · 1");
  await expect(page.locator(".score").first().locator("b")).toHaveText("4.0");
  const first = page.locator("article.review").first();
  await expect(first).toContainText("Dana Okafor");
  await expect(first.locator(".badge")).toHaveText("You follow");
  await page.getByRole("link", { name: "Following", exact: true }).click();
  await expect(page.locator(".feed-item")).toHaveCount(6);
  await expect(page.locator(".feed-item", { hasText: "Pho Linh" })).toContainText("The brisket pho, every time.");
});

test("using someone's labels hides and folds what they labelled, and the reader chooses what each label does", async ({ watch }) => {
  const { page } = await person(watch, newAccount());
  await connect(page);
  await page.goto(`${stack.info.app}#/u/${people["Clean Plate"].address}`);
  await page.getByRole("button", { name: "Use their labels" }).click();
  await expect(page.getByRole("button", { name: "Using their labels" })).toBeVisible();
  await page.goto(stack.info.app + placeHash(MARIGOLD()));
  // spam hides; paid warns (folded with a reason and Show).
  await expect(page.locator("article.review")).toHaveCount(6);
  await expect(page.locator("[data-hidden-note]")).toHaveText(/1 hidden by your labelers · Show/);
  const folded = page.locator("article.review .folded");
  await expect(folded).toContainText("Labelled paid for by Clean Plate");
  await folded.getByRole("button", { name: "Show" }).click();
  await expect(page.locator("article.review", { hasText: "Amazing!!!" }).locator(".rv-meta .badge.label")).toContainText("paid for · Clean Plate");
  await page.locator("[data-hidden-note]").getByRole("button", { name: "Show" }).click();
  await expect(page.locator("article.review", { hasText: "Avoid." })).toBeVisible();
  // On You: spam shows, paid hides.
  await page.getByRole("link", { name: "You", exact: true }).click();
  await page.getByRole("radiogroup", { name: "spam from Clean Plate" }).getByRole("radio", { name: "Show" }).click();
  await page.getByRole("radiogroup", { name: "paid for from Clean Plate" }).getByRole("radio", { name: "Hide" }).click();
  await page.goto(stack.info.app + placeHash(MARIGOLD()));
  await expect(page.locator("article.review", { hasText: "Avoid." })).toBeVisible();
  await expect(page.locator("article.review", { hasText: "Amazing!!!" })).toHaveCount(0);
  await expect(page.locator("[data-hidden-note]")).toHaveText(/1 hidden by your labelers/);
});

test("a duplicate listing is shown as such to people who use the labeller's labels, with why", async ({ watch }) => {
  const { page } = await person(watch, newAccount());
  await connect(page);
  await page.goto(`${stack.info.app}#/u/${people["Dana Okafor"].address}`);
  await page.getByRole("button", { name: "Use their labels" }).click();
  await expect(page.getByRole("button", { name: "Using their labels" })).toBeVisible();
  await page.goto(stack.info.app + placeHash(DUPLICATE()));
  const note = page.locator("[data-dup]");
  await expect(note).toContainText("Possibly the same place as Marigold Noodle Bar");
  await note.getByRole("button", { name: "Why?" }).click();
  await expect(note).toContainText("Same restaurant, listed twice.");
  await note.getByRole("link", { name: "Marigold Noodle Bar" }).click();
  await expect(page.locator("h1.title")).toHaveText("Marigold Noodle Bar");
});

test("labelling a place closed is a reply anyone can see, applied for those who use your labels", async ({ watch }) => {
  const labeller = newAccount();
  const { page } = await person(watch, labeller);
  await connect(page);
  await page.goto(stack.info.app + `#/place/${people["Dana Okafor"].address}/lowtide`);
  await page.getByRole("button", { name: "Label…" }).first().click();
  await page.getByRole("radio", { name: "Closed" }).click();
  await page.locator("#ld-body").fill("Shuttered since September.");
  await page.locator("#ld-send").click();
  await expect(page.locator(".reply", { hasText: "Shuttered since September." }).locator(".badge.label")).toHaveText("closed");
  await landed(page);
  // A reader using the labeller's labels sees the warning.
  await writeAs(stack.info.node, stack.info.chain, people["Tess Ward"], write.followLabels(people["Tess Ward"].address, labeller.address));
  const tess = await person(watch, people["Tess Ward"]);
  await connect(tess.page);
  await tess.page.goto(stack.info.app + `#/place/${people["Dana Okafor"].address}/lowtide`);
  await expect(tess.page.locator(".notice", { hasText: "Labelled closed" })).toContainText("Shuttered since September.");
});

test("Following suggests people who rated like you, and following one is a tap", async ({ watch }) => {
  const me = newAccount();
  const { page } = await person(watch, me);
  await connect(page);
  // Two reviews like Dana's: Marigold 4, Pho Linh 5.
  for (const [hash, starsGiven] of [[placeHash(MARIGOLD()), 4], [`#/place/${people["Ari Chen"].address}/pholinh`, 5]]) {
    await page.goto(stack.info.app + hash + "/review");
    await page.getByRole("radio", { name: `${starsGiven} of 5 stars` }).click();
    await page.getByRole("button", { name: "Post review" }).click();
    await expect(page.locator("h1.title")).toBeVisible();
    await landed(page);
  }
  await page.getByRole("link", { name: "Following", exact: true }).click();
  const card = page.locator(".card", { hasText: "Dana Okafor" });
  await expect(card).toContainText("2 of 2 places in common");
  await card.getByRole("button", { name: "Follow" }).click();
  await expect(page.locator(".feed-item").first()).toBeVisible();
  await expect(page.locator(".card", { hasText: "Dana Okafor" })).toHaveCount(0);
});

// ------------------------------------------------------------- the phone

test("on a phone: map above, places below, three tabs, nothing wider than the screen", async ({ watch }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  contexts.push(Object.assign(context, { answers: [], notes: [] }));
  await prepare(context);
  const page = await context.newPage();
  watch(page);
  await page.goto(stack.info.app);
  await expect(page.locator("a.row", { hasText: "Marigold Noodle Bar" })).toBeVisible();
  for (const name of ["Explore", "Following", "You"]) await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  const map = await page.locator("#map").boundingBox();
  const list = await page.locator("#panel").boundingBox();
  assert.ok(map.y < list.y, "the map sits above the list");
  await page.locator("a.row", { hasText: "Marigold Noodle Bar" }).click();
  await expect(page.locator("#map")).toBeHidden();
  await expect(page.locator("h1.title")).toHaveText("Marigold Noodle Bar");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth || document.querySelector("#panel").scrollWidth > document.querySelector("#panel").clientWidth);
  assert.equal(wide, false, "nothing scrolls sideways");
});
