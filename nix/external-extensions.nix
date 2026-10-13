# Optional complete generator, with the same JSON/path as the user's installer.
{ lib, pkgs, extensions ? [ (import ../packages/entry.nix) ] }:
let
  fetchExtension = import ./fetch-extension.nix { inherit pkgs; };
  externalExtensionJson = entry:
    pkgs.runCommand "helium-external-extension-${entry.id}.json" {
      nativeBuildInputs = [ pkgs.jq pkgs.unzip ];
      crx = fetchExtension entry;
    } ''
      manifest="$(unzip -p "$crx" manifest.json 2>/dev/null || true)"
      version="$(printf '%s' "$manifest" | jq -er .version)"
      test -n "$version"
      jq -n --arg crx "$crx" --arg version "$version" \
        '{ external_crx: $crx, external_version: $version }' > "$out"
    '';
in {
  configFiles = lib.listToAttrs (map (entry: {
    name = "net.imput.helium/External Extensions/${entry.id}.json";
    value.source = externalExtensionJson entry;
  }) extensions);
}
