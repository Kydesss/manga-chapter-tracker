# Design tokens

Shiori's design tokens are the single source of truth for colour, type, spacing,
radius, and elevation. They live in [`tokens.css`](../tokens.css) at the repo root and
are loaded before any component stylesheet. The popup uses them today; the full-page
app (Theme 2) will share the same file.

## How theming works

Tokens are plain CSS custom properties on `:root`. Only the **colour** tokens change
between themes; type, spacing, radius, and elevation are shared. Light mode currently
follows the OS via `@media (prefers-color-scheme: light)`. A manual override will later
set the same colour tokens on a `[data-theme="light|dark"]` attribute from the full-page
app's settings.

To re-theme, override colour tokens only. Never hardcode a hex value in a component;
reference a token so both themes and future surfaces stay consistent.

## Tokens

### Colour (themed)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0b1120` | `#f8fafc` | Page/popup background |
| `--surface` | `#111827` | `#ffffff` | Cards, inputs, raised areas |
| `--surface-2` | `#1f2937` | `#e8edf4` | Borders, subtle fills, hover |
| `--text` | `#f8fafc` | `#111827` | Primary text |
| `--muted` | `#94a3b8` | `#64748b` | Secondary/tertiary text |
| `--accent` | `#4f46e5` | `#4f46e5` | Brand indigo: primary buttons, active states |
| `--accent-text` | `#ffffff` | `#ffffff` | Text on `--accent` |
| `--success` | `#22c55e` | `#16a34a` | Synced, forward progress |
| `--danger` | `#f43f5e` | `#dc2626` | Destructive, regress, offline |

All pairings meet WCAG AA. Note: indigo as *text* on a dark surface fails contrast, so
emphasis on dark uses weight/`--text`, not `--accent` text.

### Typography

`--font-sans` (system stack). Scale: `--text-xs` 12px, `--text-sm` 13px, `--text-md`
14px (base), `--text-lg` 16px. `--leading` 1.45.

### Spacing

`--space-1` 2px, `-2` 4px, `-3` 6px, `-4` 8px, `-5` 10px, `-6` 12px, `-7` 16px, `-8`
20px, `-9` 28px. (Defined for adoption; the full-page app should use these rather than
raw pixels.)

### Radius

`--radius-xs` 6px (badges, small buttons), `--radius-sm` 8px (inputs, list rows,
buttons), `--radius` 10px (surfaces/cards), `--radius-pill` 999px.

### Elevation

`--shadow-1` (subtle), `--shadow-2` (overlay/popover). Tuned per theme.

## Adding or changing a token

1. Edit `tokens.css` only.
2. Reference it in components via `var(--token)`; do not inline raw values.
3. If it is a colour, set both the dark (`:root`) and light (`@media`) values and check
   AA contrast.
