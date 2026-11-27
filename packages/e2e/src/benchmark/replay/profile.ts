/**
 * What the four figures become with one fitted value relaxed. A relaxed profile is handed to the
 * server the searches run on (`CorePorts.searchProfile`); the fitted values are never changed.
 */
import { SEARCH_PROFILE, type SearchProfile } from "@uketsugi/core";

type Change = Partial<SearchProfile>;

/** The admission values, each set aside as far as it goes. */
export const RELAXATIONS: Readonly<Record<string, Change>> = {
  coverageAdmission: { coverageAdmission: 0 },
  keywordFloor: { keywordFloor: 0 },
  vectorCutoff: { vectorCutoff: -1 },
  trigramThreshold: { trigramThreshold: 0 },
  passLimit: { passLimit: 100_000 },
};

/** Every relaxation at once. */
const ALL_RELAXED = "all relaxed";

export const VARIANTS: readonly string[] = [...Object.keys(RELAXATIONS), ALL_RELAXED];

function changeOf(variant: string): Change {
  if (variant !== ALL_RELAXED) return RELAXATIONS[variant] ?? {};
  return Object.assign({}, ...Object.values(RELAXATIONS)) as Change;
}

/** The fitted values with the variant's set aside. */
export function relaxedProfile(variant: string): SearchProfile {
  return { ...SEARCH_PROFILE, ...changeOf(variant) };
}
