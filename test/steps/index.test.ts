import { test, expect, describe } from "bun:test";
import { ALL_STEPS, LOCAL_STEPS, REMOTE_STEPS } from "../../src/steps";

const names = (steps: { name: string }[]) => steps.map((s) => s.name);

describe("decoupage des etapes", () => {
  test("la phase locale ne contient que le cote Mac", () => {
    expect(names(LOCAL_STEPS)).toEqual(["network-mac"]);
  });

  test("la phase distante ne contient que le cote PC", () => {
    expect(names(REMOTE_STEPS)).toEqual(["network-windows", "network-profile-task"]);
  });

  test("ALL_STEPS reste local puis distant, dans cet ordre exact", () => {
    // uninstall defait dans l'ordre inverse : le PC doit etre restaure tant
    // que le Mac porte encore son adresse et que la session SSH tient. Une
    // inversion ici couperait le canal avant d'avoir restaure le PC.
    expect(names(ALL_STEPS)).toEqual([
      "network-mac",
      "network-windows",
      "network-profile-task",
    ]);
    expect(names(ALL_STEPS)).toEqual([...names(LOCAL_STEPS), ...names(REMOTE_STEPS)]);
  });
});
