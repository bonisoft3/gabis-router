package gabis_router

_themeChart: {
	"field":   "theme"
	"initial": "auto"
	"states": {
		"auto": {"on": {"click@theme-light": "light", "click@theme-dark": "dark"}}
		"light": {"on": {"click@theme-auto": "auto", "click@theme-dark": "dark"}}
		"dark": {"on": {"click@theme-auto": "auto", "click@theme-light": "light"}}
	}
}

_unitsChart: {
	"field":   "units"
	"initial": "metric"
	"states": {
		"metric": {"on": {"click@units-imperial": "imperial"}}
		"imperial": {"on": {"click@units-metric": "metric"}}
	}
}

_rowActors: {
	"routerRows": {
		"via":      "rows"
		"screen":   "router"
		"lifetime": "attachment"
		"charts": {
			"device": [
				_themeChart,
				_unitsChart,
			]
			"planner": [
				{
					"field":   "drawer"
					"initial": "open"
					"states": {
						"open": {
							"on": {
								"click@btn-drawer-toggle": "collapsed"
							}
						}
						"collapsed": {
							"on": {
								"click@btn-drawer-toggle": "open"
							}
						}
					}
				},
				{
					"field":   "modal"
					"initial": "none"
					"on": {
						"click@btn-modal-custom":  "custom"
						"click@btn-modal-offline": "offline"
						"click@btn-modal-about":   "about"
						"click@btn-modal-close":   "none"
					}
					"states": {
						"none": {}
						"custom": {}
						"offline": {}
						"about": {}
					}
				},
				{
					"field":   "breakdown_tab"
					"initial": "surface"
					"on": {
						"click@tab-surface":  "surface"
						"click@tab-road":     "road"
						"click@tab-traffic":  "traffic"
						"click@tab-noise":    "noise"
						"click@tab-speed":    "speed"
						"click@tab-warnings": "warnings"
					}
					"states": {
						"surface": {}
						"road": {}
						"traffic": {}
						"noise": {}
						"speed": {}
						"warnings": {}
					}
				},
				{
					"field":   "basemap"
					"initial": "gbrouter"
					"on": {
						"click@basemap-gbrouter": "gbrouter"
						"click@basemap-light":    "light"
						"click@basemap-osm":      "osm"
						"click@basemap-cyclosm":  "cyclosm"
					}
					"states": {
						"gbrouter": {}
						"light": {}
						"osm": {}
						"cyclosm": {}
					}
				},
				{
					"field":   "terrain_3d"
					"initial": "off"
					"states": {
						"off": {"on": {"click@btn-terrain-toggle": "on"}}
						"on": {"on": {"click@btn-terrain-toggle": "off"}}
					}
				},
				{
					"field":   "legend_open"
					"initial": "closed"
					"states": {
						"closed": {"on": {"click@btn-legend-toggle": "open"}}
						"open": {"on": {"click@btn-legend-toggle": "closed"}}
					}
				},
				{
					"field":   "clear_confirm"
					"initial": "idle"
					"states": {
						"idle": {
							"on": {
								"click@btn-clear-route": "armed"
							}
						}
						"armed": {
							"after": {
								"4000": "idle"
							}
							"on": {
								"click@btn-clear-confirm": "idle"
								"click@btn-clear-cancel":  "idle"
							}
						}
					}
				},
				{
					"field":   "share_status"
					"initial": "idle"
					"states": {
						"idle": {
							"on": {
								"click@btn-share-route": "copied"
							}
						}
						"copied": {
							"after": {
								"2000": "idle"
							}
						}
					}
				},
				{
					"field":   "search_step"
					"initial": "idle"
					"on": {
						"focus@search-input": "open"
						"click@search-input": "open"
						"input@search-input": {
							"target": "open"
							"assign": {
								"search_text": {
									"type": "event"
									"params": {
										"field": "value"
									}
								}
							}
						}
						"keydown@search-input": {
							"target": "open"
							"guard": {
								"type": "is_key"
								"params": {
									"key": "Enter"
								}
							}
							"assign": {
								"search_q": {
									"type": "search_submitted"
								}
							}
						}
						"click@btn-search-submit": {
							"target": "open"
							"assign": {
								"search_q": {
									"type": "search_submitted"
								}
							}
						}
						"click@btn-search-close":  "idle"
						"pointermove@elevation-stage": {
							"assign": {
								"hover_permille": {
									"type": "event"
									"params": {
										"field": "pointerX"
									}
								}
							}
						}
						"pointerleave@elevation-stage": {
							"assign": {
								"hover_permille": -1
							}
						}
					}
					"states": {
						"idle": {}
						"open": {}
					}
				},
			]
		}
	}
}
