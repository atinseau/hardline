import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

const NO_PENDING = { pending: [] as string[] };
const order: string[] = [];

let apolloWebSecret: string | null = "web-secret";
let clientList: Array<{ name: string; uuid: string }> = [];
let clientListAfterPin: Array<{ name: string; uuid: string }> | null = null;
let sendPinResult = true;
let plistHosts: Array<{ address: string }> = [];
let killCalls = 0;

const spawnPair = mock((..._args: unknown[]) => {
  order.push("spawnPair");
  return { kill: () => { killCalls += 1; } };
});
const sendPin = mock(async (..._args: unknown[]) => {
  order.push("sendPin");
  return sendPinResult;
});
const listClients = mock(async (..._args: unknown[]) => {
  order.push("listClients");
  return clientListAfterPin ?? clientList;
});
const unpairClient = mock(async (..._args: unknown[]) => {});

mock.module("../../src/lib/apollo-api", () => ({ listClients, sendPin, unpairClient }));
mock.module("../../src/lib/moonlight", () => ({ spawnPair }));

const forgetHost = mock(async (..._args: unknown[]) => {});
mock.module("../../src/lib/moonlight-plist", () => ({
  readHosts: async () => plistHosts,
  containsHost: (hosts: Array<{ address: string }>, host: string) =>
    hosts.some((h) => h.address === host),
  forgetHost,
}));

mock.module("../../src/lib/keychain", () => ({
  getSecret: async () => apolloWebSecret,
  generatePin: () => "4821",
}));

const { pairingStep } = await import("../../src/steps/pairing");

beforeEach(() => {
  order.length = 0;
  apolloWebSecret = "web-secret";
  clientList = [];
  clientListAfterPin = null;
  sendPinResult = true;
  plistHosts = [];
  killCalls = 0;
  spawnPair.mockClear();
  sendPin.mockClear();
  listClients.mockClear();
  unpairClient.mockClear();
  forgetHost.mockClear();
});

describe("inspect", () => {
  test("declare conforme quand notre client figure deja dans la liste", async () => {
    clientList = [{ name: "hardline-mac", uuid: "u-1" }];
    const state = await pairingStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
    expect(state.current.clients).toEqual(["u-1"]);
  });

  test("declare non conforme quand notre client est absent", async () => {
    clientList = [{ name: "autre-appareil", uuid: "u-2" }];
    const state = await pairingStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
  });

  test("capture si le plist connaissait deja cet hote", async () => {
    plistHosts = [{ address: "10.10.10.1" }];
    const state = await pairingStep.inspect(CONFIG);
    expect(state.current.hostKnown).toBe(true);
  });

  test("rejette explicitement si Apollo n'a pas encore d'identifiants web", async () => {
    apolloWebSecret = null;
    await expect(pairingStep.inspect(CONFIG)).rejects.toThrow(
      /apollo-config doit s'appliquer/,
    );
  });
});

describe("apply, sequence nominale", () => {
  test("lance l'appairage sans attendre sa fin, puis poste le meme code", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];
    await pairingStep.apply(CONFIG);

    expect(spawnPair).toHaveBeenCalledTimes(1);
    expect(sendPin).toHaveBeenCalledTimes(1);
    const pinPasseAMoonlight = (spawnPair.mock.calls[0] as unknown[])[1];
    const pinPosteAApollo = (sendPin.mock.calls[0] as unknown[])[2];
    expect(pinPasseAMoonlight).toBe(pinPosteAApollo);
    expect(pinPasseAMoonlight).toMatch(/^\d{4}$/);
  });

  test("respecte l'ordre impose par la spec : pair, puis pin, puis relecture", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];
    await pairingStep.apply(CONFIG);
    expect(order).toEqual(["spawnPair", "sendPin", "listClients"]);
  });

  test("relit la liste une seule fois, apres l'envoi du code", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];
    await pairingStep.apply(CONFIG);
    expect(listClients).toHaveBeenCalledTimes(1);
  });

  test("rejette explicitement si Apollo n'a pas encore d'identifiants web", async () => {
    apolloWebSecret = null;
    await expect(pairingStep.apply(CONFIG)).rejects.toThrow(
      /apollo-config doit s'appliquer/,
    );
    expect(spawnPair).not.toHaveBeenCalled();
  });
});

describe("apply, la relecture fait foi et non la reponse de sendPin", () => {
  test("echoue si sendPin rend true mais que la liste relue reste vide", async () => {
    // Le coeur de la garantie : /api/pin est documente comme repondant
    // parfois "c'est fait" sans qu'aucune session d'appairage n'ait ete en
    // attente. Un apply() qui croirait sendPin sur parole passerait ce test
    // a tort.
    sendPinResult = true;
    clientListAfterPin = [];
    await expect(pairingStep.apply(CONFIG)).rejects.toThrow(/Appairage non confirmé/);
  });

  test("reussit si la relecture confirme, meme quand sendPin ment par defaut", async () => {
    // Contre-epreuve : la reussite ne depend que de la relecture, jamais de
    // la reponse de sendPin.
    sendPinResult = false;
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-9" }];
    await expect(pairingStep.apply(CONFIG)).resolves.toBeUndefined();
  });
});

describe("restore", () => {
  test("depaire le client dont le nom correspond au notre", async () => {
    clientList = [{ name: "hardline-mac", uuid: "u-5" }];
    await pairingStep.restore(CONFIG, { clients: [], hostKnown: false }, NO_PENDING);
    expect(unpairClient).toHaveBeenCalledWith(
      CONFIG,
      { user: "hardline", password: "web-secret" },
      "u-5",
    );
  });

  test("retire l'entree du plist quand elle n'existait pas avant hardline", async () => {
    await pairingStep.restore(CONFIG, { clients: [], hostKnown: false }, NO_PENDING);
    expect(forgetHost).toHaveBeenCalledWith("10.10.10.1");
  });

  test("ne touche pas au plist si l'hote y figurait deja avant hardline", async () => {
    await pairingStep.restore(CONFIG, { clients: [], hostKnown: true }, NO_PENDING);
    expect(forgetHost).not.toHaveBeenCalled();
  });

  test("ne depaire rien si notre client n'apparait plus dans la liste", async () => {
    clientList = [];
    await pairingStep.restore(CONFIG, { clients: [], hostKnown: false }, NO_PENDING);
    expect(unpairClient).not.toHaveBeenCalled();
  });
});
