import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../fixtures/config";

const NO_PENDING = { pending: [] as string[] };
const order: string[] = [];

let apolloWebSecret: string | null = "web-secret";
let clientList: Array<{ name: string; uuid: string }> = [];
let clientListAfterPin: Array<{ name: string; uuid: string }> | null = null;
let sendPinResult = true;
let plistHosts: Array<{ address: string }> = [];
let killCalls = 0;
let forgetHostResult = true;
let pairReady: Promise<void> = Promise.resolve();

const spawnPair = mock((..._args: unknown[]) => {
  order.push("spawnPair");
  return { ready: pairReady, kill: () => { killCalls += 1; } };
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
/**
 * `moonlight list` est le seul signal fiable cote Mac : il rend 0 quand ce
 * Mac est appaire, 255 sinon. Un Mac deja appaire fait sortir
 * `moonlight pair` sans rien faire ET sans rien dire.
 */
let dejaAppaire = false;
const isPairedFromMac = mock(async (..._args: unknown[]) => dejaAppaire);
mock.module("../../src/lib/moonlight", () => ({ spawnPair, isPairedFromMac }));

const forgetHost = mock(async (..._args: unknown[]) => forgetHostResult);
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

/**
 * Sans ce mock, readRemoteState ouvrirait une VRAIE session SSH vers le PC :
 * la suite passerait ou echouerait selon que la machine est allumee, et
 * lirait un etat que le test ne controle pas.
 */
let remoteState: string | null = null;
const remoteWrites: string[] = [];
const runRemoteJson = mock(async (..._args: unknown[]) => [{ state: remoteState }]);
const runRemoteChecked = mock(async (_target: unknown, script: string) => {
  order.push("writeState");
  remoteWrites.push(script);
});
mock.module("../../src/lib/ssh", () => ({ runRemoteJson, runRemoteChecked }));

/** L'etat toxique qu'Apollo ecrit lui-meme apres un appairage. */
function etatApresAppairage(booleensEnChaines: boolean): string {
  const brut = booleensEnChaines ? "false" : false;
  return JSON.stringify({
    username: "hardline",
    root: {
      uniqueid: "U-1",
      named_devices: [
        {
          name: "hardline-mac",
          uuid: "u-1",
          cert: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n",
          perm: "117440512",
          allow_client_commands: brut,
          always_use_virtual_display: brut,
          enable_legacy_ordering: brut,
        },
      ],
    },
  });
}

const { pairingStep } = await import("../../src/steps/pairing");

beforeEach(() => {
  order.length = 0;
  apolloWebSecret = "web-secret";
  clientList = [];
  clientListAfterPin = null;
  sendPinResult = true;
  plistHosts = [];
  killCalls = 0;
  forgetHostResult = true;
  pairReady = Promise.resolve();
  dejaAppaire = false;
  isPairedFromMac.mockClear();
  listClients.mockImplementation(async () => {
    order.push("listClients");
    return clientListAfterPin ?? clientList;
  });
  remoteState = null;
  remoteWrites.length = 0;
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
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

  test("attend que Moonlight soit prêt avant d'envoyer le PIN", async () => {
    const ready = Promise.withResolvers<void>();
    pairReady = ready.promise;
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];

    const applying = pairingStep.apply(CONFIG);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendPin).not.toHaveBeenCalled();

    ready.resolve();
    await applying;
    expect(sendPin).toHaveBeenCalledTimes(1);
  });

  /**
   * La sequence de la spec est intacte : pair, puis pin, puis relecture. Elle
   * est seulement precedee d'une sonde, qui attend qu'Apollo reponde apres le
   * redemarrage que vient de lui infliger apollo-config. La sonde LIT, elle
   * n'appaire pas — l'ordre impose commence a spawnPair.
   */
  test("respecte l'ordre impose par la spec : pair, puis pin, puis relecture", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];
    await pairingStep.apply(CONFIG);
    expect(order).toEqual(["listClients", "spawnPair", "sendPin", "listClients"]);
    expect(order.slice(order.indexOf("spawnPair"))).toEqual([
      "spawnPair",
      "sendPin",
      "listClients",
    ]);
  });

  test("ne relit la liste qu'une fois passe l'envoi du code, la sonde mise a part", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];
    await pairingStep.apply(CONFIG);
    const apresPin = order.slice(order.indexOf("sendPin"));
    expect(apresPin.filter((e) => e === "listClients")).toHaveLength(1);
  });

  /**
   * Un serveur muet au premier essai ne doit pas faire echouer l'etape : c'est
   * le cas nominal juste apres un redemarrage du service.
   */
  test("attend qu'Apollo reponde avant d'ouvrir une session d'appairage", async () => {
    // Un seul refus : chaque refus coute une vraie attente de sonde, et un
    // suffit a prouver que l'etape reessaie au lieu d'abandonner.
    let refus = 1;
    listClients.mockImplementation(async () => {
      order.push("listClients");
      if (refus-- > 0) throw new Error("Unable to connect");
      return clientListAfterPin ?? clientList;
    });
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];

    await pairingStep.apply(CONFIG);

    expect(order.indexOf("spawnPair")).toBeGreaterThan(1);
    expect(order.slice(order.indexOf("spawnPair"))).toEqual([
      "spawnPair",
      "sendPin",
      "listClients",
    ]);
  });

  test("rejette explicitement si Apollo n'a pas encore d'identifiants web", async () => {
    apolloWebSecret = null;
    await expect(pairingStep.apply(CONFIG)).rejects.toThrow(
      /apollo-config doit s'appliquer/,
    );
    expect(spawnPair).not.toHaveBeenCalled();
  });
});

describe("apply, le processus Moonlight est toujours arrete", () => {
  test("arrete le processus de pairage quand l'appairage reussit", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-4" }];
    await pairingStep.apply(CONFIG);
    expect(killCalls).toBe(1);
  });

  test("arrete le processus de pairage meme quand la relecture ne confirme rien", async () => {
    clientListAfterPin = [];
    await expect(pairingStep.apply(CONFIG)).rejects.toThrow(/Appairage non confirmé/);
    expect(killCalls).toBe(1);
  });

  test("arrete le processus de pairage meme quand sendPin leve", async () => {
    sendPin.mockImplementationOnce(async () => {
      order.push("sendPin");
      throw new Error("panne reseau");
    });
    await expect(pairingStep.apply(CONFIG)).rejects.toThrow(/panne reseau/);
    expect(killCalls).toBe(1);
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

  test("ne rend rien (restauration vue) quand la suppression du plist est confirmee", async () => {
    forgetHostResult = true;
    const outcome = await pairingStep.restore(CONFIG, { clients: [], hostKnown: false }, NO_PENDING);
    expect(outcome).toBeUndefined();
  });

  test("rend un yielded explicite, jamais un succes silencieux, quand la suppression du plist echoue", async () => {
    // Le coeur de la garantie : forgetHost() peut echouer sans lever (elle
    // rend false). Un restore() qui ignorerait cette valeur et rendrait
    // quand meme undefined mentirait sur l'etat reel du Mac.
    forgetHostResult = false;
    const outcome = await pairingStep.restore(CONFIG, { clients: [], hostKnown: false }, NO_PENDING);
    expect(outcome).not.toBeUndefined();
    expect((outcome as { yielded: string }).yielded).toMatch(/Moonlight/);
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

  test("ne depaire pas un client different du notre, meme quand la liste n'est pas vide", async () => {
    clientList = [{ name: "autre-appareil", uuid: "u-6" }];
    await pairingStep.restore(CONFIG, { clients: [], hostKnown: true }, NO_PENDING);
    expect(unpairClient).not.toHaveBeenCalled();
  });
});

describe("restore, le volet Mac n'est jamais pris en otage par le volet PC", () => {
  test("oublie l'hote meme quand la liste des clients leve", async () => {
    // Apollo arrete alors que le PC repond encore en SSH. Sans isolement, la
    // levee remontait, apollo-config effacait ensuite le secret apollo-web, et
    // la desinstallation suivante ne pouvait plus jamais depairer ni oublier.
    listClients.mockImplementationOnce(async () => {
      throw new Error("Apollo ne repond pas");
    });

    const outcome = await pairingStep.restore(
      CONFIG,
      { clients: [], hostKnown: false },
      NO_PENDING,
    );

    expect(forgetHost).toHaveBeenCalledWith("10.10.10.1");
    expect((outcome as { yielded: string }).yielded).toContain("Apollo ne repond pas");
  });

  test("oublie l'hote meme quand le secret Apollo a deja disparu du trousseau", async () => {
    apolloWebSecret = null;

    const outcome = await pairingStep.restore(
      CONFIG,
      { clients: [], hostKnown: false },
      NO_PENDING,
    );

    expect(forgetHost).toHaveBeenCalledWith("10.10.10.1");
    expect(outcome).not.toBeUndefined();
  });

  test("ne leve jamais pour un echec cote PC, et n'appelle pas le depairage", async () => {
    listClients.mockImplementationOnce(async () => {
      throw new Error("Apollo ne repond pas");
    });

    await expect(
      pairingStep.restore(CONFIG, { clients: [], hostKnown: false }, NO_PENDING),
    ).resolves.not.toBeUndefined();
    expect(unpairClient).not.toHaveBeenCalled();
  });

  test("nomme les DEUX volets quand aucun des deux n'a pu etre mene a bien", async () => {
    listClients.mockImplementationOnce(async () => {
      throw new Error("Apollo ne repond pas");
    });
    forgetHostResult = false;

    const outcome = await pairingStep.restore(
      CONFIG,
      { clients: [], hostKnown: false },
      NO_PENDING,
    );

    const yielded = (outcome as { yielded: string }).yielded;
    expect(yielded).toContain("Apollo ne repond pas");
    expect(yielded).toContain("Moonlight");
  });

  test("ne cede rien quand le PC a repondu et que le plist a ete nettoye", async () => {
    clientList = [{ name: "hardline-mac", uuid: "u-7" }];
    const outcome = await pairingStep.restore(
      CONFIG,
      { clients: [], hostKnown: false },
      NO_PENDING,
    );
    expect(unpairClient).toHaveBeenCalled();
    expect(outcome).toBeUndefined();
  });
});

/**
 * Le contournement du defaut d'Apollo 0.4.6 mesure sur la machine : les trois
 * booleens du client appaire sont ecrits en CHAINES, et Apollo meurt au
 * demarrage suivant. Voir src/lib/apollo-state.ts pour la table de decision.
 */
describe("désamorçage de l'état Apollo", () => {
  test("inspect déclare non conforme un état toxique, sans interroger l'API", async () => {
    clientList = [{ name: "hardline-mac", uuid: "u-1" }];
    remoteState = etatApresAppairage(true);

    const state = await pairingStep.inspect(CONFIG);

    expect(state.conforming).toBe(false);
    expect(state.detail).toContain("désamorcer");
    // Apollo est mort quand cet etat existe : l'interroger echouerait.
    expect(listClients).not.toHaveBeenCalled();
  });

  test("inspect reste conforme quand l'état est déjà sain", async () => {
    clientList = [{ name: "hardline-mac", uuid: "u-1" }];
    remoteState = etatApresAppairage(false);

    const state = await pairingStep.inspect(CONFIG);

    expect(state.conforming).toBe(true);
    expect(listClients).toHaveBeenCalled();
  });

  test("inspect ne bute pas sur un état absent", async () => {
    clientList = [{ name: "hardline-mac", uuid: "u-1" }];
    remoteState = null;

    expect((await pairingStep.inspect(CONFIG)).conforming).toBe(true);
  });

  test("apply réécrit l'état avec de vrais booléens, après l'appairage", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-1" }];
    remoteState = etatApresAppairage(true);

    await pairingStep.apply(CONFIG);

    expect(remoteWrites).toHaveLength(1);
    // Les booleens nus, jamais les chaines d'origine. Les guillemets sont
    // echappes en `" par psDoubleQuote : l'assertion les prend tels quels,
    // ce qui verifie du meme coup que l'echappement a bien eu lieu.
    expect(remoteWrites[0]).toContain('`"allow_client_commands`": false');
    expect(remoteWrites[0]).not.toContain('`"allow_client_commands`": `"false`"');
    // Et ne jamais perdre le certificat, dont l'absence plante aussi Apollo.
    expect(remoteWrites[0]).toContain("BEGIN CERTIFICATE");
    expect(order.indexOf("writeState")).toBeGreaterThan(order.indexOf("listClients"));
  });

  test("apply n'écrit rien quand l'état est déjà sain", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-1" }];
    remoteState = etatApresAppairage(false);

    await pairingStep.apply(CONFIG);

    expect(remoteWrites).toHaveLength(0);
  });

  test("un appairage non confirmé lève sans toucher à l'état", async () => {
    clientListAfterPin = [];
    remoteState = etatApresAppairage(true);

    await expect(pairingStep.apply(CONFIG)).rejects.toThrow(/non confirmé/);
    expect(remoteWrites).toHaveLength(0);
    expect(killCalls).toBe(1);
  });
});

describe("Mac déjà appairé sous un autre nom", () => {
  test("nomme la cause réelle au lieu d'échouer sur « n'apparaît pas »", async () => {
    dejaAppaire = true;
    clientList = [{ name: "Mac", uuid: "u-ancien" }];

    await expect(pairingStep.apply(CONFIG)).rejects.toThrow(/déjà appairé à ce PC/);
    // Aucun appairage n'est tenté : il ne pourrait qu'échouer en silence.
    expect(spawnPair).not.toHaveBeenCalled();
    expect(sendPin).not.toHaveBeenCalled();
  });

  test("le message nomme les clients à retirer", async () => {
    dejaAppaire = true;
    clientList = [{ name: "Mac", uuid: "u-1" }, { name: "Salon", uuid: "u-2" }];

    await expect(pairingStep.apply(CONFIG)).rejects.toThrow(/Mac.*Salon/s);
  });

  /**
   * hardline ne dépaire JAMAIS de lui-même : ces appairages sont antérieurs
   * et appartiennent à l'utilisateur.
   */
  test("ne dépaire rien de lui-même", async () => {
    dejaAppaire = true;
    clientList = [{ name: "Mac", uuid: "u-1" }];

    await expect(pairingStep.apply(CONFIG)).rejects.toThrow();
    expect(unpairClient).not.toHaveBeenCalled();
  });

  test("un Mac non appairé suit le chemin nominal", async () => {
    dejaAppaire = false;
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];

    await pairingStep.apply(CONFIG);
    expect(spawnPair).toHaveBeenCalled();
  });
});
