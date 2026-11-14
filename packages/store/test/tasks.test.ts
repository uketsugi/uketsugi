import { describeTaskStoreConformance } from "@uketsugi/testkit";
import { openEmbeddedStore } from "../src/index.ts";

describeTaskStoreConformance("embedded PostgreSQL", { open: () => openEmbeddedStore() });
