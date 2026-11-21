/**
 * Calibration: how many sessions can run at once. W is the narrower of two widths, and the first
 * run's N is floor(W / 4), four sessions a unit at the widest.
 * - The machine's K: at K = 8, 16, 24 and 32, K judgements of T4's and T8's reference squashes at
 *   once with K/2 servers (embedding model loaded) beside them; the widest K at which every
 *   judgement passes, every server stays up and the median judge time is within 1.25 times solo.
 * - The provider's K: K two-minute read-only Haiku sessions at the machine's K, halved after a refusal.
 * The trials themselves (`calibrate.ts`) need the machine and the provider; the decisions are here.
 */
export const WIDTHS = [8, 16, 24, 32];
export const MAX_RATIO = 1.25;

export interface MachineTrial {
  readonly k: number;
  readonly allPassed: boolean;
  readonly serversUp: boolean;
  /** Median judge time over the solo time. */
  readonly ratio: number;
}

export interface MachineWidth {
  readonly k: number;
  readonly trials: readonly MachineTrial[];
}

export interface ProviderWidth {
  readonly k: number;
  readonly tries: readonly { k: number; refused: boolean }[];
}

/** Tries K upward and stops at the first that fails: the widest that held. */
export async function machineWidth(
  trial: (k: number) => Promise<MachineTrial>,
): Promise<MachineWidth> {
  const trials: MachineTrial[] = [];
  let k = 0;
  for (const width of WIDTHS) {
    const done = await trial(width);
    trials.push(done);
    if (!done.allPassed || !done.serversUp || done.ratio > MAX_RATIO) break;
    k = width;
  }
  return { k, trials };
}

/** Runs K sessions, and halves K after a refusal, until a run is clean or K is 0. */
export async function providerWidth(
  start: number,
  attempt: (k: number) => Promise<{ refused: boolean }>,
): Promise<ProviderWidth> {
  const tries: { k: number; refused: boolean }[] = [];
  for (let k = start; k >= 1; k = Math.floor(k / 2)) {
    const { refused } = await attempt(k);
    tries.push({ k, refused });
    if (!refused) return { k, tries };
  }
  return { k: 0, tries };
}

/** What `width.json` holds. */
export function widthOf(machine: MachineWidth, provider: ProviderWidth) {
  const width = Math.min(machine.k, provider.k);
  return { machine, provider, width, units: Math.floor(width / 4) };
}
