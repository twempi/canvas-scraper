# Drop-in fetchExtension resolver for existing { id; hash; } lists.
# Private packages are local; every other ID uses the existing Web Store URL.
{ pkgs, localPackages ? import ../packages/registry.nix }:
{ id, hash }:
assert builtins.match "[a-p]{32}" id != null;
let
  os = if pkgs.stdenv.hostPlatform.isDarwin then "mac" else "linux";
  arch = if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "x64";
  osArch = if pkgs.stdenv.hostPlatform.isDarwin then "arm64" else "x86_64";
  local = builtins.hasAttr id localPackages;
in
assert (!local || pkgs.stdenv.hostPlatform.isLinux);
pkgs.fetchurl {
  name = "${id}.crx";
  url = if local then "file://${localPackages.${id}.file}" else
    "https://clients2.google.com/service/update2/crx?response=redirect&os=${os}&arch=${arch}&os_arch=${osArch}&nacl_arch=x86-64&prod=chromiumcrx&prodchannel=stable&prodversion=120.0.0.0&acceptformat=crx3&x=id%3D${id}%26installsource%3Dondemand%26uc";
  inherit hash;
}
