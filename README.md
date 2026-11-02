# Orca × Gondolin

An Orca VM-recipe plugin that provisions a **local Gondolin micro-VM per workspace**. Gondolin owns isolation and the VM; Orca owns the remote editor, terminals, agents, and managed server.

## Requirements

- Linux or macOS, Git, OpenSSH tools (`ssh`, `ssh-keygen`), and QEMU (`qemu-system-*` and `qemu-img`). Linux also needs working KVM access for hardware acceleration.
- Orca's worker runtime must provide **Node 22.19+**. No separate Node or npm installation is needed by plugin users. Authors building from source need Node 22.19+ and npm.
- Orca **1.4.246+** for the native settings panel and worker bridge, plus VM recipes, `provisioned-root` checkouts, Alpine/musl managed-server support, and the **SSH stdio-bridge fallback**. Gondolin deliberately disables SSH TCP forwarding; builds without the stdio fallback will not work. The manifest's minimum version covers the panel APIs, not a verified release boundary for stdio-bridge support.
- Network access to download Gondolin guest assets on first use (~200 MB+), Alpine packages during provisioning, and Orca's managed server at first connection.

Uses `@earendil-works/gondolin` **0.14.0**, matching the SDK in `~/code/gondolin` when this integration was built. Uses the default QEMU backend. The image is selected explicitly from plugin configuration (default `alpine-base:latest`), rather than from `GONDOLIN_DEFAULT_IMAGE` or `GONDOLIN_GUEST_DIR`. Gondolin's image-store and registry configuration still applies.

## Install

### For plugin users

1. In Orca, **Add Plugin** using the built plugin folder (`dist/` when building from this checkout). Review and approve the lifecycle commands and trusted Node worker.
2. Open **Gondolin Settings** and click **Prepare Runtime**. Wait for the confirmation. This extracts the **included adapter and dependencies** into a private host directory; it does not run npm, download packages, or require a separate Node installation.
3. Optionally select and save an image, then choose **Gondolin Sandbox** when creating a workspace from a local Git project.

**Add Plugin is not the whole setup.** Orca currently supplies neither an install hook nor the plugin's directory to VM recipes. The explicit Prepare Runtime action bridges that gap. If skipped, create fails with an instruction to open the panel. See [the API findings and packaging details](docs/packaging.md).

Host Git, OpenSSH tools and QEMU still need to be available to Orca's inherited environment. Guest image/package downloads still require network access when provisioning.

### Building from this checkout

```sh
npm ci
npm test
npm run build
```

Install the resulting **`dist/` folder**, not the source root: the build includes the locked host runtime as `runtime.json.gz`. Authors need npm to build it; users do not. No runtime dependency is fetched during panel setup. Git/catalog releases must publish the **contents of `dist/` as their installable plugin root**, including the archive; pointing Add Plugin at this source-only repository does not run the build.

`npm run install-adapter` remains an optional developer/terminal equivalent of Prepare Runtime, using the already built archive. It is **not** something Orca runs during Add Plugin and is no longer required for UI installation.

Preparation writes to `~/.local/share/orca-gondolin/`: an atomic `bin/orca-gondolin` launcher, `runtime.json` receipt, and content-addressed `runtimes/<bundle-hash>/` directories. It reuses Orca's Node-capable executable in Electron's Node mode; no shell PATH lookup for Node is needed. Re-prepare after a plugin or Orca update, especially if the Orca executable moves. Old runtimes remain available to active VMs; preparation preserves image settings and instance state.

The manifest uses the placeholder publisher `local`; change that before publishing to a catalog.

## Image configuration

Open **Gondolin Settings** from Orca's right-sidebar settings icon for this plugin:

1. Choose **Alpine Base (latest)**, or **Custom Gondolin image**.
2. For a custom image, enter a Gondolin `name[:tag]` (for example `my-dev-image:latest`) or a build UUID. Build or pull custom images on this host first. Asset directory paths and OCI/Docker references are not supported by this picker.
3. Click **Save configuration**. The panel confirms the saved image or displays an error.

Custom images must be **Alpine-based**, include Gondolin's guest/SSH helpers, and allow `apk` installation of the required development tools. Selection does not validate image availability or boot it; resolution and compatibility failures are reported when creating a sandbox.

The selection is a host-wide default for this adapter, shared across Orca profiles using it. It applies **only to new sandboxes**; existing and already-starting VMs retain their image. The selected image is also recorded in each VM result's `userData.image`.

The panel uses Orca's native controls, but deliberately keeps its configuration in `~/.local/share/orca-gondolin/config.json`, not in Orca's settings database. A small trusted worker reads/writes that file on panel requests, and the prepared bundled lifecycle adapter reads it once before each create. No continuously running synchronization process is required. Writes are atomic and private; malformed configuration stops creation instead of silently choosing a different image. A missing configuration file uses the default.

After upgrading, reload the plugin and click **Prepare Runtime** again. Preparation preserves `config.json` and any older runtime needed by a running sandbox.

## What gets created

- 2 vCPUs, 4 GiB memory, 20 GiB writable copy-on-write root disk.
- No host filesystem mounts, SSH-agent forwarding, host environment injection into the guest, or Git-host credential transfer.
- Required guest tools installed through `apk` (Git, Bash, Node.js, tar, curl, runtime libraries).
- `/workspace/repo` on the guest disk, checked out on Orca's requested workspace branch at **exactly `ORCA_REPO_REF_HEAD`**.
- A host-local SSH listener with a fresh Gondolin-generated identity, returned to Orca using result schema version 2 and `checkoutMode: provisioned-root`.

A local Git bundle transfers the requested commit and its history. Uncommitted changes, untracked files, Git LFS payloads, and submodule working directories are **not** transferred. The commit does not need to exist on a remote. The origin URL is restored when usable, with HTTP credentials, query strings, fragments, and SSH passwords removed. Local-path and arbitrary remote-helper origins are omitted. Private remote operations require separate guest authentication; no credentials are copied automatically.

Guest HTTP(S) egress uses Gondolin's default policy, **not a plugin-specific domain allowlist**. Outbound Git-over-SSH is not enabled. This plugin does not configure secret injection. Host-side lifecycle commands are trusted host code, not sandboxed code.

## Lifecycle and persistence

The create command starts a detached Node owner process because Gondolin's SDK, network stack, and SSH forwarder must stay alive after the recipe exits. Each owner has a private local control socket. Destroy asks that owner to close the VM, waits for confirmation, and then removes state. Repeated destroy after successful cleanup is a no-op.

Lifecycle context comes from Orca's environment; destroy additionally validates Orca's stdin payload against the instance ID. Only connection JSON is written to create's stdout. Diagnostics go to stderr or the private instance log.

**Create and destroy only.** Suspend/resume are intentionally not advertised. Gondolin checkpoints are disk-only and consume the original VM, not process/RAM suspension. A correct resume implementation also needs fresh SSH access and durable checkpoint ownership. This initial integration does not pretend to preserve those semantics.

The guest is disposable, not a durable VM service: host reboot, force-killing the owner, or shutting down its execution environment can lose the writable overlay. Commit/push/export important work before destroying it. Closing a terminal or letting a recipe finish normally does not stop the detached owner.

## Diagnostics and cleanup

State lives in:

```text
~/.local/share/orca-gondolin/instances/<hash-of-Orca-instance-id>/
  daemon.log
  result.json
```

Control sockets live in a mode-0700 per-user directory under the OS temporary directory. Gondolin also registers the guest as `Orca <instance-id>` in its normal session registry (`gondolin list`).

Provisioning errors attempt to close the VM and remove state. Cancellation before handoff also asks the owner to close the VM. If an owner crashes, cleanup fails, or a request times out, the adapter conservatively retains state rather than reporting successful destruction. Inspect `daemon.log` and Gondolin sessions; confirm that the associated owner/VM has stopped before removing stale instance state and its socket. No saved PID is blindly killed. Keep the prepared runtime directories until all Orca workspaces using them are destroyed. Plugin removal does not automatically stop VMs or delete `~/.local/share/orca-gondolin`.

## Tests

```sh
npm test

# Native settings-panel interaction tests, using your Orca installation's test runtime:
orca plugin test .

# Build first: the smoke test uses the prepared bundled adapter, not src/ directly.
npm run build
GONDOLIN_SMOKE=1 node --test test/smoke.test.mjs

# Optionally verify the same bundle with Orca's Electron executable in Node mode:
# GONDOLIN_SMOKE=1 GONDOLIN_SMOKE_NODE=/path/to/electron node --test test/smoke.test.mjs
```

The real VM smoke test has passed on Linux x86_64 with both Node and Orca's Electron executable in Node mode. It validates offline runtime preparation, SDK provisioning, SSH command execution, exact checkout, and destruction—not the full Orca desktop managed-server connection. That final UI integration still needs verification in a running compatible Orca build. macOS has not been exercised.

## Files

- `orca-plugin.json`, `recipes/gondolin.json`: plugin contributions and declarative lifecycle commands.
- `ui/settings.tsx`, `worker/main.mjs`: native configuration panel and host-file bridge.
- `src/config.mjs`: shared validation, atomic persistence, and image selection.
- `src/runtime.mjs`: safe offline runtime preparation and status.
- `scripts/build.mjs`: builds `dist/`, including locked portable runtime dependencies.
- `scripts/install.mjs`: optional terminal equivalent of the panel preparation action.
- `docs/packaging.md`: current Orca API constraints and self-contained packaging design.
- `src/adapter.mjs`: Orca lifecycle protocol and detached-owner launch.
- `src/daemon.mjs`: Gondolin VM ownership, SSH access, and destruction.
- `src/repository.mjs`: pinned bundle transfer and remote sanitization.
