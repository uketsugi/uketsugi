import { describe, expect, it } from "vitest";
import { asPerson } from "../src/sharing.ts";
import type { Caller } from "../src/domain.ts";
import type { Unit } from "../src/store-port.ts";

const [low, high] = [
  "00000000-0000-7000-8000-000000000001",
  "00000000-0000-7000-8000-000000000002",
];
const ann = {
  orgId: "org",
  principalId: "ann",
  displayName: "ann",
  credentialId: null,
  privateAudienceId: "own",
  groups: [
    { id: low, name: "low" },
    { id: high, name: "high" },
  ],
  visibleAudienceIds: ["own", low, high],
} satisfies Caller;

/** A store whose unit answers only what a reach asks of it: the groups it was asked for, in order. */
function ports(asked: string[]) {
  const unit = {
    audienceId: "own",
    choice: () => Promise.resolve(null),
    on: (id: string) => {
      asked.push(id);
      return Promise.resolve({ audienceId: id });
    },
  } as unknown as Unit;
  return { store: { unit: (_target: unknown, work: (u: Unit) => unknown) => work(unit) } } as never;
}

const who = (caller: Caller) => ({ caller, project: "p", at: new Date(0) });

describe("what a write may reach", () => {
  it("is a group of the person's own list only: another group is refused before the store is asked", async () => {
    const asked: string[] = [];
    const stranger = { ...ann, groups: [{ id: low, name: "low" }] };
    await expect(
      asPerson(ports(asked), who(stranger), (place) => place.reach(high)),
    ).rejects.toThrow("a unit reaches only the groups of its person");
    expect(asked).toEqual([]);
    await asPerson(ports(asked), who(stranger), (place) => place.reach(low));
    expect(asked).toEqual([low]);
  });

  it("takes groups in the order of their ids, and refuses a smaller one after a larger in words", async () => {
    const asked: string[] = [];
    await expect(
      asPerson(ports(asked), who(ann), async (place) => {
        await place.reach(high);
        await place.reach(low);
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(asked).toEqual([high]);
    const inOrder: string[] = [];
    await asPerson(ports(inOrder), who(ann), async (place) => {
      await place.reach(low);
      await place.reach(high);
      await place.reach(low);
    });
    expect(inOrder).toEqual([low, high]);
  });
});
