// Demo places and reviews around Madison Square Park, written by a handful of
// accounts the way any client writes: each signs its own records. For a
// trial chain or a local look. Keys are made fresh, or read from (and saved
// to) a directory.
//
//   node scripts/seed.mjs <node URL> <Rave chain> <Moniker chain> [keys dir]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { newAccount, setName, writeAs } from "../e2e/ui/helpers.mjs";
import * as write from "../client/write.mjs";

export const PEOPLE = ["Dana Okafor", "Sam Reyes", "Ari Chen", "Mo Haddad", "Tess Ward", "Lin Wei", "Clean Plate", "Rina Patel"];

export const PLACES = [
  { id: "marigold", by: 0, name: "Marigold Noodle Bar", lat: 40.74168, lon: -73.98945, category: "Food", address: "21 E 24th St", hours: "Daily 11:30–22:00" },
  { id: "secondshift", by: 1, name: "Second Shift Coffee", lat: 40.74242, lon: -73.98806, category: "Coffee", address: "102 Madison Ave", hours: "Mon–Fri 7–18, Sat–Sun 8–17" },
  { id: "lowtide", by: 0, name: "The Low Tide", lat: 40.74055, lon: -73.98712, category: "Bar", address: "33 E 23rd St" },
  { id: "pholinh", by: 2, name: "Pho Linh", lat: 40.74312, lon: -73.98648, category: "Food", address: "8 E 26th St" },
  { id: "harborhw", by: 3, name: "Harbor Hardware", lat: 40.74001, lon: -73.98896, category: "Shop", address: "15 E 22nd St" },
  { id: "ninth", by: 4, name: "Ninth Street Bakery", lat: 40.74127, lon: -73.99036, category: "Food", address: "4 W 24th St", hours: "Daily 7–15" },
  { id: "parkcuts", by: 5, name: "Park Cuts", lat: 40.74206, lon: -73.99088, category: "Service", address: "11 W 25th St" },
  // A second listing of the noodle bar, 6 m away: someone labels it a duplicate.
  { id: "marigold2", by: 3, name: "Marigold Noodles", lat: 40.74171, lon: -73.9895, category: "Food" },
];

// [place, person, stars, words]
export const REVIEWS = [
  ["marigold", 0, 4, "Hand-pulled noodles are the reason to come. The broth was a little salty tonight."],
  ["marigold", 1, 5, ""],
  ["marigold", 2, 4, "Dan dan noodles with real heat. Get there before 7 or wait."],
  ["marigold", 3, 2, "Waited 40 minutes for a table, then the noodles came out lukewarm."],
  ["marigold", 4, 5, "Best noodles south of 34th. The chili oil is worth the trip by itself."],
  ["marigold", 6, 1, "Avoid."],
  ["marigold", 7, 5, "Amazing!!! Best in NYC!!! Five stars!!!"],
  ["secondshift", 0, 5, "Quiet in the mornings, good light, the cortado is right."],
  ["secondshift", 2, 4, ""],
  ["secondshift", 4, 3, "Fine coffee, slow line."],
  ["lowtide", 0, 2, "Too loud to talk after 9. Good happy hour though."],
  ["lowtide", 3, 3, ""],
  ["pholinh", 0, 5, "The brisket pho, every time."],
  ["pholinh", 1, 4, "Big bowls, quick service, cash only."],
  ["pholinh", 4, 5, ""],
  ["harborhw", 0, 4, "They cut keys while you wait and know what they're talking about."],
  ["ninth", 0, 3, "Croissants sell out by 10."],
  ["ninth", 2, 4, "The rye loaf is the move."],
  ["parkcuts", 1, 5, "Walk-ins welcome, careful work."],
];


/** Writes the demo data; returns the accounts by person. */
export async function seed(node, chain, monikerChain, keysDir) {
  const people = PEOPLE.map((name, i) => {
    const file = keysDir && `${keysDir}/person-${i}.json`;
    if (file && existsSync(file)) return { name, ...JSON.parse(readFileSync(file, "utf8")) };
    const account = newAccount();
    if (file) {
      mkdirSync(keysDir, { recursive: true });
      writeFileSync(file, JSON.stringify(account));
    }
    return { name, ...account };
  });
  await Promise.all(people.map((p) => setName(node, monikerChain, p, p.name)));
  // Places: each by its own author.
  const byPerson = new Map();
  for (const p of PLACES) byPerson.set(p.by, [...(byPerson.get(p.by) ?? []), p]);
  await Promise.all([...byPerson].map(([i, list]) =>
    writeAs(node, chain, people[i], list.flatMap((p) => write.place(people[i].address, p.id, p)))));
  const ref = (id) => ({ author: people[PLACES.find((p) => p.id === id).by].address, id });
  // Reviews: one transaction per person. A record's time is when it is sent:
  // the chain holds it to its block, so demo data can't be backdated.
  const reviewsBy = new Map();
  for (const [placeId, i, stars, body] of REVIEWS) {
    reviewsBy.set(i, [...(reviewsBy.get(i) ?? []), ...write.review(people[i].address, `r-${placeId}`, ref(placeId), { stars, body })]);
  }
  await Promise.all([...reviewsBy].map(([i, records]) => writeAs(node, chain, people[i], records)));
  // The owner of Marigold answers the 2-star review; Clean Plate labels the
  // gushing one paid and the one-word one spam; Dana marks the duplicate and
  // follows Sam and Ari.
  const review = (placeId, i) => ({ author: people[i].address, id: `r-${placeId}` });
  await Promise.all([
    writeAs(node, chain, people[5], write.reply(people[5].address, "x-owner", review("marigold", 3), {
      body: "Owner here. Sorry about the wait on Friday; we were two cooks short. Come back and ask for Lin.",
    })),
    writeAs(node, chain, people[6], [
      ...write.reply(people[6].address, "x-paid", review("marigold", 7), { body: "Same wording as a batch of paid reviews we've seen.", labels: ["paid"] }),
      ...write.reply(people[6].address, "x-spam", review("marigold", 6), { body: "", labels: ["spam"] }),
    ]),
    writeAs(node, chain, people[0], [
      ...write.reply(people[0].address, "x-dup", { author: people[3].address, id: "marigold2" }, {
        body: "Same restaurant, listed twice.",
        labels: [`same-as:${people[0].address}/marigold`],
      }),
      ...write.follow(people[0].address, people[1].address),
      ...write.follow(people[0].address, people[2].address),
      ...write.followLabels(people[0].address, people[6].address),
    ]),
  ]);
  return people;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [node, chain, monikerChain, keysDir] = process.argv.slice(2);
  const people = await seed(node, chain, monikerChain, keysDir);
  console.log(people.map((p) => `${p.name}: ${p.address}`).join("\n"));
}
