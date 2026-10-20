// Pure Jessie reducer and mutation fold for GBRouter UI state transitions.
// Evaluated inside an Omnishell SES Compartment with zero ambient authority.
(state, event) => {
  if (!event) return { updates: [] };

  const MAX_ROUTE_SLOTS = 3;
  const AVOID_RADIUS_PRESETS = [100, 250, 500, 1000, 2000];
  const PROFILE_ORDER = [
    "fastbike-lowtraffic",
    "fastbike-verylowtraffic",
    "gabis-safe-road",
    "gabis-fast-city",
    "fastbike",
    "gabis-lite-gravel",
    "gravel",
    "trekking",
  ];
  const PROFILE_INFO = {
    "fastbike-lowtraffic": {
      label: "Fastbike Low Traffic",
      shortLabel: "Low Traffic",
      summary: "Paved roads, avoids heavy traffic, balanced climbing.",
    },
    "fastbike-verylowtraffic": {
      label: "Fastbike Very Low Traffic",
      shortLabel: "Very Low Traffic",
      summary: "Quiet country lanes and cycleways, strong traffic avoidance.",
    },
    "gabis-safe-road": {
      label: "Gabi's Safe Road",
      shortLabel: "Safe Road",
      summary: "Smooth tarmac, quiet B-roads and lanes, gentle hill penalty.",
    },
    "gabis-fast-city": {
      label: "Gabi's Fast City",
      shortLabel: "Fast City",
      summary: "Direct urban commuting via segregated cycleways and quiet streets.",
    },
    fastbike: {
      label: "Fastbike",
      shortLabel: "Fastbike",
      summary: "Fastest road route, tolerates main roads for speed.",
    },
    "gabis-lite-gravel": {
      label: "Gabi's Lite Gravel",
      shortLabel: "Lite Gravel",
      summary: "All-road & light gravel: compacted tracks, towpaths, and quiet lanes.",
    },
    gravel: {
      label: "Gravel",
      shortLabel: "Gravel",
      summary: "Off-road tracks, bridleways, and gravel paths preferred.",
    },
    trekking: {
      label: "Trekking",
      shortLabel: "Trekking",
      summary: "Touring & leisure: cycle networks, canal paths, and gentle hills.",
    },
  };
  const ROUTE_SLOT_COLORS = [
    { line: "#3b82f6", name: "Blue" },
    { line: "#ec4899", name: "Pink" },
    { line: "#eab308", name: "Amber" },
  ];

  const sortByNum = (arr, col) =>
    [...(arr || [])].sort((a, b) => Number(a[col] ?? 0) - Number(b[col] ?? 0));

  const uiRow =
    (state?.rows?.ui_state && state.rows.ui_state[0]) ||
    (state?.items && state.items[0]?.id === "main" ? state.items[0] : null);
  const wps = sortByNum(state?.rows?.waypoint || [], "idx");
  const avoids = sortByNum(state?.rows?.avoid_area || [], "idx");
  const slots = sortByNum(state?.rows?.profile_slot || [], "slot_idx");
  const searchResults = sortByNum(state?.rows?.search_result || [], "idx");
  const bars = sortByNum(state?.rows?.route_bar || [], "slot_idx");

  const waypointKind = (idx, total) => {
    if (idx === 0) return "start";
    if (idx === total - 1 && total > 1) return "end";
    return "via";
  };

  const waypointLabel = (idx, total) => {
    if (idx === 0) return "A";
    if (idx === total - 1 && total > 1) return "B";
    return String(idx);
  };

  const buildWaypointRow = (wp, idx, total) => {
    const lat = Number(wp.lat ?? 0);
    const lon = Number(wp.lon ?? 0);
    const name = String(wp.name ?? "");
    const coordStr = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const isGeocoding = wp.is_geocoding === "true" && !name;
    const isEditing = wp.is_editing === "true";
    const displayName = name || coordStr;
    const titleAttr = name
      ? `${name} (${coordStr}) · Click to rename`
      : `${coordStr} · Click to rename`;
    const kind = waypointKind(idx, total);
    const badgeLabel = waypointLabel(idx, total);

    return {
      id: `wp_${idx}`,
      idx,
      lat,
      lon,
      name,
      is_geocoding: isGeocoding ? "true" : "false",
      is_editing: isEditing ? "true" : "false",
      badge_class: `wp-badge ${kind}`,
      badge_label: badgeLabel,
      title_attr: titleAttr,
      display_name: displayName,
      hide_loading_shimmer: isGeocoding && !isEditing ? "false" : "true",
      hide_name_span: isEditing || isGeocoding ? "true" : "false",
      edit_value: isEditing ? String(wp.edit_value ?? name) : name,
      hide_rename_input: isEditing ? "false" : "true",
      coord_str: coordStr,
      hide_reorder_btns: total > 2 ? "false" : "true",
      disable_up: idx === 0 ? "true" : "false",
      disable_down: idx === total - 1 ? "true" : "false",
    };
  };

  const buildAvoidRow = (a, idx) => {
    const lat = Number(a.lat ?? 0);
    const lon = Number(a.lon ?? 0);
    const radius = Math.max(10, Number(a.radius ?? 250));
    const weight = a.weight !== undefined && a.weight !== null ? String(a.weight) : "";
    return {
      id: `av_${idx}`,
      idx,
      lat,
      lon,
      radius,
      weight,
      locate_title: `Center on avoid area (${lat.toFixed(4)}, ${lon.toFixed(4)})`,
      name_label: `Avoid #${idx + 1}`,
      radius_label: `${Math.round(radius)} m`,
    };
  };

  const buildSlotRow = (profile, idx, total) => {
    const prof = PROFILE_INFO[profile] ? profile : "fastbike-lowtraffic";
    const info = PROFILE_INFO[prof];
    const slotColor = ROUTE_SLOT_COLORS[idx] || ROUTE_SLOT_COLORS[0];
    return {
      id: `slot_${idx}`,
      slot_idx: idx,
      select_id: idx === 0 ? "profile-select" : `profile-select-${idx}`,
      remove_btn_id: `btn-remove-profile-${idx}`,
      profile: prof,
      label: info.label,
      summary: info.summary,
      color_line: slotColor.line,
      color_name: slotColor.name,
      dot_style: `background-color: ${slotColor.line}`,
      dot_title: `Route ${idx + 1} (${slotColor.name})`,
      hide_compare_chrome: total > 1 ? "false" : "true",
    };
  };

  const deriveUiChrome = (wpList, avoidList, slotList) => {
    const primaryProf = slotList[0]?.profile || "fastbike-lowtraffic";
    const info = PROFILE_INFO[primaryProf] || PROFILE_INFO["fastbike-lowtraffic"];
    const slotCount = Math.max(1, slotList.length);
    const badgeLabel =
      slotCount > 1 ? `${info.shortLabel} +${slotCount - 1}` : info.shortLabel;
    return {
      profile_badge: badgeLabel,
      profile_label_text: slotCount > 1 ? "Profiles" : "Profile",
      profile_tooltip: `${info.summary} Profiles score every road segment by surface, traffic, hills, and cycle infrastructure. Add up to 3 profiles to compare routes side by side.`,
      hide_add_profile: slotCount < MAX_ROUTE_SLOTS ? "false" : "true",
      disable_reverse: wpList.length >= 2 ? "false" : "true",
      disable_clear: wpList.length > 0 || avoidList.length > 0 ? "false" : "true",
      disable_share: wpList.length >= 2 ? "false" : "true",
      hide_avoid_section: avoidList.length > 0 ? "false" : "true",
      hide_avoid_header: avoidList.length > 1 ? "false" : "true",
      avoid_header_title: `Avoid Areas (${avoidList.length})`,
    };
  };

  const diffTable = (entity, oldRows, newRows) => {
    const out = [];
    const nextIds = new Set(newRows.map((r) => String(r.id)));
    for (const r of oldRows) {
      if (!nextIds.has(String(r.id))) {
        out.push({ op: "delete", entity, id: r.id });
      }
    }
    for (const r of newRows) {
      out.push({ op: "put", entity, id: r.id, row: r });
    }
    return out;
  };

  const rowDiffers = (actual, expected) => {
    for (const [k, v] of Object.entries(expected)) {
      if (String(actual?.[k] ?? "") !== String(v ?? "")) return true;
    }
    return false;
  };

  // 0. Declarative data-on-mutation fold across profile_slot, waypoint, avoid_area, and ui_state
  if (event.type === "mutation") {
    const updates = [];
    for (let i = 0; i < slots.length; i++) {
      const canonical = buildSlotRow(slots[i].profile, i, slots.length);
      if (rowDiffers(slots[i], canonical)) {
        updates.push({ op: "put", entity: "profile_slot", id: canonical.id, row: canonical });
      }
    }
    for (let i = 0; i < wps.length; i++) {
      const canonical = buildWaypointRow(wps[i], i, wps.length);
      if (rowDiffers(wps[i], canonical)) {
        updates.push({ op: "put", entity: "waypoint", id: canonical.id, row: canonical });
      }
    }
    for (let i = 0; i < avoids.length; i++) {
      const canonical = buildAvoidRow(avoids[i], i, avoids.length);
      if (rowDiffers(avoids[i], canonical)) {
        updates.push({ op: "put", entity: "avoid_area", id: canonical.id, row: canonical });
      }
    }
    if (uiRow && slots.length > 0) {
      const chrome = deriveUiChrome(wps, avoids, slots);
      const patch = {};
      let changed = false;
      for (const [k, v] of Object.entries(chrome)) {
        if (String(uiRow[k] ?? "") !== String(v)) {
          patch[k] = v;
          changed = true;
        }
      }
      if (changed) {
        updates.push({ op: "patch", entity: "ui_state", id: "main", row: patch });
      }
    }
    return { updates };
  }

  const emitCmd = (payload) => ({
    updates: [
      {
        op: "patch",
        entity: "ui_state",
        id: "main",
        row: { host_cmd: JSON.stringify(payload) },
      },
    ],
  });

  const applyWaypointsChange = (nextRawWps, extraUpdates = [], extraUiPatch = {}) => {
    const nextWpRows = nextRawWps.map((w, i) =>
      buildWaypointRow({ ...w, is_editing: "false" }, i, nextRawWps.length)
    );
    const updates = [...diffTable("waypoint", wps, nextWpRows), ...extraUpdates];
    const chrome = deriveUiChrome(nextWpRows, avoids, slots);
    if (nextWpRows.length < 2) {
      for (const b of bars) {
        updates.push({ op: "delete", entity: "route_bar", id: b.id });
      }
      Object.assign(chrome, {
        disable_export: "true",
        hide_route_info: "true",
        status_class: "status-bar",
        hide_status_bar: "false",
        hide_status_spinner: "true",
        status_text:
          nextWpRows.length === 1
            ? "Start point set. Click on the map or search to set destination."
            : "Click on the map or search to set start and end points.",
      });
    }
    updates.push({
      op: "patch",
      entity: "ui_state",
      id: "main",
      row: { ...chrome, ...extraUiPatch },
    });
    return { updates };
  };

  // 1. Native Omnishell drag-and-drop reorder from #waypoint-list (wireDrag)
  if (event.type === "move" && event.fromId && event.toId) {
    const fromIdx = Number(String(event.fromId).replace("wp_", ""));
    const toIdx = Number(String(event.toId).replace("wp_", ""));
    if (
      !Number.isNaN(fromIdx) &&
      !Number.isNaN(toIdx) &&
      fromIdx !== toIdx &&
      fromIdx >= 0 &&
      fromIdx < wps.length &&
      toIdx >= 0 &&
      toIdx < wps.length
    ) {
      const next = [...wps];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return applyWaypointsChange(next);
    }
    return { updates: [] };
  }

  const from = String(event.from || "");
  if (!from) return { updates: [] };

  // 2. Pure UI modal & panel state transitions
  if (from === "btn-settings") {
    return {
      updates: [
        {
          op: "patch",
          entity: "ui_state",
          id: "main",
          row: {
            hide_settings_modal: "false",
            host_cmd: JSON.stringify({ cmd: "refresh-offline-status" }),
          },
        },
      ],
    };
  }

  if (from === "btn-close-settings") {
    return {
      updates: [
        {
          op: "patch",
          entity: "ui_state",
          id: "main",
          row: { hide_settings_modal: "true" },
        },
      ],
    };
  }

  if (from === "btn-about") {
    return {
      updates: [
        {
          op: "patch",
          entity: "ui_state",
          id: "main",
          row: { hide_about_modal: "false" },
        },
      ],
    };
  }

  if (from === "btn-close-about") {
    return {
      updates: [
        {
          op: "patch",
          entity: "ui_state",
          id: "main",
          row: { hide_about_modal: "true" },
        },
      ],
    };
  }

  if (from === "header-title-wrap") {
    if (uiRow?.controls_class === "collapsed") {
      return {
        updates: [
          {
            op: "patch",
            entity: "ui_state",
            id: "main",
            row: {
              controls_class: "",
              collapse_btn_title: "Collapse controls",
              collapse_btn_label: "Collapse panel",
            },
          },
        ],
      };
    }
    return { updates: [] };
  }

  if (from === "btn-toggle-collapse") {
    const collapsed = uiRow?.controls_class === "collapsed";
    return {
      updates: [
        {
          op: "patch",
          entity: "ui_state",
          id: "main",
          row: {
            controls_class: collapsed ? "" : "collapsed",
            collapse_btn_title: collapsed ? "Collapse controls" : "Expand controls",
            collapse_btn_label: collapsed ? "Collapse panel" : "Expand panel",
          },
        },
      ],
    };
  }

  if (from === "btn-clear-search") {
    const updates = searchResults.map((r) => ({
      op: "delete",
      entity: "search_result",
      id: r.id,
    }));
    updates.push({
      op: "patch",
      entity: "ui_state",
      id: "main",
      row: {
        search_query: "",
        hide_clear_search: "true",
        hide_search_results: "true",
        hide_search_status: "true",
        search_status: "",
      },
    });
    return { updates };
  }

  // 3. Pure Route Bar collapse / expand transitions
  if (
    from.startsWith("btn-toggle-ri-collapse") ||
    from.startsWith("route-collapse-btn") ||
    from.startsWith("ri-identity-") ||
    from.startsWith("ri-metrics-")
  ) {
    const barList = bars.length > 0 ? bars : state?.items || [];
    const targetId = event.id || "bar_0";
    const bar = barList.find((b) => b.id === targetId) || barList[0];
    if (!bar) return { updates: [] };

    const wasCollapsed = bar.hide_body === "true";
    const nextCollapsed = !wasCollapsed;
    const isCompare = barList.length > 1;
    const nextCardClass = [
      "route-bar-card",
      nextCollapsed ? "collapsed" : "",
      isCompare ? "compare-slot" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const allCollapsed = barList.every((b) =>
      b.id === bar.id ? nextCollapsed : b.hide_body === "true"
    );
    const nextRouteInfoClass = [
      allCollapsed ? "collapsed" : "",
      isCompare ? "multi-slot" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return {
      updates: [
        {
          op: "patch",
          entity: "route_bar",
          id: bar.id,
          row: {
            card_class: nextCardClass,
            hide_body: nextCollapsed ? "true" : "false",
            collapse_title: nextCollapsed ? "Expand charts" : "Collapse charts",
          },
        },
        {
          op: "patch",
          entity: "ui_state",
          id: "main",
          row: {
            route_info_class: nextRouteInfoClass,
          },
        },
      ],
    };
  }

  // 4. Pure Profile Comparison Slot transitions
  if (from === "btn-add-compare-profile") {
    if (slots.length >= MAX_ROUTE_SLOTS) return { updates: [] };
    const used = new Set(slots.map((s) => s.profile));
    const nextProf = PROFILE_ORDER.find((p) => !used.has(p)) || PROFILE_ORDER[0];
    const nextProfs = [...slots.map((s) => s.profile), nextProf];
    const nextSlotRows = nextProfs.map((p, i) => buildSlotRow(p, i, nextProfs.length));
    const updates = diffTable("profile_slot", slots, nextSlotRows);
    updates.push({
      op: "patch",
      entity: "ui_state",
      id: "main",
      row: deriveUiChrome(wps, avoids, nextSlotRows),
    });
    return { updates };
  }

  if (from.startsWith("btn-remove-profile-") || from.startsWith("ri-remove-")) {
    const prefix = from.startsWith("btn-remove-profile-")
      ? "btn-remove-profile-"
      : "ri-remove-";
    const slotIdx = Number(from.slice(prefix.length));
    if (slots.length <= 1 || Number.isNaN(slotIdx) || slotIdx < 0 || slotIdx >= slots.length) {
      return { updates: [] };
    }
    const nextProfs = slots.filter((_, i) => i !== slotIdx).map((s) => s.profile);
    const nextSlotRows = nextProfs.map((p, i) => buildSlotRow(p, i, nextProfs.length));
    const updates = diffTable("profile_slot", slots, nextSlotRows);
    if (bars.length > nextSlotRows.length) {
      updates.push({
        op: "delete",
        entity: "route_bar",
        id: `bar_${bars.length - 1}`,
      });
    }
    updates.push({
      op: "patch",
      entity: "ui_state",
      id: "main",
      row: deriveUiChrome(wps, avoids, nextSlotRows),
    });
    return { updates };
  }

  // 5. Pure Waypoint transitions (reorder, delete, reverse, clear, inline edit)
  if (from === "btn-reverse-route") {
    if (wps.length < 2) return { updates: [] };
    return applyWaypointsChange([...wps].reverse());
  }

  if (from === "btn-clear-route") {
    if (wps.length === 0 && avoids.length === 0) return { updates: [] };
    const updates = [
      ...wps.map((w) => ({ op: "delete", entity: "waypoint", id: w.id })),
      ...avoids.map((a) => ({ op: "delete", entity: "avoid_area", id: a.id })),
      ...bars.map((b) => ({ op: "delete", entity: "route_bar", id: b.id })),
    ];
    const chrome = deriveUiChrome([], [], slots);
    updates.push({
      op: "patch",
      entity: "ui_state",
      id: "main",
      row: {
        ...chrome,
        disable_export: "true",
        hide_route_info: "true",
        status_class: "status-bar",
        hide_status_bar: "false",
        hide_status_spinner: "true",
        status_text: "Route cleared.",
      },
    });
    return { updates };
  }

  if (from.startsWith("wp-up-")) {
    const idx = Number(from.slice("wp-up-".length));
    if (Number.isNaN(idx) || idx <= 0 || idx >= wps.length) return { updates: [] };
    const next = [...wps];
    const [moved] = next.splice(idx, 1);
    next.splice(idx - 1, 0, moved);
    return applyWaypointsChange(next);
  }

  if (from.startsWith("wp-down-")) {
    const idx = Number(from.slice("wp-down-".length));
    if (Number.isNaN(idx) || idx < 0 || idx >= wps.length - 1) return { updates: [] };
    const next = [...wps];
    const [moved] = next.splice(idx, 1);
    next.splice(idx + 1, 0, moved);
    return applyWaypointsChange(next);
  }

  if (from.startsWith("wp-del-")) {
    const idx = Number(from.slice("wp-del-".length));
    if (Number.isNaN(idx) || idx < 0 || idx >= wps.length) return { updates: [] };
    const next = wps.filter((_, i) => i !== idx);
    return applyWaypointsChange(next);
  }

  if (from.startsWith("wp-name-")) {
    const idx = Number(from.slice("wp-name-".length));
    const wp = wps[idx];
    if (!wp) return { updates: [] };
    return {
      updates: [
        {
          op: "put",
          entity: "waypoint",
          id: wp.id,
          row: buildWaypointRow(
            { ...wp, is_editing: "true", edit_value: wp.name || "" },
            idx,
            wps.length
          ),
        },
      ],
    };
  }

  // 6. Pure Avoid Area transitions (cycle radius, delete, clear all)
  if (from === "btn-clear-avoids") {
    if (avoids.length === 0) return { updates: [] };
    const updates = avoids.map((a) => ({ op: "delete", entity: "avoid_area", id: a.id }));
    updates.push({
      op: "patch",
      entity: "ui_state",
      id: "main",
      row: deriveUiChrome(wps, [], slots),
    });
    return { updates };
  }

  if (from.startsWith("avoid-rad-")) {
    const idx = Number(from.slice("avoid-rad-".length));
    const area = avoids[idx];
    if (!area) return { updates: [] };
    const r = Math.round(Number(area.radius ?? 250));
    const presetIdx = AVOID_RADIUS_PRESETS.indexOf(r);
    const nextRadius =
      AVOID_RADIUS_PRESETS[(presetIdx + 1) % AVOID_RADIUS_PRESETS.length] ||
      AVOID_RADIUS_PRESETS[0];
    const updatedRow = buildAvoidRow({ ...area, radius: nextRadius }, idx);
    return {
      updates: [
        {
          op: "put",
          entity: "avoid_area",
          id: updatedRow.id,
          row: updatedRow,
        },
      ],
    };
  }

  if (from.startsWith("avoid-del-")) {
    const idx = Number(from.slice("avoid-del-".length));
    if (Number.isNaN(idx) || idx < 0 || idx >= avoids.length) return { updates: [] };
    const nextAvoids = avoids
      .filter((_, i) => i !== idx)
      .map((a, i) => buildAvoidRow(a, i));
    const updates = diffTable("avoid_area", avoids, nextAvoids);
    updates.push({
      op: "patch",
      entity: "ui_state",
      id: "main",
      row: deriveUiChrome(wps, nextAvoids, slots),
    });
    return { updates };
  }

  // 7. Pure Search Result selection -> Waypoint insertion
  if (
    from.startsWith("sr-title-") ||
    from.startsWith("sr-start-") ||
    from.startsWith("sr-via-") ||
    from.startsWith("sr-end-")
  ) {
    let prefix = "sr-title-";
    let action = "append";
    if (from.startsWith("sr-start-")) {
      prefix = "sr-start-";
      action = "start";
    } else if (from.startsWith("sr-via-")) {
      prefix = "sr-via-";
      action = "via";
    } else if (from.startsWith("sr-end-")) {
      prefix = "sr-end-";
      action = "end";
    }
    const idx = Number(from.slice(prefix.length));
    const item = searchResults[idx];
    if (!item) return { updates: [] };

    const pt = {
      lat: Number(item.lat),
      lon: Number(item.lon),
      name: String(item.name || item.title || ""),
      is_geocoding: "false",
      is_editing: "false",
    };

    let nextWps;
    if (action === "start") {
      nextWps = wps.length === 0 ? [pt] : [pt, ...wps.slice(1)];
    } else if (action === "end") {
      nextWps = wps.length < 2 ? [...wps, pt] : [...wps.slice(0, -1), pt];
    } else if (action === "via" && wps.length >= 2) {
      let bestLeg = wps.length - 2;
      let bestDist = Infinity;
      for (let i = 0; i < wps.length - 1; i++) {
        const midLat = (Number(wps[i].lat) + Number(wps[i + 1].lat)) / 2;
        const midLon = (Number(wps[i].lon) + Number(wps[i + 1].lon)) / 2;
        const d = (pt.lat - midLat) ** 2 + (pt.lon - midLon) ** 2;
        if (d < bestDist) {
          bestDist = d;
          bestLeg = i;
        }
      }
      nextWps = [...wps];
      nextWps.splice(Math.max(1, bestLeg + 1), 0, pt);
    } else {
      nextWps = [...wps, pt];
    }

    const srDeletes = searchResults.map((r) => ({
      op: "delete",
      entity: "search_result",
      id: r.id,
    }));

    return applyWaypointsChange(nextWps, srDeletes, {
      search_query: "",
      hide_clear_search: "true",
      hide_search_results: "true",
      hide_search_status: "true",
      search_status: "",
      host_cmd: JSON.stringify({ cmd: "fly-to", lat: pt.lat, lon: pt.lon, zoom: 14 }),
    });
  }

  // 8. Browser / Platform side-effect commands (History, Geolocation, Clipboard, File, OPFS, Map camera)
  if (from === "btn-undo") return emitCmd({ cmd: "undo" });
  if (from === "btn-redo") return emitCmd({ cmd: "redo" });
  if (from === "btn-share") return emitCmd({ cmd: "share" });
  if (from === "btn-export-gpx") return emitCmd({ cmd: "export-gpx" });
  if (from === "btn-my-location") return emitCmd({ cmd: "my-location" });
  if (from === "btn-download-offline") return emitCmd({ cmd: "download-offline" });
  if (from === "btn-delete-offline") return emitCmd({ cmd: "delete-offline" });
  if (from === "btn-update-offline") return emitCmd({ cmd: "update-offline" });

  if (from.startsWith("alt-btn-")) {
    const parts = from.slice("alt-btn-".length).split("-");
    return emitCmd({ cmd: "select-alt", slotIdx: Number(parts[0]), altIdx: Number(parts[1]) });
  }
  if (from.startsWith("wp-badge-")) {
    return emitCmd({ cmd: "wp-locate", idx: Number(from.slice("wp-badge-".length)) });
  }
  if (from.startsWith("avoid-loc-")) {
    return emitCmd({ cmd: "avoid-locate", idx: Number(from.slice("avoid-loc-".length)) });
  }

  return { updates: [] };
}
