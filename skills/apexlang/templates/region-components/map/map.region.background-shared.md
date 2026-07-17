---
templateId: region.map.background-shared
componentType: region
version: 1.0
imports:
  - map._common.md
  - map.backgrounds.md
description: Map region scenario referencing shared mapBackground components.
---

# Purpose

Document the region-level background path where `tileLayerType` uses shared `mapBackground` components.

---

# Variable Contract

## Required Variables

- `regionStaticId`
- `name`
- `layout.sequence`
- `layout.slot`
- `tileLayerType` (use `shared`)
- `standardTileLayer`

## Optional Variables

- `darkModeTileLayer`
- `map.height`
- `mapFeatures`
- `showLegend`
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
  tileLayerType: shared
  standardTileLayer: @{{standardTileLayer}}
  darkModeTileLayer: @{{darkModeTileLayer}}
  mapFeatures: {{mapFeatures}}
  showLegend: {{showLegend}}
  lazyLoading: {{lazyLoading}}
)
```

---

# Guardrails

- `standardTileLayer` and `darkModeTileLayer` must reference existing `mapBackground` shared components.
- Use `map.backgrounds.md` for API-key, WMS, raster, and vector background-specific guidance.
- Shared backgrounds are the correct path when the request needs custom hosted tiles or shared reuse across multiple regions.
