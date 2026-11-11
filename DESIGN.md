---
colors:
  primary: "#0B0D17"
  secondary: "#4A5076"
  accent: "#5847E0"
  danger: "#B91C1C"
  neutral: "#EEF0FB"
  surface: "#EEF0FB"
  border: "#CBD0EB"
  surface-muted: "#E4E7F8"
  panel: "rgba(248, 249, 255, 0.96)"
  field: "#FFFFFF"
  text: "#0B0D17"
  text-2: "#4A5076"
  muted: "#565D82"
  faint: "#8B92B8"
  surface-2: "#E4E7F8"
  border-2: "#DFE3F6"
  accent-2: "#C084FC"
  accent-hover: "#4B3BC8"
  accent-soft: "rgba(88, 71, 224, 0.12)"
  danger-bg: "#FEF2F2"
  danger-border: "#FECACA"
  slot-0: "#3B82F6"
  slot-1: "#F472B6"
  slot-2: "#F59E0B"
  ok: "#10B981"
  warn: "#F59E0B"
  cobbles: "#8B5CF6"
  track: "#D97706"
dark:
  primary: "#F0F2FF"
  secondary: "#B8BFE0"
  accent: "#8E82FA"
  danger: "#F87171"
  neutral: "#0B0D17"
  surface: "#151828"
  border: "#2C3252"
  surface-muted: "#1C2035"
  panel: "rgba(11, 13, 23, 0.94)"
  field: "#151828"
  text: "#F0F2FF"
  text-2: "#B8BFE0"
  muted: "#949CC2"
  faint: "#4F5576"
  surface-2: "#1C2035"
  border-2: "#20253D"
  accent-2: "#C084FC"
  accent-hover: "#A398FC"
  accent-soft: "rgba(142, 130, 250, 0.20)"
  danger-bg: "rgba(239, 68, 68, 0.15)"
  danger-border: "rgba(239, 68, 68, 0.35)"
  slot-0: "#60A5FA"
  slot-1: "#F472B6"
  slot-2: "#FBBF24"
  ok: "#34D399"
  warn: "#FBBF24"
  cobbles: "#A78BFA"
  track: "#F59E0B"
rounded:
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "14px"
  full: "999px"
spacing:
  2xs: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
---

# Cartographic workbench for urban and touring cyclists

Gabi's Router is a fast, offline-capable bicycle route planner built on the
Rust port of BRouter (`brouter-rs` compiled to WebAssembly) and OpenStreetMap
cycling infrastructure data. Its visual identity preserves the original
`gabis-router` / `surita.dev` indigo-violet palette (`#7C6DF5` / `#C084FC` over
cool slate `#EEF0FB` in light mode and deep night `#0B0D17` / `#151828` in dark
mode).

The viewport is a full-bleed interactive map with floating glassmorphic planes
(`--panel` with `backdrop-filter: blur(16px)`): a left-hand routing workbench
for waypoints, profile slots, avoid areas, and custom `.brf` tuning, and a
bottom analytics dock for slope-colored elevation profiles,
surface/road/traffic/noise/speed breakdowns, and route hazard warnings. Up to
three profile slots (`--slot-0` blue, `--slot-1` pink, `--slot-2` amber) compare
candidate routes side by side.
