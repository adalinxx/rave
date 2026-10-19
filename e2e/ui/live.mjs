// A review through the real Selfhold wallet on the live trial chain, from
// the published page: a new account with no coins connects, rates a place
// and approves the write in the wallet's own window, and the review lands.
// The wallet keeps its default settings, so it finds the trial chain the
// way anyone's would.
//
//   LATTICE_WALLET=<lattice-wallet>/dist node e2e/ui/live.mjs [page URL]
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { newAccount } from "./helpers.mjs";

const PAGE = process.argv[2] ?? "https://adalinxx.github.io/rave/app/";
const me = newAccount();

// The first write on a chain asks to reach the hosts the wallet found for
// it, through Chrome's own prompt, which a headless browser can't answer:
// this copy has that permission already, as it would once a person allowed it.
const wallet = mkdtempSync(`${tmpdir()}/rave-live-wallet-`);
cpSync(process.env.LATTICE_WALLET, wallet, { recursive: true });
const manifest = JSON.parse(readFileSync(`${wallet}/manifest.json`, "utf8"));
manifest.host_permissions = [...manifest.host_permissions, "https://*.fly.dev/*"];
writeFileSync(`${wallet}/manifest.json`, JSON.stringify(manifest));

const browser = await chromium.launchPersistentContext(mkdtempSync(`${tmpdir()}/rave-live-`), {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ["--headless=new", `--disable-extensions-except=${wallet}`, `--load-extension=${wallet}`],
});
const [worker] = browser.serviceWorkers().length ? browser.serviceWorkers() : [await browser.waitForEvent("serviceworker")];
const origin = worker.url().split("/").slice(0, 3).join("/");
const approved = [];
browser.on("page", async (opened) => {
  await opened.waitForLoadState().catch(() => {});
  if (!opened.url().includes("/approve/index.html")) return;
  await opened.bringToFront();
  const approve = opened.getByRole("button", { name: /^(Connect|Sign write|Pay .+)$/ });
  const rest = opened.getByRole("button", { name: /^See the rest/ });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !(await approve.isEnabled().catch(() => false))) {
    if (await rest.isVisible().catch(() => false)) await rest.click().catch(() => {});
    await opened.waitForTimeout(250);
  }
  const label = (await approve.textContent()).trim();
  await approve.click();
  approved.push(label);
});
const setup = await browser.newPage();
await setup.goto(`${origin}/popup/index.html`);
const created = await setup.evaluate((privHex) => chrome.runtime.sendMessage({ type: "createWallet", password: "rave-live-pass", privHex }), me.keyHex);
if (!created?.ok) throw new Error(`wallet setup: ${created?.error}`);
await setup.close();

const page = browser.pages()[0] ?? (await browser.newPage());
page.on("pageerror", (error) => console.error("page error:", error.message));
await page.goto(`${PAGE}#/you`);
await page.getByRole("button", { name: "Connect Selfhold" }).click();
await page.getByRole("link", { name: /Your reviews/ }).waitFor({ timeout: 60_000 });
await page.goto(`${PAGE}#/`);
await page.locator("a.row", { hasText: "Second Shift Coffee" }).click();
await page.getByRole("link", { name: "Write a review" }).click();
await page.getByRole("radio", { name: "4 of 5 stars" }).click();
const words = `Checked live ${new Date().toISOString()}.`;
await page.locator("#body").fill(words);
await page.getByRole("button", { name: "Post review" }).click();
const mine = page.locator("article.review", { hasText: words });
await mine.waitFor({ timeout: 120_000 });
console.log(`sent; waiting for its block (wallet approved [${approved}])`);
await mine.locator(".pending-note").waitFor({ state: "detached", timeout: 15 * 60_000 });
assert.deepEqual(approved, ["Connect", "Sign write"]);
console.log(`landed: ${await mine.locator(".rv-meta").innerText()}`);
await browser.close();
console.log("PASS");
