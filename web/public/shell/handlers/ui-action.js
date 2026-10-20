// Pure Jessie reducer for GBRouter UI state transitions and declarative actions.
// Evaluated inside an Omnishell SES Compartment with zero ambient authority.
(state, event) => {
  if (!event) return { updates: [] };

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

  // 1. Native Omnishell drag-and-drop reorder from #waypoint-list (wireDrag)
  if (event.type === "move" && event.fromId && event.toId) {
    const fromIdx = Number(String(event.fromId).replace("wp_", ""));
    const toIdx = Number(String(event.toId).replace("wp_", ""));
    if (!Number.isNaN(fromIdx) && !Number.isNaN(toIdx) && fromIdx !== toIdx) {
      return emitCmd({ cmd: "wp-reorder", fromIdx, toIdx });
    }
    return { updates: [] };
  }

  const from = String(event.from || "");
  if (!from) return { updates: [] };

  const uiRow =
    (state?.rows?.ui_state && state.rows.ui_state[0]) ||
    (state?.items && state.items[0]) ||
    null;

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
    return {
      updates: [
        {
          op: "patch",
          entity: "ui_state",
          id: "main",
          row: {
            search_query: "",
            hide_clear_search: "true",
            hide_search_results: "true",
            hide_search_status: "true",
            host_cmd: JSON.stringify({ cmd: "clear-search" }),
          },
        },
      ],
    };
  }

  // 3. Pure Route Bar collapse / expand transitions
  if (
    from.startsWith("btn-toggle-ri-collapse") ||
    from.startsWith("route-collapse-btn") ||
    from.startsWith("ri-identity-") ||
    from.startsWith("ri-metrics-")
  ) {
    const bars = state?.items || [];
    const targetId = event.id || "bar_0";
    const bar = bars.find((b) => b.id === targetId) || bars[0];
    if (!bar) return { updates: [] };

    const wasCollapsed = bar.hide_body === "true";
    const nextCollapsed = !wasCollapsed;
    const isCompare = bars.length > 1;
    const nextCardClass = [
      "route-bar-card",
      nextCollapsed ? "collapsed" : "",
      isCompare ? "compare-slot" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const allCollapsed = bars.every((b) =>
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
            collapse_title: nextCollapsed ? "Expand route details" : "Collapse route details",
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

  // 4. Declarative routing, profile, waypoint, avoid-area, and offline actions
  if (from === "btn-add-compare-profile") return emitCmd({ cmd: "add-profile" });
  if (from === "btn-undo") return emitCmd({ cmd: "undo" });
  if (from === "btn-redo") return emitCmd({ cmd: "redo" });
  if (from === "btn-reverse-route") return emitCmd({ cmd: "reverse-route" });
  if (from === "btn-clear-route") return emitCmd({ cmd: "clear-route" });
  if (from === "btn-clear-avoids") return emitCmd({ cmd: "clear-avoids" });
  if (from === "btn-share") return emitCmd({ cmd: "share" });
  if (from === "btn-export-gpx") return emitCmd({ cmd: "export-gpx" });
  if (from === "btn-my-location") return emitCmd({ cmd: "my-location" });
  if (from === "btn-download-offline") return emitCmd({ cmd: "download-offline" });
  if (from === "btn-delete-offline") return emitCmd({ cmd: "delete-offline" });
  if (from === "btn-update-offline") return emitCmd({ cmd: "update-offline" });

  if (from.startsWith("btn-remove-profile-")) {
    const slotIdx = Number(from.slice("btn-remove-profile-".length));
    return emitCmd({ cmd: "remove-profile", slotIdx });
  }
  if (from.startsWith("ri-remove-")) {
    const slotIdx = Number(from.slice("ri-remove-".length));
    return emitCmd({ cmd: "remove-profile", slotIdx });
  }
  if (from.startsWith("alt-btn-")) {
    const parts = from.slice("alt-btn-".length).split("-");
    return emitCmd({ cmd: "select-alt", slotIdx: Number(parts[0]), altIdx: Number(parts[1]) });
  }

  if (from.startsWith("wp-badge-")) {
    return emitCmd({ cmd: "wp-locate", idx: Number(from.slice("wp-badge-".length)) });
  }
  if (from.startsWith("wp-name-")) {
    return emitCmd({ cmd: "wp-edit", idx: Number(from.slice("wp-name-".length)) });
  }
  if (from.startsWith("wp-up-")) {
    const idx = Number(from.slice("wp-up-".length));
    return emitCmd({ cmd: "wp-reorder", fromIdx: idx, toIdx: idx - 1 });
  }
  if (from.startsWith("wp-down-")) {
    const idx = Number(from.slice("wp-down-".length));
    return emitCmd({ cmd: "wp-reorder", fromIdx: idx, toIdx: idx + 1 });
  }
  if (from.startsWith("wp-del-")) {
    return emitCmd({ cmd: "wp-delete", idx: Number(from.slice("wp-del-".length)) });
  }

  if (from.startsWith("avoid-loc-")) {
    return emitCmd({ cmd: "avoid-locate", idx: Number(from.slice("avoid-loc-".length)) });
  }
  if (from.startsWith("avoid-rad-")) {
    return emitCmd({ cmd: "avoid-radius", idx: Number(from.slice("avoid-rad-".length)) });
  }
  if (from.startsWith("avoid-del-")) {
    return emitCmd({ cmd: "avoid-delete", idx: Number(from.slice("avoid-del-".length)) });
  }

  if (from.startsWith("sr-title-")) {
    return emitCmd({ cmd: "search-pick", idx: Number(from.slice("sr-title-".length)), action: "append" });
  }
  if (from.startsWith("sr-start-")) {
    return emitCmd({ cmd: "search-pick", idx: Number(from.slice("sr-start-".length)), action: "start" });
  }
  if (from.startsWith("sr-via-")) {
    return emitCmd({ cmd: "search-pick", idx: Number(from.slice("sr-via-".length)), action: "via" });
  }
  if (from.startsWith("sr-end-")) {
    return emitCmd({ cmd: "search-pick", idx: Number(from.slice("sr-end-".length)), action: "end" });
  }

  return { updates: [] };
}
