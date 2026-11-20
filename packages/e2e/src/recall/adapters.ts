/** The memory products the suite can run against, by the name `--product` takes. */
import type { Adapter } from "./adapter.ts";
import { uketsugi } from "./uketsugi.ts";

const ADAPTERS: Record<string, Adapter> = { uketsugi };

export const DEFAULT_PRODUCT = "uketsugi";
export const DEFAULT_MODEL = "haiku";

export function adapterFor(product: string): Adapter {
  const adapter = ADAPTERS[product];
  if (adapter === undefined) {
    throw new Error(`no product ${product}: the suite knows ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return adapter;
}

/** A configuration of a product; none named is the product's first. */
export function configurationOf(adapter: Adapter, config: string | undefined): string {
  const chosen = config ?? adapter.configurations[0];
  if (!adapter.configurations.includes(chosen)) {
    throw new Error(
      `${adapter.name} has no configuration ${chosen}: ${adapter.configurations.join(", ")}`,
    );
  }
  return chosen;
}
