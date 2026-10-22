// A private Rave stack for the UI tests: one Lattice host mining Nexus, a
// Rave chain (chain/) and a Moniker chain (where handles come from), each
// from a fast test spec, with public reads and submits, and a static server
// for the repository so the real app/ page runs against it.
//
// moniker/ holds Moniker's policy module, built in the Moniker repository
// (policy/target/…/moniker_policy.wasm), and its spec with 2-second blocks,
// the moduleCID as Lattice's host-check prints it for that module.
//
//   LATTICE=<lattice-node>/.build/debug/lattice
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const RAVE = ["Nexus", "rave"];
export const MONIKER = ["Nexus", "moniker"];
const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const repo = here("../../");
const ports = { listen: 28401, rpc: 28480, publicRead: 28481, web: 28490 };

const types = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css",
  ".png": "image/png", ".woff2": "font/woff2", ".md": "text/plain", ".svg": "image/svg+xml",
};

/** Serves the repository root, as GitHub Pages does. */
export function serve(port) {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(repo, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!file.startsWith(repo) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function until(label, condition, seconds = 300) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await condition().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function start() {
  const sdk = await import(here("../../app/vendor/lattice-sdk.js"));
  const root = mkdtempSync(`${tmpdir()}/rave-ui-`);
  const lattice = (...args) => execFileSync(process.env.LATTICE, [...args, "--root", root], { encoding: "utf8" });
  const configure = (edit) => {
    const file = `${root}/lattice.json`;
    const topology = JSON.parse(readFileSync(file, "utf8"));
    edit(topology);
    writeFileSync(file, JSON.stringify(topology, null, 2));
  };
  const minerKey = sdk.generatePrivateKey();
  const miner = sdk.accountFromPrivateKey(minerKey);
  lattice("init");
  configure((t) => {
    Object.assign(t, { listen: ports.listen, rpc: ports.rpc, publicRead: ports.publicRead, webSocket: 0, publicSubmit: true });
    // As the trial hosts: any fee is admitted, so writing is free.
    t.minRelayFee = 0;
    // Reads are many (one per trie node): no rate ceilings in the way.
    t.publicReadExpensiveRate = 10000;
    t.publicReadRate = 10000;
    t.publicReadMaxRate = 100000;
    t.peers = [];
    t.mine = { worker: "cpu", workers: 1, batchSize: 100000 };
    // The page may ask this node, as its reader's own, to keep photos.
    t.rpcAllowedOrigins = [`http://127.0.0.1:${ports.web}`];
  });
  lattice("up");
  // Rave's spec with 2-second blocks: the policy's time window follows it.
  const spec = { ...JSON.parse(readFileSync(here("../../chain/spec.json"), "utf8")), targetBlockTime: 2000 };
  writeFileSync(`${root}/rave-test-spec.json`, JSON.stringify(spec));
  lattice("child", "create", RAVE.join("/"), "--spec", `${root}/rave-test-spec.json`, "--policy-module", here("../../chain/policy.wasm"));
  lattice("child", "create", MONIKER.join("/"), "--spec", here("./moniker/spec.json"), "--policy-module", here("./moniker/policy.wasm"));
  configure((t) => {
    t.mine.recipients = { [RAVE.join("/")]: miner.address, [MONIKER.join("/")]: miner.address };
  });
  lattice("mine", "start");
  const node = `http://127.0.0.1:${ports.publicRead}`;
  const balance = async (chain) => {
    const r = await fetch(`${node}/api/state/account/${miner.address}?chainPath=${chain.join("/")}`);
    return r.ok ? BigInt((await r.json()).balance ?? 0) : 0n;
  };
  await until("Rave and Moniker blocks", async () => (await balance(RAVE)) > 1000n && (await balance(MONIKER)) > 1000n);
  const web = await serve(ports.web);
  const info = {
    root, node, cookie: () => readFileSync(`${root}/chains/Nexus/.cookie`, "utf8").trim(), rpc: `http://127.0.0.1:${ports.rpc}`, app: `http://127.0.0.1:${ports.web}/app/`,
    chain: RAVE.join("/"), moniker: MONIKER.join("/"), minerKey: Buffer.from(minerKey).toString("hex"), miner: miner.address,
  };
  return {
    info,
    stop: async () => {
      web.close();
      try { lattice("mine", "stop"); } catch {}
      try { lattice("down"); } catch {}
    },
  };
}
