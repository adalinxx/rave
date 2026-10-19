// Reads the chain's general state the way any client can: from a state root,
// by descending the radix trie one content-addressed node at a time. Every
// node is verified against its CID by the loader, so the answer does not
// depend on trusting the node that served it.
//
// Trie shape (cashew's Merkle dictionary):
//   root  { count, children: [{ key, value: { rawCID } }] }
//   node  { prefix, value?, children: [...] }
// A child is filed under the first character of its prefix; a stored key is
// the concatenation of the prefixes on its path.

/**
 * A loader over the SDK's VolumeClient. A node met inside a Volume already
 * fetched is read from it; anything else is one fetch. Nodes are immutable,
 * so they are kept for the life of the loader.
 */
export function volumeLoader(volumes, decodeDagCbor) {
  const nodes = new Map();
  return (cid, within) => {
    if (!nodes.has(cid)) {
      nodes.set(
        cid,
        (async () => {
          const volume = within?.bytes(cid) ? within : await volumes.get(cid);
          return { node: decodeDagCbor(volume.bytes(cid)), volume };
        })(),
      );
    }
    return nodes.get(cid);
  };
}

/**
 * One transport over many hosts. Content is addressed by CID, so whoever
 * holds it may serve it: each read starts at the next host and moves on from
 * one that lacks the content, refuses, or serves bytes that fail their CID.
 */
export function anyHost(transports) {
  let next = 0;
  return {
    async getVolume(rootCID, signal) {
      const start = next++;
      let failure;
      for (let offset = 0; offset < transports.length; offset++) {
        try {
          const volume = await transports[(start + offset) % transports.length].getVolume(rootCID, signal);
          if (volume) return volume;
        } catch (error) {
          failure = error;
        }
      }
      if (failure) throw failure;
      return null;
    },
  };
}

function childFor(node, rest) {
  const first = String.fromCodePoint(rest.codePointAt(0));
  return node.children.find((child) => child.key === first)?.value.rawCID;
}

/** The value stored under `key`, or undefined. */
export async function get(load, rootCID, key) {
  let { node, volume } = await load(rootCID);
  let rest = key;
  while (rest.length > 0) {
    const cid = childFor(node, rest);
    if (cid === undefined) return undefined;
    ({ node, volume } = await load(cid, volume));
    if (!rest.startsWith(node.prefix)) return undefined;
    rest = rest.slice(node.prefix.length);
  }
  return node.value;
}

/** Every `[key, value]` whose key starts with `prefix`, in key order. */
export async function* list(load, rootCID, prefix = "") {
  let { node, volume } = await load(rootCID);
  let path = "";
  let rest = prefix;
  while (rest.length > 0) {
    const cid = childFor(node, rest);
    if (cid === undefined) return;
    ({ node, volume } = await load(cid, volume));
    if (rest.startsWith(node.prefix)) rest = rest.slice(node.prefix.length);
    else if (node.prefix.startsWith(rest)) rest = "";
    else return;
    path += node.prefix;
  }
  yield* entries(load, node, volume, path);
}

async function* entries(load, node, volume, path) {
  if (node.value !== undefined) yield [path, node.value];
  const children = [...node.children].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Siblings are independent, so fetch them together and yield in order.
  const loaded = children.map((child) => load(child.value.rawCID, volume));
  for (const pending of loaded) {
    const child = await pending;
    yield* entries(load, child.node, child.volume, path + child.node.prefix);
  }
}

/**
 * A node's current tip: the latest block's hash, and the general-state root
 * inside its post state. Only the hash is the node's word; the root is read
 * from the block by CID.
 */
export async function tip(sdk, nodeURL, chainPath, volumes) {
  const url = new URL(`${nodeURL.replace(/\/+$/, "")}/api/block/latest`);
  url.searchParams.set("chainPath", chainPath.join("/"));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`latest block: HTTP ${response.status}`);
  const { hash } = await response.json();
  return atBlock(sdk, volumes, hash);
}

/** The general-state root at block `hash`, read from the block by CID. */
export async function atBlock(sdk, volumes, hash) {
  const block = sdk.decodeCanonicalBlock((await volumes.get(hash)).rootBytes());
  const state = sdk.decodeCanonicalLatticeState((await volumes.get(block.postStateCID)).rootBytes());
  return { hash, generalStateCID: state.generalStateCID };
}

/** The state at one root as `{ get(key), list(prefix) }`, which the Stoa reads take. */
export const view = (load, rootCID) => ({
  get: (key) => get(load, rootCID, key),
  list: (prefix) => list(load, rootCID, prefix),
});
