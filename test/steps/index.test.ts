import { test, expect, describe } from "bun:test";
import { ALL_STEPS, LOCAL_STEPS, REMOTE_STEPS } from "../../src/steps";

const names = (steps: { name: string }[]) => steps.map((s) => s.name);

describe("decoupage des etapes", () => {
  test("la phase locale ne contient que le cote Mac", () => {
    expect(names(LOCAL_STEPS)).toEqual(["network-mac"]);
  });

  test("la phase distante ne contient que le cote PC", () => {
    expect(names(REMOTE_STEPS)).toEqual([
      "bootstrap-windows",
      "network-windows",
      "network-profile-task",
    ]);
  });

  test("ALL_STEPS reste local puis distant, dans cet ordre exact", () => {
    // uninstall defait dans l'ordre inverse : le PC doit etre restaure tant
    // que le Mac porte encore son adresse et que la session SSH tient. Une
    // inversion ici couperait le canal avant d'avoir restaure le PC.
    expect(names(ALL_STEPS)).toEqual([
      "network-mac",
      "bootstrap-windows",
      "network-windows",
      "network-profile-task",
    ]);
    expect(names(ALL_STEPS)).toEqual([...names(LOCAL_STEPS), ...names(REMOTE_STEPS)]);
  });

  test("l'amorcage precede l'adressage, donc il est restaure apres lui", () => {
    // L'etat anterieur qu'enregistre network-windows n'est que l'etat
    // d'APRES amorcage : cette etape ne peut observer le PC qu'une fois SSH
    // ouvert. Sur l'adressage, seul le releve d'amorcage decrit le PC d'avant
    // hardline, et il doit donc avoir le dernier mot a la restauration.
    const order = names(ALL_STEPS);
    expect(order.indexOf("bootstrap-windows")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("bootstrap-windows")).toBeLessThan(
      order.indexOf("network-windows"),
    );
    // Et il reste bien apres le Mac : la session SSH a besoin de l'adresse
    // locale tant que le PC n'est pas restaure.
    expect(order.indexOf("network-mac")).toBeLessThan(
      order.indexOf("bootstrap-windows"),
    );
  });
});
