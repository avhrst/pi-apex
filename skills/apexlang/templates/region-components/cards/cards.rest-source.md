---
templateId: region.cards.rest-source
componentType: region
version: 1.0
imports:
  - cards._common
description: Cards region backed by REST source.
---

# Output Template

```
region {{regionStaticId}} (
  name: {{name}}
  type: cards
  source {
    location: restSource
    restSource: @{{source.restSource}}
  }
  layout {
    sequence: {{layout.sequence}}
    slot: {{layout.slot}}
  }
  appearance {
    template: @/cards-container
    templateOptions: #DEFAULT#
  }
  card {
    primaryKeyColumn1: {{card.primaryKeyColumn1}}
  }
  title {
    column: {{title.column}}
    htmlExpression: {{title.htmlExpression}}
    advancedFormatting: {{title.advancedFormatting}}
  }
  subtitle {
    column: {{subtitle.column}}
    htmlExpression: {{subtitle.htmlExpression}}
    advancedFormatting: {{subtitle.advancedFormatting}}
  }
  body {
    column: {{body.column}}
    htmlExpression: {{body.htmlExpression}}
    advancedFormatting: {{body.advancedFormatting}}
  }
  secondaryBody {
    column: {{secondaryBody.column}}
    htmlExpression: {{secondaryBody.htmlExpression}}
    advancedFormatting: {{secondaryBody.advancedFormatting}}
  }
  media {
    source: {{media.source}}
    blobColumn: {{media.blobColumn}}
    urlColumn: {{media.urlColumn}}
    accessibleDescription: {{media.accessibleDescription}}
  }
  componentAppearance {
    gridColumns: {{componentAppearance.gridColumns}}
  }
)
```

# Conditional Rendering Rules

- If `title.column` is emitted, omit `title.htmlExpression` and omit `title.advancedFormatting`.
- If `title.htmlExpression` is emitted, `title.advancedFormatting` must also be emitted with value `true`, and `title.column` must be omitted.
- If `subtitle.column` is emitted, omit `subtitle.htmlExpression` and omit `subtitle.advancedFormatting`.
- If `subtitle.htmlExpression` is emitted, `subtitle.advancedFormatting` must also be emitted with value `true`, and `subtitle.column` must be omitted.
- If `body.column` is emitted, omit `body.htmlExpression` and omit `body.advancedFormatting`.
- If `body.htmlExpression` is emitted, `body.advancedFormatting` must also be emitted with value `true`, and `body.column` must be omitted.
- If `secondaryBody.column` is emitted, omit `secondaryBody.htmlExpression` and omit `secondaryBody.advancedFormatting`.
- If `secondaryBody.htmlExpression` is emitted, `secondaryBody.advancedFormatting` must also be emitted with value `true`, and `secondaryBody.column` must be omitted.
- Omit the `media` block unless the cards design explicitly includes images or thumbnails.
- When `media` is emitted, use `media.source: blobColumn` for BLOB-backed images and `media.source: urlColumn` for projected image URL columns.
- Inside cards `title.htmlExpression`, `subtitle.htmlExpression`, `body.htmlExpression`, and `secondaryBody.htmlExpression`, use `&COLUMN.` substitution strings, not `#COLUMN#`.
- Omit the `componentAppearance` block by default.
- Emit `componentAppearance.gridColumns` only when the prompt explicitly specifies a fixed card column count.
- If emitted, `componentAppearance.gridColumns` must be one of `2`, `3`, `4`, or `5`.
