import { test, expect, describe } from "bun:test";
import { parseHosts, containsHost } from "../../src/lib/moonlight-plist";

const WITH_HOST = JSON.stringify({
  hosts: [{ address: "10.10.10.1", name: "PC" }],
});

const EMPTY = JSON.stringify({ hosts: [] });

describe("parseHosts", () => {
  test("lit les hotes connus", () => {
    expect(parseHosts(WITH_HOST)).toEqual([{ address: "10.10.10.1" }]);
  });

  test("rend un tableau vide sans cle hosts", () => {
    expect(parseHosts(JSON.stringify({}))).toEqual([]);
  });

  test("rend un tableau vide sur une sortie vide", () => {
    expect(parseHosts("")).toEqual([]);
  });

  test("rend un tableau vide sur un JSON illisible plutot que de lever", () => {
    expect(parseHosts("pas du json")).toEqual([]);
  });

  test("ignore une entree sans adresse exploitable", () => {
    const withGap = JSON.stringify({ hosts: [{ name: "sans adresse" }] });
    expect(parseHosts(withGap)).toEqual([]);
  });
});

describe("containsHost", () => {
  test("trouve un hote present", () => {
    expect(containsHost([{ address: "10.10.10.1" }], "10.10.10.1")).toBe(true);
  });

  test("rend faux pour un hote absent", () => {
    expect(containsHost(parseHosts(EMPTY), "10.10.10.1")).toBe(false);
  });
});
