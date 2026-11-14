/**
 * A process that owns a data directory and publishes to it until it is killed. It prints the id of
 * each fact once the unit that wrote it has committed, so its parent knows what was acknowledged.
 * Run as: node --conditions=@uketsugi/source writer.ts <dataDir> [number of its first fact]
 */
import { openEmbeddedStore } from "../../src/index.ts";
import { publishSample, sampleOwner } from "./sample.ts";

const store = await openEmbeddedStore({ dataDir: process.argv[2] ?? "", lockStaleMs: 2000 });
const owner = await sampleOwner(store);
for (let n = Number(process.argv[3] ?? 1); ; n += 1)
  console.log(await publishSample(store, owner, n));
