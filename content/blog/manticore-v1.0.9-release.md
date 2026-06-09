---
title: "Manticore v1.0.9 - Complete SMBv1, NDR 2.0, and the first RPC interfaces"
date: 2026-06-09T12:46:25Z
description: "A look at Manticore v1.0.9: a fully working SMBv1 client, a generic NDR 2.0 marshalling engine for DCE/RPC, and the first batch of RPC interfaces (LSARPC, SAMR, SRVSVC, EFSR, SVCCTL, WINREG)."
author: "Remi GASCOU (Podalirius)"
tags: ["manticore", "smb", "dcerpc", "ndr", "release", "go"]
draft: false
---

We tagged [Manticore v1.0.9](https://github.com/TheManticoreProject/Manticore/releases/tag/v1.0.9) today. The release title is *complete working SMBv1, NDR 2.0, and a bit of RPC*, and that is a fair summary of where the bulk of the work went. It is the largest release the library has shipped so far, with several hundred merged pull requests. The practical result is that Manticore can now drive an SMBv1 session and DCE/RPC calls end to end.

This post walks through what changed, grouped by area.

## A working SMBv1 client

The main outcome of this release is that the SMBv1 stack now works against real servers. The changelog shows what that took: well over a hundred fixes that look small on their own but together are what make a Windows server accept the messages we send.

Most of these fixes fall into a few recurring categories.

### Endianness

SMBv1 is an old protocol and its fields are not laid out consistently on the wire. The most common bug fixed in this release was an integer marshalled big-endian where the protocol expects little-endian, and in a few cases the reverse. We went command by command and corrected the wire encoding for parameters across `CreateRequest`, `WriteAndx`, `ReadRequest` and `ReadResponse`, `OpenAndx`, the `Transaction` and `Transaction2` families, `NtTransact`, the locking commands, the find and search commands, the print-file commands, and many more. If you tried SMBv1 in an earlier release and got unexplained `STATUS_INVALID_PARAMETER` errors, this is the reason.

### Time fields and buffer formats

The next recurring fix was the encoding of time fields. Several commands use a 4-byte `UTIME` or a 2-byte DOS time where we had previously emitted an 8-byte `FILETIME`. `CreateRequest`, `CreateNewRequest`, `CreateTemporaryRequest`, `OpenAndxRequest`, `WriteAndCloseRequest`, `SetInformationRequest`, and the query and set information responses all had their time fields corrected to the sizes the protocol requires.

A number of commands also require an explicit `BufferFormat` byte (`0x04` for a null-terminated string, `0x05` for a variable block) before their string or data fields. `QueryInformationRequest`, `OpenRequest`, the `SMB_COM_NEGOTIATE` dialect list, and the `FindResponse` data block were all fixed to emit these markers correctly.

### Hardening against malformed input

Parsing untrusted bytes off the wire is a common source of memory-safety bugs, even in Go. This release fixes a long list of out-of-range panics and nil-pointer dereferences in `Unmarshal` paths: short `ServerGUID` in `NegotiateResponse`, 1-byte input to `Data.Unmarshal`, odd-length input to `GetNullTerminatedUnicodeString`, short input to `SMB_FILE_ATTRIBUTES` and `SMB_STRING`, `TreeConnect` and `SessionSetup` called without a session or credentials, and `WriteAndxRequest` going out of bounds on `DataLength`. We also fixed an unbounded allocation in the Direct TCP transport's `Receive`, where an attacker-controlled length could force a very large allocation.

A couple of these were security issues rather than robustness fixes. The most notable was placeholder passwords being sent in plaintext on the SMB1 auth path.

### The SMBv1 client API

On top of the corrected message layer, the client now exposes a usable file API. New in this release:

- **File I/O**: `ReadFile` and `WriteFile`, with the 64-bit offset truncation bug fixed so large files work.
- **Directory enumeration**: `FindFiles`, built on the `TRANS2_FIND_FIRST2` and `TRANS2_FIND_NEXT2` subcommands.
- **File management**: create, delete, and rename operations, plus `Seek`, `NtRename`, `CreateHardLink`, `Flush`, and `Echo`.
- **Byte-range locking** operations.
- **TRANS2 query and set** for file and filesystem information levels.
- **Session and tree management**: session registration and reuse via `Connection.SessionTable`, and the teardown methods that were previously missing and leaking resources.
- **SMB message signing**, including making session setup work against signing-required servers.
- **Multi-message Transaction2 reassembly**, so responses fragmented across `TRANSACTION2_SECONDARY` messages are stitched back together, and large requests are fragmented on send.

We also implemented the full set of information levels (`SET_FILE`, `QUERY_FILE`, `FIND_FILE`, filesystem, and the legacy and EA levels), plus the reserved and obsolete command stubs such as `SMB_COM_COPY`, `SMB_COM_MOVE`, and the bulk read and write commands, so the message dispatch table is complete. The extended responses for `NT_CREATE_ANDX` and `TREE_CONNECT_ANDX` are implemented, along with server-side copy (`FSCTL_SRV_COPYCHUNK`), snapshot enumeration (`FSCTL_SRV_ENUMERATE_SNAPSHOTS`), per-user quotas, change notification, and security-descriptor query and set over `NT_TRANSACT`.

## NDR 2.0: a generic marshalling engine for DCE/RPC

The second major area is DCE/RPC. Before you can call any RPC interface, you have to marshal arguments with NDR (Network Data Representation), the encoding RPC uses on the wire. Rather than hand-roll a marshaller per interface, this release adds a generic, declarative NDR engine driven by struct tags.

The work landed incrementally, and the fixes along the way are a useful list if you have worked with NDR before:

- `BOOL` aliases now encode as four octets instead of one.
- The `align=N` struct tag is honored instead of being silently ignored.
- Embedded conformant arrays are hoisted to the front of the structure.
- Conformant arrays of arbitrary element types are supported.
- Embedded `[ref]` pointers are supported.
- Referent ordering is correct for arrays of pointers and pointer-bearing structs.
- Discriminated unions are supported via declarative `switch` and `case` tags.
- Attacker-controlled array counts can no longer trigger unbounded allocation, and conformant-array size determinants are aligned to the element alignment.

The marshaller is wired into the DCE/RPC client through `Client.Invoke`, and there is now a shared set of `[MS-DTYP]` base types so interfaces can reuse the common Windows data types. On the transport side, the release adds DCE/RPC over SMB named pipes (`ncacn_np`) and restructures `network/dcerpc` by protocol version, adding the connectionless (v4) stack alongside v5.

## The first RPC interfaces

With NDR in place, the release ships the first batch of RPC interfaces. Several of them are directly useful for Active Directory work:

- **LSARPC** ([MS-LSAD] and [MS-LSAT]), all 58 methods.
- **SRVSVC** ([MS-SRVS]), all 47 methods.
- **SAMR** ([MS-SAMR]), account management.
- **EFSR** ([MS-EFSR]), the Encrypting File System Remote protocol, with raw-file methods streaming through an NDR pipe.
- **SVCCTL** ([MS-SCMR]), the Service Control Manager.
- **WINREG** ([MS-RRP]), Remote Registry.

To make adding interfaces sustainable, the release also introduces `idlgen`, a tool that parses MIDL `.idl` files and generates the Go DCE/RPC interface skeletons, including NDR pipe types and the `ndr:"pipe"` tag. It can also fetch the IDL directly from a Microsoft Open Specifications "Full IDL" page, so going from a published spec to a working Go interface is now largely mechanical.

## Kerberos, NTLMv2, and crypto improvements

Outside of SMB and RPC, several authentication and crypto components were updated.

On the **Kerberos** side, this release introduces a native `KerberosClient` with **ASREPRoast** support and no dependency on an external Kerberos library, contributed by [@0xbbuddha](https://github.com/0xbbuddha). Kerberos also moved to a dedicated `v5` directory, and we fixed a set of correctness bugs: ASN.1 `GeneralString` encoding, `AP-REQ` ticket double-wrapping in `APReq.Unmarshal`, the RC4-HMAC usage-9 remap that violated the RFC 4757 errata, RC4-HMAC `usageMsgType` little-endian encoding, and missing reply-nonce verification in `AS-REP` and `TGS-REP`. The KDC option handling was refactored into per-message builders with Active Directory client flags, and `GetTGS` now exposes the raw service ticket bytes.

On the **NTLMv2** side, also contributed by [@0xbbuddha](https://github.com/0xbbuddha), the crypto primitives were corrected, `targetinfo` helpers were added, and the WinRM authentication path was refactored. A separate fix corrected the `ComputeResponse` HMAC construction and a missing timestamp.

For **certificates and keys**, we added fingerprint functions and `ExportPEM` and `ExportDER` to the CNG and bcrypt RSA keys, improved the `X509Certificate` getters to return errors, and fixed a nil public key in certificates generated by `NewX509Certificate()`. [@Copilot](https://github.com/Copilot) contributed fixes for a potential integer overflow in the RSA private-key `ExportDER` and for unhandled `asn1.Marshal` errors.

## Smaller fixes

A few other fixes landed in this release:

- **LLMNR** got `Describe()` methods, a codebase refactor, a fix to cumulative offset tracking in `Message.Unmarshal`, correct validation of Authority and Additional names, and clearer `Flags.String` labels.
- `IsIPv6` no longer returns `true` for IPv4 addresses.
- Resource leaks and silenced errors were fixed in `GetDomainDNSServers`, and panics on empty search results were fixed in `GetNtSecurityDescriptorOf` and `GetRootDSE`.
- The `encoding` package was migrated to a dedicated submodule.

## Thanks to contributors

This release includes Manticore's first external contributions. Thanks to [@0xbbuddha](https://github.com/0xbbuddha) for the native Kerberos client, ASREPRoast, and the NTLMv2 and WinRM work, and to [@Copilot](https://github.com/Copilot) for the integer-overflow and error-handling fixes.

## Getting it

You can grab the release from the [v1.0.9 tag](https://github.com/TheManticoreProject/Manticore/releases/tag/v1.0.9), and the full diff is in the [v1.0.8...v1.0.9 comparison](https://github.com/TheManticoreProject/Manticore/compare/v1.0.8...v1.0.9).

With a working SMBv1 client and a generic NDR engine behind the first RPC interfaces, Manticore now has the foundations to build higher-level Active Directory and Windows tooling on top of the library. There is more RPC surface to cover, and `idlgen` should make the next interfaces faster to add.
