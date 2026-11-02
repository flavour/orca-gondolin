# Self-contained packaging and current Orca API limits

## Result

The built plugin includes its adapter, Gondolin 0.14.0, and locked JavaScript dependencies in `runtime.json.gz`. Users do **not** need npm, a separate Node installation, an SDK checkout, or a package-registry download to prepare the adapter. Local installation uses `dist/`; a Git/catalog release must publish that folder's contents as its plugin root. The source checkout itself is not a prebuilt distribution. The optional krun/native acceleration dependencies are omitted; the adapter explicitly uses QEMU and ssh2's JavaScript implementation.

**Add Plugin alone is not sufficient.** After installing or updating, open **Gondolin Settings → Prepare Runtime**. This is an explicit, offline, host-file preparation action. It extracts the included bytes into a private content-addressed directory and atomically publishes the launcher the recipe uses. It reuses the Node-capable executable that runs Orca's worker (`ELECTRON_RUN_AS_NODE=1` for Electron), rather than searching the shell PATH for Node.

Git, OpenSSH tools (`ssh`, `ssh-keygen`) and QEMU remain system prerequisites. Guest images, guest packages and Orca's managed server can still require network downloads during VM creation. “Self-contained” here means the plugin's **host-side adapter code and dependencies**, not the hypervisor, Linux disk image or whole development environment.

## Findings from the current Orca source

These were checked against the local `~/code/orca` checkout. Paths below are relative to that repository:

| Source | Relevant behavior |
| --- | --- |
| `src/shared/plugins/artifacts/plugin-vm-recipe-artifact.ts` | The strict recipe schema accepts lifecycle shell strings and checkout mode. It has no plugin-relative executable, environment mapping or installation-hook field. |
| `src/main/plugins/plugin-vm-recipe-registry.ts` | Reads recipe commands from the plugin root but registers only the parsed recipe and plugin key. It does not expand a plugin-root token into the command. |
| `src/shared/ephemeral-vm-recipe-process.ts` | Runs commands with `cwd: repoPath`. Its `ORCA_*` environment contains repository/workspace/lifecycle context, not the plugin installation directory. |
| `src/main/plugins/installation/plugin-install-staging.ts` | Validates, hashes and publishes plugin files. It does not run package scripts, npm, or a plugin-defined install hook. |
| `src/main/plugins/workers/plugin-worker-controller.ts` | Workers start on demand. Merely declaring `main` is not a reliable install-time activation hook. |
| `src/main/plugins/workers/plugin-worker-env.ts`, `plugin-host-entry.ts` | Workers use a credential-filtered environment and Electron's Node mode. Their executable can also launch the adapter in Node mode. |
| `src/main/plugins/plugin-content-hash.ts` | Installed plugin content must have no symlinks and fit the 2,000-entry / 50 MiB limits. Bundling an archive also binds every dependency byte into the reviewed plugin hash, including in development mode where `node_modules` directories would otherwise be skipped. |

The developer-only `plugin dev request` CLI is not an installed-plugin lifecycle API, so recipes do not rely on it. They also do not search Orca's undocumented storage directories or depend on an absolute build-machine plugin path.

## Why a preparation action is necessary

The trusted worker can locate a bundled resource relative to its own module. A recipe cannot, because its current directory is the user's repository and Orca does not supply the plugin root. The worker therefore publishes a stable launcher under `~/.local/share/orca-gondolin/bin/` when explicitly requested from the panel.

If setup has not happened, the recipe fails with an actionable “Open Gondolin Settings and click Prepare Runtime” message rather than trying to install software silently. Preparing does not boot a VM or change the image setting. It preserves `config.json`, instance state, and older runtime versions that active detached VMs may still need.

A future Orca API could remove this step by supplying a supported plugin-root environment variable (for example `ORCA_PLUGIN_ROOT`) plus an executable Node runtime, or by supporting a plugin-relative lifecycle entry. This plugin does **not** assume those hypothetical APIs exist.

## Build and validation

`npm run build` installs the lockfile into a temporary build directory with `--omit=dev --omit=optional --ignore-scripts`, removes npm's executable symlinks, rejects native binaries/symlinks, and archives plain file bytes. License files remain inside the included dependencies. The staging directory is deleted afterwards.

Preparation validates archive paths and bounded uncompressed size before writing files. Versions are named by the SHA-256 digest of the bundled archive. Re-preparing the same version is safe; older versions are retained. There is no background synchronization daemon or install-time package script.

Validation covers the native panel, archive safety, relocation away from the build directory, preparation in a clean home, launcher execution without Node/npm on PATH, and real VM create/SSH/destroy through the prepared bundled adapter on Linux with both Node and Orca's Electron executable in Node mode. The full Add Plugin → desktop managed-server flow and macOS remain unverified.
