# Tools

Utilities for offline map data, routing segments, and test fixtures.

## Data and Fixture Updater (`update_data.py`)

Downloads updated BRouter `.rd5` segments and test fixtures, with options to sync test assertions.

### Usage

```bash
# Update both segments and fixtures, sync test assertions, and verify parity:
python3 tools/update_data.py --update-tests --check

# Update only RD5 segments:
python3 tools/update_data.py --rd5-only

# Update specific RD5 segments:
python3 tools/update_data.py --rd5-only --segments E0_N50 W5_N50 W10_N50

# Update only baseline fixtures from brouter.de:
python3 tools/update_data.py --fixtures-only

# Sync hardcoded test assertions to current fixture data:
python3 tools/update_data.py --tests-only
```

### Options

| Flag | Description |
| :--- | :--- |
| `--segments [NAMES ...]` | List of segments to download. Defaults to `E0_N50` and `W5_N50`. |
| `--rd5-only` | Update only `.rd5` segment files in `data/segments4/`. |
| `--fixtures-only` | Update only GeoJSON baseline fixtures in `fixtures/brouter_de/`. |
| `--update-tests` | Sync hardcoded test assertions in `rsrouter-core` tests. |
| `--tests-only` | Sync test assertions without downloading new files. |
| `--check` | Run `cargo test` and `compare_routes` after updating. |

## PMTiles CLI

Download the `pmtiles` binary for your platform from:
https://github.com/protomaps/go-pmtiles/releases

Place the executable at `tools/pmtiles` and ensure it has execute permissions:

```bash
chmod +x tools/pmtiles
```
