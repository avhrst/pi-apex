---
templateId: region.map.background-custom
componentType: region
version: 1.0
imports:
  - map._common.md
description: Map region scenario using built-in custom standard and dark backgrounds.
---

# Purpose

Document the region-level background path where `tileLayerType` uses the built-in background map names seeded by APEX.

---

# Variable Contract

## Required Variables

- `regionStaticId`
- `name`
- `layout.sequence`
- `layout.slot`
- `tileLayerType` (use `custom`)
- `standardTileLayer`

## Optional Variables

- `darkModeTileLayer`
- `map.height`
- `navigationBarType`
- `navigationBarPosition`
- `mapFeatures`
- `showLegend`
- `legendPosition`
- `lazyLoading`

---

# Output Template – Full

```apexlang
region {{regionStaticId}} (
  name: {{name}}
  type: map
  map {
    height: {{map.height}}
  }
  layout {
    sequence: {{layout.sequence}}
    slot: {{layout.slot}}
  }
  tileLayerType: custom
  standardTileLayer: {{standardTileLayer}}
  darkModeTileLayer: {{darkModeTileLayer}}
  navigationBarType: {{navigationBarType}}
  navigationBarPosition: {{navigationBarPosition}}
  mapFeatures: {{mapFeatures}}
  showLegend: {{showLegend}}
  legendPosition: {{legendPosition}}
  lazyLoading: {{lazyLoading}}
)
```

---

# Guardrails

- `tileLayerType: custom` selects built-in standard and dark-mode background names, not shared `mapBackground` components.
- The app/plugin attribute `useVectorTileLayers` still separately controls whether supported built-in backgrounds use vector tile layers behind the scenes.
- Load `map.backgrounds.md` only when the request uses shared backgrounds instead of built-in background names.
