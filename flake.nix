{
  description = "Gakushu Sochi の開発環境";

  inputs = {
    # nodejs_24 が .node-version と同じ 24.20.0 になる枝を選んでいる。
    # 固定は flake.lock が受け持つので、unstable でも再現性は落ちない。
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # .node-version が正典。ここがずれたまま入れると、手元と CI で
        # 別の Node が動く。scripts/check-node-version.mjs が両者を突き合わせる。
        expectedNodeVersion = pkgs.lib.strings.trim (builtins.readFile ./.node-version);
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.go-task
            pkgs.lefthook
            pkgs.git
            pkgs.jq
          ];

          shellHook = ''
            if [ "$(node --version)" != "v${expectedNodeVersion}" ]; then
              echo "warning: devShell の Node は $(node --version)、.node-version は v${expectedNodeVersion}" >&2
              echo "  nixpkgs の nodejs_24 が動いた。flake.nix の nixpkgs 入力を見直すこと。" >&2
            fi
            echo "Gakushu Sochi devShell / node $(node --version) / task $(task --version)"
            echo "はじめてなら: task setup"
          '';
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
