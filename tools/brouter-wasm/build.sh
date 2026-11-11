#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
toolchain="${RUSTUP_TOOLCHAIN:-stable}"
out_dir="${1:-$script_dir/target/wasm-pkg}"

cargo +"$toolchain" build \
  --manifest-path "$script_dir/Cargo.toml" \
  -p rsrouter-wasm \
  --target wasm32-unknown-unknown \
  --release

mkdir -p "$out_dir"
wasm-bindgen \
  --target web \
  --no-typescript \
  --out-dir "$out_dir" \
  "$script_dir/target/wasm32-unknown-unknown/release/rsrouter_wasm.wasm"
