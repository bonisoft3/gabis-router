# Gabi's Router

Fast, offline-capable bicycle route planner built with Pronto, Cortex state machines, MapLibre GL JS, and the Rust port of BRouter (`brouter-rs`) compiled to WebAssembly.

## Build & Verify

```sh
./saytw generate
./saytw lint
./saytw build
./saytw test
```

To rebuild the vendored `brouter-rs` WebAssembly engine from `tools/brouter-wasm`:

```sh
./tools/brouter-wasm/vendor.sh
```
