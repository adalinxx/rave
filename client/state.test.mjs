//   node --test client/state.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { anyHost, get, list } from "./state.mjs";

// An in-memory trie in the same shape the chain serves.
const nodes = {
  root: { count: 6n, children: [{ key: "u", value: { rawCID: "user" } }, { key: "i", value: { rawCID: "idx" } }] },
  user: { prefix: "user/", children: [{ key: "a", value: { rawCID: "a" } }, { key: "b", value: { rawCID: "b" } }] },
  a: { prefix: "alice/p", children: [{ key: "r", value: { rawCID: "ap" } }, { key: "o", value: { rawCID: "ao" } }] },
  ap: { prefix: "rofile", value: "{}", children: [] },
  ao: { prefix: "ost/", children: [{ key: "2", value: { rawCID: "a2" } }, { key: "1", value: { rawCID: "a1" } }] },
  a1: { prefix: "1", value: "first", children: [{ key: "0", value: { rawCID: "a10" } }] },
  a10: { prefix: "0", value: "tenth", children: [] },
  a2: { prefix: "2", value: "second", children: [] },
  b: { prefix: "bob/profile", value: "{b}", children: [] },
  idx: { prefix: "index/follower/bob/alice", value: "1", children: [] },
};
const load = async (cid) => ({ node: nodes[cid] });
const all = async (prefix) => {
  const found = [];
  for await (const entry of list(load, "root", prefix)) found.push(entry);
  return found;
};

test("get finds exact keys only", async () => {
  assert.equal(await get(load, "root", "user/alice/post/1"), "first");
  assert.equal(await get(load, "root", "user/alice/post/10"), "tenth");
  assert.equal(await get(load, "root", "user/bob/profile"), "{b}");
  assert.equal(await get(load, "root", "user/alice/post/"), undefined);
  assert.equal(await get(load, "root", "user/alice/post/3"), undefined);
  assert.equal(await get(load, "root", "user/bob"), undefined);
  assert.equal(await get(load, "root", "nothing"), undefined);
});

test("list returns a prefix's entries in key order", async () => {
  assert.deepEqual(await all("user/alice/post/"), [
    ["user/alice/post/1", "first"],
    ["user/alice/post/10", "tenth"],
    ["user/alice/post/2", "second"],
  ]);
  // A prefix ending inside a node's own prefix still matches its subtree.
  assert.deepEqual((await all("user/al")).map(([key]) => key), [
    "user/alice/post/1",
    "user/alice/post/10",
    "user/alice/post/2",
    "user/alice/profile",
  ]);
  assert.deepEqual(await all("index/follower/bob/"), [["index/follower/bob/alice", "1"]]);
  assert.deepEqual(await all("user/carol/"), []);
  assert.deepEqual(await all("user/alicia"), []);
  assert.equal((await all("")).length, 6);
});

test("anyHost spreads reads and moves on from a host that cannot serve", async () => {
  const asked = [];
  const host = (name, answer) => ({
    getVolume: async (cid) => {
      asked.push(name);
      return answer(cid);
    },
  });
  const transport = anyHost([
    host("a", (cid) => cid),
    host("b", () => null),
    host("c", () => {
      throw new Error("HTTP 429");
    }),
  ]);
  assert.equal(await transport.getVolume("x"), "x"); // a
  assert.equal(await transport.getVolume("y"), "y"); // b lacks it, c refuses, a serves
  assert.deepEqual(asked, ["a", "b", "c", "a"]);
  await assert.rejects(anyHost([host("c", () => Promise.reject(new Error("HTTP 429")))]).getVolume("x"));
  assert.equal(await anyHost([host("b", () => null)]).getVolume("x"), null);
});
