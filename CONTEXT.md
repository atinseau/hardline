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
The dedicated physical Ethernet path through which Hardline operates the paired Windows PC. Other connectivity may locate the PC, but carries no operational SSH traffic or machine mutation.
_Avoid_: Network connection, control network, fallback link

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
