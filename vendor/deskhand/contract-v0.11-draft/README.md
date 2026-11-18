# deskhand

Like magic hand but for your mac desktop and the caster is some agent somewhere.

deskhand is a native macOS accessory service that lets agents running elsewhere (for example in k3s pods) take
screenshots of a Mac and drive its mouse and keyboard over MCP, served on a mutually authenticated HTTPS endpoint.
It is written in Swift 6 with strict concurrency; pure logic and the server build and test on Linux, while the
platform adapters and the app are macOS only.

## Module map

| Target | Kind | Platforms | Depends on | Role |
| --- | --- | --- | --- | --- |
| `DeskhandCore` | library | macOS, Linux | swift-crypto | Contract types and pure logic (no AppKit, ScreenCaptureKit or CryptoKit). |
| `DeskhandServer` | library | macOS, Linux | Core, SwiftNIO, NIOSSL | HTTPS + MCP JSON-RPC server. |
| `DeskhandPlatform` | library | macOS | Core | ScreenCaptureKit, CGEvent and session-state adapters. |
| `DeskhandApp` | executable | macOS | Core, Server, Platform | Accessory app that wires everything together. |
| `DeskhandLogDaemon` | executable | macOS | Core | Root LaunchDaemon that appends the action log over XPC. |
| `DeskhandTestSupport` | library (tests only) | macOS, Linux | Testing | Shared test tags and traits. |
| `DeskhandCoreTests`, `DeskhandServerTests` | tests | macOS, Linux | | Unit tests. |
| `DeskhandPlatformTests` | tests | macOS | | Platform adapter tests. |

macOS-only targets are appended to the package inside `#if os(macOS)` in `Package.swift`. On Linux they do not
exist, so plain `swift build` and `swift test` cover exactly the portable targets and need no flags. Source files in
the macOS-only targets therefore need no `#if os(macOS)` guards.

## Build and test

Requires the Swift 6.2 toolchain. macOS 15 or later on the Mac side.

```sh
swift build
swift test
swift format lint --strict --recursive Sources Tests Package.swift
```

Linux (what CI runs), with a separate build path so `.build` stays macOS-only:

```sh
docker run --rm -v "$PWD":/w -w /w swift:6.2-noble \
  bash -lc 'swift build --build-path /tmp/b && swift test --build-path /tmp/b'
```

### Tests that need a real Mac session

Tests that need a TCC grant, a logged-in GUI session or a real display carry the `requiresMacSession` tag and the
`macSessionTestsEnabled` condition, both from `DeskhandTestSupport`:

```swift
@Test(.tags(.requiresMacSession), .macSessionTestsEnabled)
func capturesMainDisplay() async throws { ... }
```

Swift Testing 6.2 has no command-line tag filter (`swift test --filter`/`--skip` match test names by regex only), so
the condition does the excluding: these tests are skipped unless `DESKHAND_MAC_SESSION_TESTS=1` is set. CI never sets
it, so `swift test` is the whole CI command. On a Mac, as part of the manual checklist:

```sh
DESKHAND_MAC_SESSION_TESTS=1 swift test
```
