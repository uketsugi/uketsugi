import { describeModelStepConformance } from "@uketsugi/testkit";
import { openEmbeddedStore } from "../src/index.ts";

describeModelStepConformance("embedded PostgreSQL", { open: () => openEmbeddedStore() });
