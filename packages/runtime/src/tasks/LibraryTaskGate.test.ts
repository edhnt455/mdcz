import { expect, it } from "vitest";
import { LibraryTaskGate } from "./LibraryTaskGate";

it("hands the next admission to waiting manual tasks before resuming background work", async () => {
  const gate = new LibraryTaskGate();
  let subtitle = true;
  let edit = false;
  let maintenance = false;
  gate.track("subtitle", () => subtitle);
  gate.track("edit", () => edit);
  gate.track("maintenance", () => maintenance);
  const manual = gate.waitForSubtitle().then(() => {
    gate.assertAvailable("edit");
    edit = true;
  });
  const competing = gate.waitForSubtitle().then(() => gate.assertAvailable("maintenance"));
  expect(gate.foregroundBusy).toBe(true);
  subtitle = false;
  gate.subtitleFinished();
  expect(() => gate.assertAvailable("subtitle")).toThrow();
  const outcomes = await Promise.allSettled([manual, competing]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
  expect(() => gate.assertAvailable("subtitle")).toThrow("批量编辑");
  edit = false;
  maintenance = true;
  expect(() => gate.assertAvailable("subtitle")).toThrow("维护任务");
  maintenance = false;
  expect(gate.foregroundBusy).toBe(false);
  expect(() => gate.assertAvailable("subtitle")).not.toThrow();
  await gate.waitForSubtitle();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = gate.runManualWrite(() => held);
  await Promise.resolve();
  expect(gate.foregroundBusy).toBe(true);
  expect(() => gate.assertAvailable("subtitle")).toThrow();
  release();
  await save;
  await expect(
    gate.runManualWrite(async () => {
      throw new Error("write failed");
    }),
  ).rejects.toThrow("write failed");
  expect(gate.foregroundBusy).toBe(false);
  expect(() => gate.assertAvailable("subtitle")).not.toThrow();
});
