---
title: "Go - Building CLI tools with goopts, a command-line argument parsing library"
date: 2025-05-20T10:00:00Z
description: "Presenting goopts, a cross-platform Go library for parsing command-line arguments with support for subcommands, argument groups, mutually exclusive options, and multiple value types."
author: "Remi GASCOU (Podalirius)"
tags: ["go", "cli", "library", "command-line"]
draft: false
---

When I started building security tools in Go for The Manticore Project, I quickly ran into a recurring problem. Every tool needed argument parsing: authentication flags, LDAP connection settings, debug options, positional arguments for modes and subcommands. Go's standard `flag` package handles simple cases, but it does not support argument groups, subcommands, mutually exclusive options, or even required arguments.

I looked at existing libraries. Some were too minimal, others tried to do too much and imposed heavy conventions on how you structure your code. None of them felt right for the kind of tools I was building: security tools with multiple modes (like `audit`, `add`, `remove`), each with their own set of arguments, and common argument groups for authentication and LDAP settings.

To support this, I wrote **goopts**.

## What goopts provides

goopts is a command-line argument parsing library for Go. It is designed to handle the argument parsing needs of complex CLI tools while keeping the API straightforward. The core features are:

- **Eight argument types**: booleans, strings, integers, integer ranges, TCP ports, lists of strings, lists of integers, and maps of HTTP headers.
- **Positional arguments**: string, integer, and boolean positionals that are consumed in order before named arguments.
- **Argument groups**: logical groupings of related arguments (e.g. "Authentication", "LDAP Connection Settings") that appear together in the help output.
- **Mutually exclusive groups**: groups where at most one argument (or exactly one, if required) can be provided.
- **Dependent argument groups**: groups where if any argument is set, all arguments in the group must be set.
- **Subparsers**: multi-level subcommand support, allowing patterns like `tool add constrained --flag value`.
- **Automatic help generation**: `-h` and `--help` flags are handled automatically at every level.

## Installation

```bash
$ go get github.com/TheManticoreProject/goopts
```

## A basic example

The simplest use case is a tool with a few flags and positional arguments. Here is a complete example:

```go
package main

import (
    "fmt"

    "github.com/TheManticoreProject/goopts/parser"
)

var (
    filePath string
    verbose  bool
    port     int
)

func parseArgs() {
    ap := parser.NewParser("mytool v1.0 - by Remi GASCOU (Podalirius)")

    ap.NewStringPositionalArgument(&filePath, "filepath", "Path to the input file.")
    ap.NewBoolArgument(&verbose, "-v", "--verbose", false, "Enable verbose output.")
    ap.NewTcpPortArgument(&port, "-p", "--port", 8080, false, "Port number to listen on.")

    ap.Parse()
}

func main() {
    parseArgs()
    fmt.Printf("File: %s, Verbose: %t, Port: %d\n", filePath, verbose, port)
}
```

Running `./mytool --help` produces a formatted help message with the banner, positional arguments, and named arguments grouped together.

## Argument types

goopts supports eight argument types. Each type handles parsing, validation, and default values.

| Type | Method | Description |
|---|---|---|
| Boolean | `NewBoolArgument` | Toggle flag, value is `!defaultValue` when present |
| String | `NewStringArgument` | Single string value |
| Integer | `NewIntArgument` | Integer with support for hex (`0x`), octal (`0o`), and binary (`0b`) prefixes |
| Integer Range | `NewIntRangeArgument` | Integer validated against a `[min, max]` range |
| TCP Port | `NewTcpPortArgument` | Integer validated against the `[0, 65535]` range |
| List of Strings | `NewListOfStringsArgument` | Repeatable flag, each occurrence appends to a slice |
| List of Integers | `NewListOfIntsArgument` | Repeatable flag for integer values |
| Map of HTTP Headers | `NewMapOfHttpHeadersArgument` | Parses `Key: Value` format, splits on first colon |

All argument types except booleans accept a `required` parameter. When an argument is required but not provided, the parser prints an error message and the usage.

## Argument groups

In security tools, arguments naturally fall into groups. Authentication options (`--domain`, `--username`, `--password`, `--hashes`) belong together. LDAP connection settings (`--dc-ip`, `--ldap-port`, `--use-ldaps`) belong together. goopts makes this explicit:

```go
ap := parser.NewParser("Delegations - by Remi GASCOU (Podalirius) @ TheManticoreProject - v1.0.0")

groupAuth, _ := ap.NewArgumentGroup("Authentication")
groupAuth.NewStringArgument(&authDomain, "-d", "--domain", "", true, "Active Directory domain to authenticate to.")
groupAuth.NewStringArgument(&authUsername, "-u", "--username", "", true, "User to authenticate as.")
groupAuth.NewStringArgument(&authPassword, "-p", "--password", "", false, "Password to authenticate with.")
groupAuth.NewStringArgument(&authHashes, "-H", "--hashes", "", false, "NT/LM hashes, format is LMhash:NThash.")

groupLdap, _ := ap.NewArgumentGroup("LDAP Connection Settings")
groupLdap.NewStringArgument(&dcIp, "-dc", "--dc-ip", "", true, "IP Address of the domain controller.")
groupLdap.NewTcpPortArgument(&ldapPort, "-lp", "--ldap-port", 389, false, "Port number to connect to LDAP server.")
groupLdap.NewBoolArgument(&useLdaps, "-L", "--use-ldaps", false, "Use LDAPS instead of LDAP.")
groupLdap.NewBoolArgument(&useKerberos, "-k", "--use-kerberos", false, "Use Kerberos instead of NTLM.")
```

The help output displays each group with its own header, making it easy for users to understand which arguments are related.

## Mutually exclusive and dependent groups

Some argument combinations do not make sense together. For example, you might want the user to provide either a password or an NT hash, but not both. goopts supports this with mutually exclusive groups:

```go
groupCreds, _ := ap.NewRequiredMutuallyExclusiveArgumentGroup("Credentials")
groupCreds.NewStringArgument(&password, "-p", "--password", "", false, "Password to authenticate with.")
groupCreds.NewStringArgument(&hashes, "-H", "--hashes", "", false, "NT/LM hashes.")
```

With `NewRequiredMutuallyExclusiveArgumentGroup`, the parser enforces that exactly one of the arguments in the group is provided. With `NewNotRequiredMutuallyExclusiveArgumentGroup`, at most one is allowed but none is also valid.

Dependent groups work the other way: if any argument in the group is set, all arguments in the group must be set:

```go
groupProxy, _ := ap.NewDependentArgumentGroup("Proxy Settings")
groupProxy.NewStringArgument(&proxyHost, "", "--proxy-host", "", false, "Proxy hostname.")
groupProxy.NewTcpPortArgument(&proxyPort, "", "--proxy-port", 8080, false, "Proxy port.")
```

## Subparsers for multi-command tools

This is the feature that motivated goopts in the first place. Most of The Manticore Project's tools follow a multi-command pattern: `tool <mode> <submode> [options]`. For example, `Delegations add constrained --distinguished-name "..." --dc-ip "..."`.

goopts supports this with nested subparsers:

```go
ap := parser.NewParser("Delegations - by Remi GASCOU (Podalirius) @ TheManticoreProject - v1.0.0")
ap.SetupSubParsing("mode", &mode, true)

subAdd := ap.AddSubParser("add", "Add a delegation to a computer, user or group.")
subAdd.SetupSubParsing("delegationType", &delegationType, true)

subAddConstrained := subAdd.AddSubParser("constrained", "Add a constrained delegation.")
subAddConstrained.NewStringArgument(&distinguishedName, "-D", "--distinguished-name", "", true, "DN of the target object.")

subAddUnconstrained := subAdd.AddSubParser("unconstrained", "Add an unconstrained delegation.")
subAddUnconstrained.NewStringArgument(&distinguishedName, "-D", "--distinguished-name", "", true, "DN of the target object.")

subAudit := ap.AddSubParser("audit", "Audit all delegations in Active Directory.")
```

Each subparser is a full `ArgumentsParser` with its own arguments, groups, and even nested subparsers. The `SetupSubParsing` method configures which variable receives the selected subcommand name. The `caseInsensitive` parameter controls whether subcommand matching is case-sensitive.

When the user runs `./Delegations add`, the parser routes to the `add` subparser and displays its available subcommands. When they run `./Delegations add constrained --help`, the parser routes two levels deep and displays the help for the `constrained` subparser.

## How parsing works

The parsing flow is:

1. The parser first checks for `-h` or `--help` and displays usage if found.
2. If subparsing is enabled, the first argument is consumed as the subcommand name and parsing is delegated to the matching subparser.
3. Positional arguments are consumed in order from the remaining arguments.
4. Named arguments are consumed by matching short or long names. Each argument type knows how to consume its value from the argument list.
5. After all arguments are consumed, the parser validates required arguments, mutually exclusive groups, and dependent groups.
6. If any validation fails, error messages are printed alongside the usage.

Integer arguments support multiple notations: decimal (`42`), hexadecimal (`0xFF`), octal (`0o77`), and binary (`0b1010`). This is particularly useful for security tools that deal with flags and bitmasks.

## Querying parsed arguments

After parsing, you can check whether a specific argument was provided by the user:

```go
ap.Parse()

if ap.ArgumentIsPresent("--server-port") {
    fmt.Printf("Server port was explicitly set to %d\n", serverPort)
}
```

This is useful when you need to distinguish between "the user provided the default value" and "the user did not provide this argument at all".

## Real-world usage in The Manticore Project

goopts is the argument parsing library used by every tool in The Manticore Project:

- [Delegations](https://github.com/TheManticoreProject/Delegations) uses two levels of subparsers (`mode` and `delegationType`) with authentication and LDAP connection groups.
- [FindGPPPasswords](https://github.com/TheManticoreProject/FindGPPPasswords) uses argument groups for authentication and output configuration.
- [SIDTool](https://github.com/TheManticoreProject/SIDTool) uses positional arguments for the SID value and named arguments for output format options.
- [keytab](https://github.com/TheManticoreProject/keytab) uses subparsers for different keytab operations.

The library ensures a consistent user experience across all tools: the same authentication flags, the same help format, the same error messages.

## References

- [goopts on GitHub](https://github.com/TheManticoreProject/goopts)
- [goopts documentation](https://github.com/TheManticoreProject/goopts#documentation)
- [Manticore library](https://github.com/TheManticoreProject/Manticore)
