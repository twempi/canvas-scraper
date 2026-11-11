# Native messaging host for PDF conversion. Merge `configFiles` into xdg.configFile.
{ pkgs, extensionIds ? [ "pihjpoobjgmlfacpemennkjibihkmebm" "fhnmbadoigdiagenjabomlcafagmcifh" ] }:
let
  name = "edu.calpoly.canvas_archive_pdf";
  host = pkgs.writeShellScript "canvas-archive-pdf-host" ''
    export PATH=${pkgs.libreoffice}/bin:$PATH
    exec ${pkgs.python3}/bin/python3 -I ${../native/canvas_pdf_host.py}
  '';
in {
  inherit host;
  configFiles."net.imput.helium/NativeMessagingHosts/${name}.json".text = builtins.toJSON {
    inherit name;
    description = "Canvas Local Archive PDF converter (LibreOffice)";
    path = "${host}";
    type = "stdio";
    allowed_origins = map (id: "chrome-extension://${id}/") extensionIds;
  };
}
