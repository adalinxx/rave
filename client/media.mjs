// From Moniker (github.com/adalinxx/moniker, client/media.mjs, commit e8c9b9c).
// Media lives outside the chain. A post names it by CID; the bytes are a
// Volume that whoever keeps it holds and serves. The author's client pins the
// Volume on its own node. A reader's client finds the CID in state, reads the
// Volume from peers through its own node, checks it, and pins it if it keeps
// it. The node holds and serves what it is told to; what counts as media, and
// what is acceptable, is the client's business.
//
// One file is one block: DAG-CBOR `{ type, bytes }`, its CID the Volume root.
//
// Browser-safe: base64 through btoa/atob, which Node has too.

const toBase64 = (bytes) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const fromBase64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

/** The Volume for a file, in the shape `POST /pins` takes. */
export function mediaVolume(sdk, type, bytes) {
  const block = sdk.encodeDagCbor({ bytes, type });
  const cid = sdk.cidV1DagCbor(block);
  return { cid, entries: { [cid]: toBase64(block) } };
}

/**
 * The file in a Volume read from `GET /fetch/:cid`, or undefined when it is
 * not media this client accepts: bytes that are not the CID, a shape that is
 * not `{ type, bytes }`, a type `accept` refuses, or more than `maxBytes`.
 */
export function readMedia(sdk, volume, { accept, maxBytes }) {
  const encoded = volume.entries?.[volume.cid];
  if (typeof encoded !== "string") return undefined;
  let block;
  try {
    block = fromBase64(encoded);
  } catch {
    return undefined;
  }
  if (!sdk.verifyCID(volume.cid, block)) return undefined;
  let file;
  try {
    file = sdk.decodeDagCbor(block);
  } catch {
    return undefined;
  }
  if (typeof file?.type !== "string" || !(file.bytes instanceof Uint8Array)) return undefined;
  if (!accept(file.type) || file.bytes.length > maxBytes) return undefined;
  return { type: file.type, bytes: file.bytes };
}

/**
 * A client of a node's loopback operator routes. `cookie` is the content of
 * the cookie file the node writes at every start.
 */
export function operator(rpc, cookie) {
  const headers = { Authorization: `Basic ${toBase64(new TextEncoder().encode(cookie))}` };
  const call = async (method, path, body, { absent } = {}) => {
    const response = await fetch(new URL(path, rpc), {
      method,
      headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
      body: body && JSON.stringify(body),
    });
    if (absent && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  return {
    /** Keeps a Volume: one the node holds, or one given with its entries. */
    pin: (volume) => call("POST", "/pins", volume),
    unpin: (cid) => call("DELETE", `/pins/${cid}`),
    pins: async () => (await call("GET", "/pins")).pins,
    /** A Volume read from peers and not stored; undefined when none serves it. */
    fetch: (cid) => call("GET", `/fetch/${cid}`, undefined, { absent: true }),
  };
}
