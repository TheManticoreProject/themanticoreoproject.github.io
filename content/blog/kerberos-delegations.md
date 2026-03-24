---
title: "Active Directory - Auditing and managing Kerberos delegations with Delegations"
date: 2025-06-02T10:00:00Z
description: "Presenting Delegations, a cross-platform Go tool to audit, find, add, remove, clear, and monitor all types of Kerberos delegations in Active Directory."
author: "Remi GASCOU (Podalirius)"
tags: ["active-directory", "kerberos", "delegations", "ldap"]
draft: false
---

During security assessments of Active Directory environments, one of the first things I look at is Kerberos delegations. Misconfigured delegations are a well-known attack vector: an attacker who compromises a service account with unconstrained delegation can impersonate any user who authenticates to that service. Constrained delegations and resource-based constrained delegations (RBCD) are safer, but they still require careful configuration.

The problem is that existing tools often only cover one side of the coin: they can find delegations, but not modify them. Or they can set up RBCD for exploitation, but not audit the full picture. I wanted a single tool that could audit, find, add, remove, clear, and monitor all three types of Kerberos delegations from a single binary, on any platform.

To support this, I wrote **Delegations**.

## Background on Kerberos delegations

There are three types of Kerberos delegations in Active Directory. Each involves different LDAP attributes and `userAccountControl` flags.

### Unconstrained delegation

When unconstrained delegation is enabled on an account, the `UAF_TRUSTED_FOR_DELEGATION` flag is set in the `userAccountControl` attribute. This allows the service to impersonate any user to any service on any computer.

By default, domain controllers have this flag set. Any other account with this flag is suspicious and should be investigated.

### Constrained delegation

Constrained delegation restricts which services the account can delegate to. The allowed target SPNs are stored in the `msDS-AllowedToDelegateTo` attribute. An optional "protocol transition" capability is controlled by the `UAF_TRUSTED_TO_AUTH_FOR_DELEGATION` flag in `userAccountControl`. When protocol transition is enabled, the service can obtain a ticket on behalf of a user without that user authenticating to the service first.

### Resource-based constrained delegation (RBCD)

RBCD inverts the trust model. Instead of the delegating account specifying where it can delegate to, the target resource specifies which accounts can delegate to it. This is controlled by the `msDS-AllowedToActOnBehalfOfOtherIdentity` attribute, which contains a security descriptor with the SIDs of allowed accounts.

## Delegations: a single tool for all delegation types

Delegations is a cross-platform tool written in Go. It uses the [Manticore](https://github.com/TheManticoreProject/Manticore) library for LDAP connectivity and authentication, and the [winacl](https://github.com/TheManticoreProject/winacl) library for parsing security descriptors in RBCD configurations.

The tool supports NTLM and Kerberos authentication, plain LDAP and LDAPS, and works on Windows, Linux, and macOS.

## Installation

You can download pre-compiled binaries from the [GitHub release page](https://github.com/TheManticoreProject/Delegations/releases), or install directly with Go:

```bash
$ go install github.com/TheManticoreProject/Delegations@latest
```

## Usage

The first positional argument selects the mode:

```
$ ./Delegations
Delegations - by Remi GASCOU (Podalirius) @ TheManticoreProject - v1.0.0

Usage: Delegations <add|audit|clear|find|monitor|remove>

   add      Add a constrained, unconstrained, or resource-based constrained delegation to a user or group.
   audit    Audit constrained, unconstrained, and resource-based constrained delegations in Active Directory.
   clear    Clear a constrained, unconstrained, or resource-based constrained delegation from a user or group.
   find     Find a constrained, unconstrained, or resource-based constrained delegation from a user or group.
   monitor  Monitor constrained, unconstrained, and resource-based constrained delegations in Active Directory.
   remove   Remove a constrained, unconstrained, or resource-based constrained delegation from a user or group.
```

For the `add`, `remove`, `find`, and `clear` modes, the second positional argument selects the delegation type:

```
$ ./Delegations add
Delegations - by Remi GASCOU (Podalirius) @ TheManticoreProject - v1.0.0

Usage: Delegations add <constrained|rbcd|unconstrained>

   constrained    Add a constrained delegation to a computer, user or group.
   unconstrained  Add a unconstrained delegation to a computer, user or group.
   rbcd           Add a ressource-based delegation to a computer, user or group.
```

All modes require standard authentication options:

```
$ ./Delegations audit
Delegations - by Remi GASCOU (Podalirius) @ TheManticoreProject - v1.0.0

Usage: Delegations audit --domain <string> --username <string> [--password <string>] [--hashes <string>] [--debug] --dc-ip <string> [--ldap-port <tcp port>] [--use-ldaps] [--use-kerberos]


  Authentication:
    -d, --domain <string>   Active Directory domain to authenticate to.
    -u, --username <string> User to authenticate as.
    -p, --password <string> Password to authenticate with. (default: "")
    -H, --hashes <string>   NT/LM hashes, format is LMhash:NThash. (default: "")

  Configuration:
    -d, --debug     Debug mode. (default: false)

  LDAP Connection Settings:
    -dc, --dc-ip <string>       IP Address of the domain controller or KDC (Key Distribution Center) for Kerberos. If omitted, it will use the domain part (FQDN) specified in the identity parameter.
    -lp, --ldap-port <tcp port> Port number to connect to LDAP server. (default: 389)
    -L, --use-ldaps             Use LDAPS instead of LDAP. (default: false)
    -k, --use-kerberos          Use Kerberos instead of NTLM. (default: false)
```

## Auditing all delegations at once

The `audit` mode queries the domain for all three types of delegations in a single run. This is the mode I use first during an assessment to get a full picture of the delegation landscape.

```bash
$ ./Delegations audit --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!"
```

The tool performs three LDAP queries:

1. **Unconstrained delegations**: Objects with the `UAF_TRUSTED_FOR_DELEGATION` flag set. Domain controllers are flagged as "Legitimate", while any other object is flagged as "Suspicious".
2. **Constrained delegations**: Objects with a non-empty `msDS-AllowedToDelegateTo` attribute. The tool also checks whether each target SPN actually exists in the directory.
3. **Resource-based constrained delegations**: Objects with a non-empty `msDS-AllowedToActOnBehalfOfOtherIdentity` attribute. The tool parses the embedded security descriptor and resolves each SID to its distinguished name.

The output uses a tree structure with colour-coded results, making it easy to spot misconfigurations at a glance.

## Finding delegations on a specific object

The `find` mode checks a single object for a specific type of delegation:

```bash
$ ./Delegations find constrained --distinguished-name "CN=PC01,CN=Computers,DC=MANTICORE,DC=local" --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!"
```

This is useful when you already have a target in mind and want to quickly check its delegation configuration.

## Adding delegations

The `add` mode sets up a delegation on an object. This is particularly useful for testing RBCD attack paths or for demonstrating the impact of a misconfiguration to a client.

Adding a constrained delegation:

```bash
$ ./Delegations add constrained --distinguished-name "CN=PC01,CN=Computers,DC=MANTICORE,DC=local" --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!" --allowed-to-delegate-to "HOST/PC02.MANTICORE.local"
```

Adding a constrained delegation with protocol transition:

```bash
$ ./Delegations add constrained --distinguished-name "CN=PC01,CN=Computers,DC=MANTICORE,DC=local" --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!" --allowed-to-delegate-to "HOST/PC02.MANTICORE.local" --with-protocol-transition
```

Adding an unconstrained delegation:

```bash
$ ./Delegations add unconstrained --distinguished-name "CN=PC01,CN=Computers,DC=MANTICORE,DC=local" --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!"
```

Adding a resource-based constrained delegation:

```bash
$ ./Delegations add rbcd --distinguished-name "CN=PC01,CN=Computers,DC=MANTICORE,DC=local" --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!"
```

## Removing and clearing delegations

The `remove` mode removes a specific delegation entry from an object, while the `clear` mode removes all delegation configuration of a given type.

Removing a specific constrained delegation:

```bash
$ ./Delegations remove constrained --distinguished-name "CN=PC01,CN=Computers,DC=MANTICORE,DC=local" --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!" --allowed-to-delegate-to "HOST/PC02.MANTICORE.local"
```

Clearing all constrained delegations from an object:

```bash
$ ./Delegations clear constrained --distinguished-name "CN=PC01,CN=Computers,DC=MANTICORE,DC=local" --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!"
```

The same pattern applies to `unconstrained` and `rbcd` delegation types.

## Managing protocol transition

Protocol transition can be added or removed independently from the constrained delegation itself:

```bash
$ ./Delegations add protocoltransition --distinguished-name "CN=PC01,CN=Computers,DC=MANTICORE,DC=local" --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!"
```

```bash
$ ./Delegations remove protocoltransition --distinguished-name "CN=PC01,CN=Computers,DC=MANTICORE,DC=local" --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!"
```

## Monitoring delegations in real-time

The `monitor` mode is one of the features I find most useful in practice. It takes a snapshot of all delegation-related attributes across the domain, then continuously polls for changes.

```bash
$ ./Delegations monitor --dc-ip "192.168.56.101" -d "MANTICORE.local" -u "Administrator" -p "Admin123!"
```

The monitor tracks:

- New objects created in the directory
- Deleted objects
- Changes to the `UAF_TRUSTED_FOR_DELEGATION` flag (unconstrained delegation)
- Changes to the `UAF_TRUSTED_TO_AUTH_FOR_DELEGATION` flag (protocol transition)
- Added or removed values in `msDS-AllowedToDelegateTo` (constrained delegation)
- Added or removed SIDs in `msDS-AllowedToActOnBehalfOfOtherIdentity` (RBCD)

This is particularly valuable during red team engagements where you want to detect defensive actions, or during blue team exercises where you want to catch delegation changes as they happen.

## How it works under the hood

The tool constructs targeted LDAP queries for each delegation type. For example, to find constrained delegations without protocol transition, it uses:

- `(objectClass=computer)` or `(objectClass=person)` or `(objectClass=user)` to scope the search
- `(msDS-AllowedToDelegateTo=*)` to find objects with constrained delegation configured
- `(!(userAccountControl:1.2.840.113556.1.4.803:=16777216))` to exclude objects with the `UAF_TRUSTED_TO_AUTH_FOR_DELEGATION` flag

For RBCD, the tool retrieves the raw `msDS-AllowedToActOnBehalfOfOtherIdentity` attribute, which contains a binary `NtSecurityDescriptor` structure. It parses the DACL entries using the [winacl](https://github.com/TheManticoreProject/winacl) library and resolves each SID to its distinguished name via a reverse LDAP lookup.

## References

- [Delegations on GitHub](https://github.com/TheManticoreProject/Delegations)
- [Manticore library](https://github.com/TheManticoreProject/Manticore)
- [winacl library](https://github.com/TheManticoreProject/winacl)
- [Microsoft documentation: Kerberos Constrained Delegation](https://learn.microsoft.com/en-us/windows-server/security/kerberos/kerberos-constrained-delegation-overview)
- [Microsoft documentation: userAccountControl flags](https://learn.microsoft.com/en-us/troubleshoot/windows-server/active-directory/useraccountcontrol-manipulate-account-properties)
