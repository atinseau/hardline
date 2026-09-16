# Hardline

Hardline establishes and operates a reversible direct link between a Mac and a Windows PC.

## Language

**Command Run**:
A single invocation of a Hardline command, from accepted operator intent to its final operator-visible result.
_Avoid_: Command execution, session, operation

**Target Profile**:
The persisted identity and direct-link facts of one resolved Mac and Windows PC pair, revalidated before a Command Run acts on either machine.
_Avoid_: Configuration, machine profile, target config

**Bootstrap Rendezvous**:
The one-time transition from an unprepared Windows PC to a direct link that the Mac can operate through SSH, initiated by one pasted PowerShell command.
_Avoid_: Bootstrap script, manual setup

**Hardline Identity**:
The dedicated SSH identity through which the paired Mac authenticates to the paired Windows PC, independent of operator SSH identities. Hardline uses it for mutation only through the Direct Link and limits its Recovery Channel use to read-only observations.
_Avoid_: User key, default SSH key, shared SSH identity

**Direct Link**:
The path through which Hardline operates the paired Windows PC, described by one adapter on each machine and the addresses they hold on it. Other connectivity may locate the PC, but carries no operational SSH traffic or machine mutation.
_Avoid_: Network connection, control network, fallback link

**Link Kind**:
Whether Hardline owns the addressing of the Direct Link. `direct` means a free adapter at each end, where Hardline allocates and imposes a private /30 and gives it back on uninstall. `shared` means a network that existed before Hardline and will outlive it: Hardline observes that addressing and never writes to it, so there is nothing to restore.
_Avoid_: Wi-Fi mode, LAN mode, transport

**Relink**:
The adoption of a new path for an already paired Mac and PC, after the adapter named by their Target Profile stops existing. It is restricted to shared links, because adopting one requires no write on either machine; a dedicated link would have to be addressed through the Recovery Channel, which never carries mutation.
_Avoid_: Reconnect, migration, re-pairing, Link Recovery

**Dormant Link**:
A dedicated link Hardline established and still remembers while operating over a shared one. Unplugging the cable does not erase it: both interfaces keep the addressing Hardline wrote, so resuming it costs nothing but noticing. Only a dedicated link is ever dormant, because a shared one is found again by observation alone.
_Avoid_: Saved link, previous link, backup link

**Link Recovery**:
The automatic recovery of a Direct Link after address drift or collision, using the persisted Target Profile to identify the paired PC before changing either machine.
_Avoid_: Reconnect, IP refresh, network repair

**Recovery Channel**:
Connectivity outside the Direct Link that Hardline may use to identify the paired PC and collect read-only diagnostics. It never carries repair or other machine mutation.
_Avoid_: Fallback link, secondary control path, backup connection

**Apollo Rescue Backup**:
A preserved copy of an Apollo installation's user configuration made before Hardline replaces that installation, transferred to the operator's custody and intentionally left on Windows after uninstall.
_Avoid_: Hardline backup, restore point, managed backup

**Installation Catalog**:
The fixed, versioned set of external artifacts and integrity proofs distributed with a Hardline version.
_Avoid_: Machine configuration, latest release, runtime defaults
