# Install as a normal signed extension with Nix

This project now includes a private signed CRX3 package. It uses the same Linux external-extension JSON mechanism as the extensions in your existing Helium list. **Developer mode, Load unpacked, runtime command-line flags, and a server are not required.** Nothing was published to the Chrome Web Store, and your Nix configuration was not changed or activated.

## Your entry

```nix
{
  # Canvas Local Archive
  id = "pihjpoobjgmlfacpemennkjibihkmebm";
  hash = "sha256-ls3ryJGNDUauN/7Gemk1ChsTa1B4Zk2QJiMqyEv2an4=";
}
```

The generated entry is also in [`packages/entry.nix`](../packages/entry.nix). The public signed artifact is [`packages/pihjpoobjgmlfacpemennkjibihkmebm-1.0.0.crx`](../packages/pihjpoobjgmlfacpemennkjibihkmebm-1.0.0.crx). Version, identity, source fingerprint, and hash are recorded in `packages/release.json`.

**One resolver change is required.** Your current `web-store.nix` constructs a Google Web Store download URL for every ID. The ID alone cannot tell Google where to obtain a private package. Adding this entry to the existing list without changing its fetcher would fail. Publishing to the Web Store would be required to use that exact Google-only fetcher unchanged.

[`nix/fetch-extension.nix`](../nix/fetch-extension.nix) accepts the same `{ id; hash; }` shape. It fetches Canvas from the bundled local CRX and applies Nix’s fixed-output hash check. All other IDs keep your current Web Store URL, OS/architecture selection, and hash behavior. Signing keys never enter Nix builds or the store.

## Integrate with the existing extension list

This is a concrete change for you to apply in your configuration; this project does not apply it automatically.

1. Make the public project files available to your flake. Since this project is now a Git repository, add/commit the new `flake.nix`, `nix/`, `packages/`, packaging scripts/tests, `.gitignore`, and documentation when you are ready. **The agent has not staged, committed, or pushed these changes.** Git-backed flake inputs omit untracked files. Never add `.local/`, private keys, browser profiles, or course folders. The CRX is intentionally allowed by `.gitignore` because it contains only public extension code.
2. Add a local Git flake input to your Nix configuration:

   ```nix
   inputs.canvas-local-archive.url =
     "git+file:///home/edward/Documents/projects/canvas-scraper";
   ```

   Use the actual project location if moved. Use a **Git source**, not `path:` pointing at the entire working directory: the latter could copy ignored signing keys/test profiles into the Nix store. No GitHub publication is needed.

3. Pass `inputs` into the module that defines your extension list. Replace only the current `fetchExtension = { id, hash }: ...` implementation with:

   ```nix
   fetchExtension = inputs.canvas-local-archive.lib.fetchExtension {
     inherit pkgs;
   };
   ```

   Keep `externalExtensionJson`, its `unzip`/version extraction, and the `configFiles` generation unchanged. The existing ClearURLs and other entries remain as they are.

   In the Helium layout inspected in your `.dotnix`, `inputs` already reaches `helium/default.nix`. Add it to that file's `import ./extensions` argument (`inherit config inputs lib pkgs startpageOrigin;`). Add `inputs` to the argument set of `extensions/default.nix`, and pass it through with `webStore = import ./web-store.nix { inherit inputs lib pkgs; };`. Finally add `inputs` to the argument set of `extensions/web-store.nix`, where the resolver and list are defined. These are instructions; those files have not been edited.

4. Add the entry above to `extensions`. Alternatively:

   ```nix
   extensions = [
     # Your existing entries...
     inputs.canvas-local-archive.lib.extension
   ];
   ```

5. Resolve/update **only this input** in your usual flake workflow, review your configuration, and apply it through your normal Home Manager/NixOS procedure. This project does not rebuild/activate your hosts. Close Helium fully and reopen it after applying the change.
6. Open `helium://extensions`. Canvas Local Archive should be enabled as a normal installed extension, with Developer mode off. Pin it using the toolbar Extensions menu or Details → Pin to toolbar. Clicking it opens the full archive tab.

The generated user configuration is equivalent to:

```text
~/.config/net.imput.helium/External Extensions/
  pihjpoobjgmlfacpemennkjibihkmebm.json
```

```json
{
  "external_crx": "/nix/store/...-pihjpoobjgmlfacpemennkjibihkmebm.crx",
  "external_version": "1.0.0"
}
```

The Nix store path is produced by the resolver, not hardcoded. Your existing installer already writes these two fields for its Web Store CRXs.

If you prefer a separate integration, [`nix/external-extensions.nix`](../nix/external-extensions.nix) generates just the new entry by default. With this same flake input, merge its `configFiles` with the existing assignment in `helium/default.nix`:

```nix
xdg.configFile = extensions.webStore.configFiles //
  (inputs.canvas-local-archive.lib.externalExtensions {
    inherit lib pkgs;
  }).configFiles;
```

Use either the existing-list resolver approach or the separate generator for the Canvas entry, so there is one owner of its JSON file. Existing unpacked custom extensions can coexist.

For non-flake configuration, import `nix/fetch-extension.nix` from a local checkout directly with `{ inherit pkgs; }`. The flake example above is the recommended route for your existing Git-backed configuration. A pure flake cannot import arbitrary home-directory paths without an input.

## First connection and migration

The packaged ID is **`pihjpoobjgmlfacpemennkjibihkmebm`**. The earlier unpacked ID remains **`fhnmbadoigdiagenjabomlcafagmcifh`** for development. The earlier implementation retained a public manifest key but discarded its private key, so a valid signed CRX cannot retain that old identity. The new signing key is retained privately for future packaged updates.

These IDs have separate IndexedDB storage. After switching to the packaged installation, reconnect to Canvas, scan, and select each course folder again. You can select the same roots: the existing `.canvas-archive/index.json` contains Canvas origin/course IDs and checksums independently of extension ID, so files are reconciled and verified unchanged copies can still skip. No course files are moved or removed. Disable the old unpacked copy after checking the new one if you want a single toolbar entry.

The normal-session connection, course selection, disk checks, reports and recovery behavior are unchanged. See the main README. Live Cal Poly login/CDN verification still requires your normal signed-in profile.

## Package updates

Installation uses an immutable local CRX and a hash pin, not a hosted update URL. Source edits do not automatically update the installed package.

1. Finish/cancel any job and close its tab.
2. Make source changes and increase **`extension/manifest.json` → `version`**. Keep the same private signing key. The source manifest’s existing public key remains the development/unpacked identity; packaging substitutes the signing public key only in its staging copy.
3. Build and test within the project:

   ```bash
   nix-shell shell.nix
   npm run check
   npm run package:crx
   npm test
   ```

   The new artifact, registry, and entry are generated under `packages/`. The package command uses installed **Helium’s native packer** at build time and independently verifies its CRX3 signature, ID, archive contents, and SHA-256 hash. It stages only extension assets. It does not launch/sign into an account browser, and no packaging flags are required at runtime.

4. Add/commit the public changes in your chosen workflow. Update the local flake input to that revision and update the entry’s hash if you copied it literally. Using `inputs.canvas-local-archive.lib.extension` obtains the generated pin from that input automatically.
5. Apply your reviewed configuration, fully restart Helium, and check the new version. Canvas handles remain associated with the same packaged ID. Renew permission and recheck actual course folders as usual.

Re-running the package command without changes reuses and verifies the exact existing artifact, preserving its hash. Changing extension assets without increasing the version is rejected. Installed CRX updates require a higher version; extension-card Reload is the unpacked development workflow, not the update method for this package.

**Back up `.local/signing/canvas-local-archive.pem` privately.** It is ignored, mode `0600`, and never included in the CRX, public release files, Git input, or Nix store. Losing it means you cannot sign updates under the same packaged ID. On another development machine, restore it there or use `npm run package:crx -- --key /path/to/restored-key.pem`. A missing/wrong key after the first release is rejected instead of silently creating a new identity.

If Helium is not on PATH, use `npm run package:crx -- --browser /path/to/helium`. Building packages adds a development requirement for Helium; the runtime requirements remain unchanged. Nix integration uses your consumer’s `pkgs.fetchurl`, `jq`, and `unzip`, matching the existing installer.

## Verification and limits

- Signed CRX3 identity/signature and exact packaged-source equality are independently checked by Node tests. Tampered payloads and malformed headers are rejected.
- The Nix resolver/generator built successfully from the real pinned CRX. An intentionally wrong hash produced the expected fixed-output hash-mismatch failure.
- ClearURLs’ unchanged entry resolves to the same Google Web Store URL as before; no real ClearURLs update was downloaded.
- The Nix-generated JSON was placed in an **isolated project-scoped XDG configuration**. Installed Helium 0.17.2.1 / Chromium 153 installed Canvas as a normal external extension with **Developer mode off**. Its Details page reported version 1.0.0 and “Not from Chrome Web Store”; the installed manifest appeared under the new ID’s `Profile/Extensions/<ID>/1.0.0_0/` directory. Pinning its toolbar action and clicking it opened the production full extension tab under that new ID.
- The normal configuration, browser profile, `.dotnix`, and running user services were not altered. Existing launcher-configured custom extensions also appeared in the isolated profile; no `--load-extension` argument for Canvas was used.

This is Linux-specific private installation. It is not a Chrome Web Store listing and does not claim off-store Windows/macOS compatibility. No publisher account, hosting service, automated Nix activation, or native messaging helper is introduced.

Official references: [local CRX/external installation](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions), [packaging/versions/signing-key reuse](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux), [CRX3 schema](https://github.com/chromium/chromium/blob/main/components/crx_file/crx3.proto).
