/**
 * Exact tests, two-sided, for the small samples the live run has: McNemar's on paired yes/no
 * cells, Fisher's on two groups of yes/no, and Wilcoxon's signed-rank on paired differences (ties
 * share their mean rank; the signs are permuted exactly).
 */

/** log of n choose k, by summing logs: exact enough for samples of a few hundred. */
function logChoose(n: number, k: number): number {
  let total = 0;
  for (let i = 1; i <= k; i++) total += Math.log((n - k + i) / i);
  return total;
}

/** The two-sided p of `b` and `c` discordant pairs: the binomial at one half, summed over what is as unlikely or less. */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const tail = Math.min(b, c);
  let p = 0;
  for (let k = 0; k <= tail; k++) p += Math.exp(logChoose(n, k) - n * Math.LN2);
  return Math.min(1, 2 * p);
}

/** The two-sided p of the table [[a, b], [c, d]]: every table with the same margins that is as unlikely or less. */
export function fisherExact(a: number, b: number, c: number, d: number): number {
  const row1 = a + b;
  const col1 = a + c;
  const total = a + b + c + d;
  const logP = (x: number): number =>
    logChoose(row1, x) + logChoose(total - row1, col1 - x) - logChoose(total, col1);
  const observed = logP(a);
  let p = 0;
  for (let x = Math.max(0, col1 - (total - row1)); x <= Math.min(row1, col1); x++) {
    if (logP(x) <= observed + 1e-9) p += Math.exp(logP(x));
  }
  return Math.min(1, p);
}

/** The two-sided p of the signed-rank statistic of `differences`; zeros are dropped. */
export function wilcoxonExact(differences: readonly number[]): number {
  const nonzero = differences.filter((d) => d !== 0);
  const order = nonzero.map((d, i) => ({ size: Math.abs(d), i })).sort((x, y) => x.size - y.size);
  const rank2 = new Array<number>(nonzero.length); // twice the mean rank, so that every weight is a whole number
  for (let from = 0; from < order.length;) {
    let to = from;
    while (to + 1 < order.length && order[to + 1]?.size === order[from]?.size) to++;
    for (let k = from; k <= to; k++) rank2[(order[k] as { i: number }).i] = from + to + 2;
    from = to + 1;
  }
  const sum = rank2.reduce((s, r) => s + r, 0);
  const ways = new Array<number>(sum + 1).fill(0);
  ways[0] = 1;
  for (const r of rank2)
    for (let s = sum; s >= r; s--) ways[s] = (ways[s] as number) + (ways[s - r] as number);
  const positive = nonzero.reduce((s, d, i) => s + (d > 0 ? (rank2[i] as number) : 0), 0);
  const all = 2 ** nonzero.length;
  const low = ways.slice(0, positive + 1).reduce((s, w) => s + w, 0) / all;
  const high = ways.slice(positive).reduce((s, w) => s + w, 0) / all;
  return Math.min(1, 2 * Math.min(low, high));
}
