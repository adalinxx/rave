// What the UI tests do outside the page: make keys, and write records the
// way another client would (signed here, sent to the node's public submit).
import { tip, view, volumeLoader } from "../../client/state.mjs";
import * as write from "../../client/write.mjs";

export const sdk = await import(new URL("../../app/vendor/lattice-sdk.js", import.meta.url));

/** A new account: its address and private key (hex). */
export function newAccount() {
  const key = sdk.generatePrivateKey();
  return { address: sdk.accountFromPrivateKey(key).address, keyHex: Buffer.from(key).toString("hex") };
}
const accountOf = (who) => sdk.accountFromPrivateKey(Uint8Array.from(Buffer.from(who.keyHex, "hex")));

async function until(label, condition, seconds = 900) {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    if (await condition().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Records on `chain` at `node`, written by `who`, landed. */
export async function writeAs(node, chain, who, records) {
  const path = chain.split("/");
  const volumes = new sdk.VolumeClient(new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: path }));
  const state = async () => {
    const { generalStateCID } = await tip(sdk, node, path, volumes);
    return view(volumeLoader(volumes, sdk.decodeDagCbor), generalStateCID);
  };
  const actions = await write.changes(await state(), records);
  if (!actions.length) return;
  const account = await (await fetch(`${node}/api/state/account/${who.address}?chainPath=${chain}`)).json().catch(() => ({}));
  const body = write.transaction({ owner: who.address, actions, fee: 0n, nonce: BigInt(account?.nonce ?? 0), chainPath: path });
  const { publicKey, signature } = sdk.signTransactionBody(body, accountOf(who).privateKey);
  // A public node limits how fast it takes submissions: wait and send again.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${node}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sdk.transactionPayload({ [publicKey]: signature }, body)),
    });
    if (r.ok) break;
    if (r.status !== 429 || attempt >= 20) throw new Error(`submit: ${r.status} ${await r.text()}`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * (Number(r.headers.get("retry-after")) || 1 + attempt)));
  }
  await until("records land", async () => {
    const now = await state();
    for (const { key, newValue } of actions) if ((await now.get(key)) !== newValue) return false;
    return true;
  });
}

/** `who`'s Moniker card says `name`. */
export const setName = (node, monikerChain, who, name) =>
  writeAs(node, monikerChain, who, [[`user/${who.address}/profile`, JSON.stringify({ name })]]);
