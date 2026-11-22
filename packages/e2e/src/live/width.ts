/**
 * Calibration: how many sessions can run at once. W is the narrower of two widths, and the first
 * run's N is floor(W / 4), four sessions a unit at the widest.
 * - The machine's K: at K = 8, 16, 24 and 32, K judgements of T4's and T8's reference squashes at
 *   once with K/2 servers (embedding model loaded) beside them, three times each; the widest K at
 *   which every judgement passed and every server stayed up in every repeat. The time against a
 *   solo judgement is printed and decides nothing: a job of a few seconds measures noise.
 * - The provider's K: K two-minute read-only Haiku sessions at the machine's K, halved after a refusal.
 * The trials themselves (`calibrate.ts`) need the machine and the provider; the decisions are here.
 */
export const WIDTHS = [8, 16, 24, 32];
/** Each K is tried this many times: a width that holds once and fails the next time is not a width (the hidden tests are timing-sensitive). */
export const REPEATS = 3;

export interface MachineTrial {
  readonly k: number;
  readonly allPassed: boolean;
  readonly serversUp: boolean;
  /** Median judge time over the solo time: printed, and decides nothing. */
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

/** Tries K upward, each REPEATS times, and stops at the first K that fails in any repeat: the widest that held every time. */
export async function machineWidth(
  trial: (k: number, repeat: number) => Promise<MachineTrial>,
  repeats = REPEATS,
): Promise<MachineWidth> {
  const trials: MachineTrial[] = [];
  let k = 0;
  for (const width of WIDTHS) {
    let held = true;
    for (let repeat = 0; repeat < repeats; repeat++) {
      const done = await trial(width, repeat);
      trials.push(done);
      held &&= done.allPassed && done.serversUp;
      if (!held) break;
    }
    if (!held) break;
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
