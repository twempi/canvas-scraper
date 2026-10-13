{
  description = "Private signed Canvas Local Archive package resolver";
  outputs = { self }: {
    # Uses the consumer's pkgs; no extra nixpkgs input or signing during builds.
    lib.fetchExtension = import ./nix/fetch-extension.nix;
    lib.externalExtensions = import ./nix/external-extensions.nix;
    lib.extension = import ./packages/entry.nix;
  };
}
