// A stack to look at by hand: starts it, seeds the demo data, prints the
// page's address and keeps running until interrupted.
//   LATTICE=<lattice> node e2e/ui/look.local.mjs
import { start } from "./stack.mjs";
import { seed } from "../../scripts/seed.mjs";
const running = await start();
const { info } = running;
const people = await seed(info.node, info.chain, info.moniker);
console.log(JSON.stringify({ ...info, people }, null, 2));
console.log(`open ${info.app}?node=${encodeURIComponent(info.node)}&chain=${info.chain}&moniker=${info.moniker}`);
process.on("SIGINT", async () => { await running.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
