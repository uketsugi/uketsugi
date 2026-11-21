/** The exact tests of the live report, against values worked out by hand. */
import { describe, expect, test } from "vitest";
import { fisherExact, mcnemarExact, wilcoxonExact } from "../../src/live/exact.ts";

const near = (value: number, want: number): void =>
  expect(Math.abs(value - want)).toBeLessThan(1e-4);

describe("exact tests", () => {
  test("McNemar: 1 against 7 discordant pairs is p 0.0703; no discordant pair is p 1", () => {
    near(mcnemarExact(1, 7), 0.0703125);
    near(mcnemarExact(0, 0), 1);
    near(mcnemarExact(0, 8), 0.0078125);
  });

  test("Fisher: [[3,1],[1,3]] is p 0.4857, and [[8,0],[0,8]] is p 0.0001", () => {
    near(fisherExact(3, 1, 1, 3), 0.485714);
    near(fisherExact(8, 0, 0, 8), 2 / 12870);
    near(fisherExact(5, 5, 5, 5), 1);
  });

  test("Wilcoxon: five positive differences are p 0.0625, eight are p 0.0078; ties and zeros are handled", () => {
    near(wilcoxonExact([1, 2, 3, 4, 5]), 0.0625);
    near(wilcoxonExact([1, 2, 3, 4, 5, 6, 7, 8]), 0.0078125);
    near(wilcoxonExact([1, -1]), 1);
    near(wilcoxonExact([0, 0, 1, 2, 3, 4, 5]), 0.0625);
    near(wilcoxonExact([-1, 2, 3, -4, 5, 6]), 0.3125);
    // tied sizes share their mean rank: ranks sum 36, the negatives 8.5, p 0.2421875 by permuting the signs of those ranks
    near(wilcoxonExact([1, 1, -1, 2, 2, 3, -3, 4]), 0.2421875);
  });
});
