/**
 * What the four figures become with one fitted value relaxed, in this process and never in the tree.
 *
 * The product gives no way to pass a value into a search: `SEARCH_PROFILE` is a module constant that
 * core reads at each search and does not export from its package. This file imports that module by
 * its path and sets a field while a search runs, then puts it back. The smallest change that would
 * make this unnecessary is exporting `SEARCH_PROFILE` from `@uketsugi/core` (still read at each
 * search, so the same override would work without a path); a profile on the ports would be cleaner
 * and larger. Neither is made here: search is not this lane's to change.
 */
import { SEARCH_PROFILE } from "../../../../core/src/search/fusion.ts";

type Values = Record<string, number>;

/** The admission values, each set aside as far as it goes. */
export const RELAXATIONS: Readonly<Record<string, Values>> = {
  coverageAdmission: { coverageAdmission: 0 },
  keywordFloor: { keywordFloor: 0 },
  vectorCutoff: { vectorCutoff: -1 },
  trigramThreshold: { trigramThreshold: 0 },
  passLimit: { passLimit: 100_000 },
};

/** Every relaxation at once. */
export const ALL_RELAXED = "all relaxed";

export const VARIANTS: readonly string[] = [...Object.keys(RELAXATIONS), ALL_RELAXED];

function changeOf(variant: string): Values {
  if (variant !== ALL_RELAXED) return RELAXATIONS[variant] ?? {};
  return Object.assign({}, ...Object.values(RELAXATIONS)) as Values;
}

/** Runs `run` with the variant's values set, and restores them whatever happens. */
export async function withRelaxed<T>(variant: string, run: () => Promise<T>): Promise<T> {
  const profile = SEARCH_PROFILE as unknown as Values;
  const before = { ...profile };
  Object.assign(profile, changeOf(variant));
  try {
    return await run();
  } finally {
    Object.assign(profile, before);
  }
}
