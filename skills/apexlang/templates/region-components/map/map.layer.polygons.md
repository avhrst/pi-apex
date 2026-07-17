---
templateId: region.map.layer.polygons
componentType: region
version: 1.0
imports:
  - map._common.md
  - map.layer._common.md
description: Polygon-layer guidance for Oracle APEX Maps.
---

# Purpose

Document 2D polygon-layer behavior for Maps: polygon geometry, static fill and stroke, spectrum-driven color schemes, legend behavior, and tooltip or info-window paths.

---

# Variable Contract

## Required Variables

- `layer.staticId`
- `layer.name`
- `layer.layerType` (use `polygons`)
- `layer.layout.sequence`
- `layer.source.tableName`
- `layer.columnMapping.geometryColumnDataType`

## Optional Variables

- `layer.featureFillColorIsSpectrum`
- `layer.layerColorSpectrumType`
- `layer.layerColorSpectrum*Name`
- `layer.featureFillColorSpectrum`
- `layer.featureFillColorValueColumn`
- `layer.featureFillColor`
- `layer.featureFillOpacity`
- `layer.featureStrokeColor`
- `layer.featureStrokeWidth`
- `layer.featureStrokeStyle`
- `layer.mapFeatureLegendAdvFormatting`
- `layer.mapFeatureLegendHtmlExpr`

---

# Template

```apexlang
layer {{layer.staticId}} (
  name: {{layer.name}}
  layerType: polygons
  layout {
    sequence: {{layer.layout.sequence}}
  }
  source {
    tableName: {{layer.source.tableName}}
    sqlQuery:
      ```sql
      {{layer.source.sqlQuery}}
      ```
  }
  columnMapping {
    geometryColumnDataType: {{layer.columnMapping.geometryColumnDataType}}
    geometryColumn: {{layer.columnMapping.geometryColumn}}
    primaryKeyColumn: {{layer.columnMapping.primaryKeyColumn}}
  }
  featureFillColorIsSpectrum: {{layer.featureFillColorIsSpectrum}}
  layerColorSpectrumType: {{layer.layerColorSpectrumType}}
  featureFillColorValueColumn: {{layer.featureFillColorValueColumn}}
  featureFillColor: {{layer.featureFillColor}}
  featureFillOpacity: {{layer.featureFillOpacity}}
  featureStrokeColor: {{layer.featureStrokeColor}}
  featureStrokeWidth: {{layer.featureStrokeWidth}}
  featureStrokeStyle: {{layer.featureStrokeStyle}}
)
```

---

# Guardrails

- Spectrum-driven fill on polygons requires a numeric `featureFillColorValueColumn`.
- When spectrum mode is off, the layer falls back to static `featureFillColor`.
- Keep contrast between polygon fill, stroke, and the underlying basemap high enough for clear differentiation.
