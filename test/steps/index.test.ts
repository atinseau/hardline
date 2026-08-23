import { test, expect, describe } from "bun:test";
import {
  ALL_STEPS,
  CAPTURE_STEPS,
  LOCAL_STEPS,
  REMOTE_STEPS,
  WINDOWS_STEPS,
} from "../../src/steps";

const names = (steps: { name: string }[]) => steps.map((s) => s.name);

describe("decoupage des etapes", () => {
  test("la phase locale reunit tout ce qui ne depend d'aucune precondition distante", () => {
    expect(names(LOCAL_STEPS)).toEqual([
      "network-mac",
      "moonlight-install",
      "smb-credentials",
    ]);
  });

  test("le rapatriement du releve est une phase a lui seul", () => {
    // Il doit pouvoir s'executer des que SSH repond, avant la porte des
    // preconditions restantes : c'est ce decoupage qui le rend possible.
    expect(names(CAPTURE_STEPS)).toEqual(["bootstrap-windows"]);
  });

  test("la phase distante porte Apollo, les partages, et l'appairage en dernier", () => {
    expect(names(REMOTE_STEPS)).toEqual([
      "network-windows",
      "network-profile-task",
      "apollo-install",
      "apollo-config",
      "apollo-service",
      "smb-shares",
      "pairing",
    ]);
  });

  test("WINDOWS_STEPS reunit tout ce qui touche au PC", () => {
    // uninstall s'en sert pour nommer les machines concernees : le releve
    // d'amorcage seul au manifeste doit dire « du PC », pas « des machines
    // concernees ».
    expect(names(WINDOWS_STEPS)).toEqual([
      "bootstrap-windows",
      "network-windows",
      "network-profile-task",
      "apollo-install",
      "apollo-config",
      "apollo-service",
      "smb-shares",
      "pairing",
    ]);
  });

  test("ALL_STEPS reste local puis rapatriement puis distant, dans cet ordre exact", () => {
    // uninstall defait dans l'ordre inverse : le PC doit etre restaure tant
    // que le Mac porte encore son adresse et que la session SSH tient. Une
    // inversion ici couperait le canal avant d'avoir restaure le PC.
    expect(names(ALL_STEPS)).toEqual([
      "network-mac",
      "moonlight-install",
      "smb-credentials",
      "bootstrap-windows",
      "network-windows",
      "network-profile-task",
      "apollo-install",
      "apollo-config",
      "apollo-service",
      "smb-shares",
      "pairing",
    ]);
    expect(names(ALL_STEPS)).toEqual([
      ...names(LOCAL_STEPS),
      ...names(CAPTURE_STEPS),
      ...names(REMOTE_STEPS),
    ]);
  });

  test("apollo-install precede apollo-config : on ne configure pas ce qui n'est pas pose", () => {
    const order = names(ALL_STEPS);
    expect(order.indexOf("apollo-install")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("apollo-install")).toBeLessThan(order.indexOf("apollo-config"));
  });

  test("apollo-config precede apollo-service : le service demarre sur une conf ecrite", () => {
    const order = names(ALL_STEPS);
    expect(order.indexOf("apollo-config")).toBeLessThan(order.indexOf("apollo-service"));
  });

  test("pairing vient apres apollo-service : l'appairage exige qu'Apollo tourne", () => {
    const order = names(ALL_STEPS);
    expect(order.indexOf("apollo-service")).toBeLessThan(order.indexOf("pairing"));
  });

  test("pairing est la toute derniere etape : elle se defait la toute premiere a la restauration", () => {
    expect(names(ALL_STEPS).at(-1)).toBe("pairing");
  });

  test("smb-credentials precede smb-shares : le trousseau porte deja le mot de passe", () => {
    const order = names(ALL_STEPS);
    expect(order.indexOf("smb-credentials")).toBeLessThan(order.indexOf("smb-shares"));
  });

  test("moonlight-install et smb-credentials tournent avant meme l'amorcage du PC", () => {
    const order = names(ALL_STEPS);
    expect(order.indexOf("moonlight-install")).toBeLessThan(
      order.indexOf("bootstrap-windows"),
    );
    expect(order.indexOf("smb-credentials")).toBeLessThan(
      order.indexOf("bootstrap-windows"),
    );
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
    expect(order.indexOf("network-mac")).toBeLessThan(order.indexOf("bootstrap-windows"));
  });
});
