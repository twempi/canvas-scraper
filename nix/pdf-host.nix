# Native messaging host: LibreOffice PDF conversion, plus the Stylix palette for the UI.
# Merge `configFiles` into xdg.configFile.
#
# Theme (optional): pass Stylix's colours/fonts and the side panel follows them.
# Theme-switcher specialisations rebuild this file, so a switch reaches the panel
# the next time it opens; the signed CRX itself never changes.
#   pdfHost {
#     inherit pkgs;
#     colors = config.lib.stylix.colors;
#     fonts = { sansSerif = config.stylix.fonts.sansSerif.name; monospace = config.stylix.fonts.monospace.name; };
#   }
{ pkgs, extensionIds ? [ "pihjpoobjgmlfacpemennkjibihkmebm" "fhnmbadoigdiagenjabomlcafagmcifh" ], colors ? null, fonts ? { }, polarity ? null }:
let
  inherit (pkgs) lib;
  name = "edu.calpoly.canvas_archive_pdf";
  keys = map (digit: "base0${digit}") [ "0" "1" "2" "3" "4" "5" "6" "7" "8" "9" "A" "B" "C" "D" "E" "F" ];
  theme = lib.optionalString (colors != null) (pkgs.writeText "canvas-archive-theme.json" (builtins.toJSON {
    # Only the 16 base16 slots; Stylix's colour set also carries functions and derived variants.
    colors = lib.genAttrs keys (key: colors.${key});
    inherit fonts polarity;
  }));
  host = pkgs.writeShellScript "canvas-archive-pdf-host" ''
    export PATH=${pkgs.libreoffice}/bin:$PATH
    ${lib.optionalString (theme != "") "export CANVAS_ARCHIVE_THEME=${theme}"}
    exec ${pkgs.python3}/bin/python3 -I ${../native/canvas_pdf_host.py}
  '';
in {
  inherit host;
  configFiles."net.imput.helium/NativeMessagingHosts/${name}.json".text = builtins.toJSON {
    inherit name;
    description = "Canvas Local Archive helper (LibreOffice PDF conversion, Stylix theme)";
    path = "${host}";
    type = "stdio";
    allowed_origins = map (id: "chrome-extension://${id}/") extensionIds;
  };
}
