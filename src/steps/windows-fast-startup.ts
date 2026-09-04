import type { Config } from "../config";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Step } from "./types";

export type WindowsFastStartupState = {
  enabled: boolean | null;
};

const POWER_PATH = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power";
const VALUE_NAME = "HiberbootEnabled";

const INSPECT = `
$value = Get-ItemPropertyValue -Path '${POWER_PATH}' -Name '${VALUE_NAME}' -ErrorAction SilentlyContinue
[pscustomobject]@{
  enabled = if ($null -eq $value) { $null } else { [bool]$value }
}`;

const SET_VALUE = (value: number): string =>
  `New-ItemProperty -Path '${POWER_PATH}' -Name '${VALUE_NAME}' -Value ${value} -PropertyType DWord -Force | Out-Null`;

export const windowsFastStartupStep: Step<WindowsFastStartupState> = {
  name: "windows-fast-startup",
  label: "Arrêt complet compatible Wake-on-LAN (PC)",

  async inspect(config: Config) {
    const current = (await runRemoteJson<WindowsFastStartupState>(config.ssh, INSPECT))[0];
    if (!current) throw new Error("The PC returned no Fast Startup state.");
    return {
      conforming: current.enabled === false,
      current,
      detail: current.enabled === false
        ? "Fast Startup désactivé"
        : current.enabled === true
          ? "Fast Startup activé, Wake-on-LAN désarmé lors de l'arrêt"
          : "état Fast Startup absent, désactivation requise pour Wake-on-LAN",
    };
  },

  async apply(config: Config) {
    await runRemoteChecked(config.ssh, SET_VALUE(0));
  },

  async restore(config: Config, previous: WindowsFastStartupState) {
    if (previous.enabled === null) {
      await runRemoteChecked(
        config.ssh,
        `Remove-ItemProperty -Path '${POWER_PATH}' -Name '${VALUE_NAME}' -ErrorAction SilentlyContinue`,
      );
      return;
    }
    if (typeof previous.enabled !== "boolean") {
      throw new Error("The saved Fast Startup state is invalid.");
    }
    await runRemoteChecked(config.ssh, SET_VALUE(previous.enabled ? 1 : 0));
  },
};
