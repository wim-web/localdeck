# Design — Localdeck

A locked design system for this app. Every page redesign reads this file before
emitting code. Amend this file before introducing a local visual exception.

## Context

- Audience: one local developer.
- Primary use: status checks, registration, editing, start, restart, stop, route
  sync, and direct opening are peers.
- Tone: distil — retain information and function; remove decorative excess.

## Genre

modern-minimal, with a technical and austere register.

## Macrostructure family

- Marketing pages: not currently present.
- App pages: Workbench. Use an operational header, a T4 status strip, and an F3
  tabular registry. N13 provides keyboard access to the same actions visible in
  the workbench.
- Content pages: not currently present.

## Theme

Cobalt. Cool engineered paper, ruler-drawn rules, dark graphite ink, and one
electric-blue signal accent.

- --color-paper: oklch(98.5% 0.004 250)
- --color-paper-2: oklch(96.5% 0.006 252)
- --color-paper-3: oklch(93.5% 0.008 252)
- --color-ink: oklch(24% 0.02 258)
- --color-ink-2: oklch(34% 0.018 257)
- --color-rule: oklch(87% 0.01 252)
- --color-rule-2: oklch(78% 0.012 254)
- --color-accent: oklch(55% 0.20 256)
- --color-graphite: oklch(22% 0.016 260)
- --color-graphite-2: oklch(28% 0.018 260)
- --color-on-graphite: oklch(94% 0.008 252)
- --color-focus: var(--color-graphite)
- --color-positive: oklch(52% 0.145 148)
- --color-danger: oklch(55% 0.18 27)
- --color-warning: oklch(53% 0.13 78)

The accent remains below 3% of each viewport. Positive, danger, and warning
colours are semantic signals and always appear with text or an icon.

## Typography

- Display and technical register: SF Mono with Hiragino Sans fallback, weight
  500–600, normal.
- Body: macOS system sans with Hiragino Sans, weight 400.
- No third outlier face; operational labels and figures reuse the display face.
- These local faces avoid network requests under the app's self-only CSP.
- Display tracking: -0.025em.
- Type scale anchor: --text-display = clamp(2.25rem, 4vw + 0.5rem, 4rem).

## Spacing

Use the named 4-point scale in tokens.css. Raw spacing values are not permitted
in page CSS.

## Motion

- No page reveals.
- State changes use press, opacity, and one refresh rotation only.
- Easings are --ease-out, --ease-in, and --ease-in-out.
- Reduced-motion fallback is opacity-only and no longer than 150 ms.

## Microinteractions stance

- Successful operations update the data silently.
- Errors and warnings remain visible until superseded or dismissed.
- Delete uses a delayed commit with Undo instead of a confirmation dialog.
- Disabled actions expose their reason in visible text.
- The command palette opens from its button or Command/Ctrl + K, supports
  arrows, Enter, Escape, filtering, and focus restoration.

## CTA voice

- All operational actions are peers.
- Primary-looking controls are reserved for current state, focus, and the
  command palette selection—not for marketing emphasis.
- Buttons use 6 px radii, compact padding, and literal Japanese verbs.

## Per-page allowances

- App pages must not use illustrative enrichment.
- A single graphite surface is allowed for the command palette.
- The dashboard may use dense tabular information because it is a private tool.

## What pages MUST share

- LOCALDECK wordmark.
- Cobalt accent and semantic status tokens.
- System sans and SF Mono roles.
- Compact rectangular control voice.
- Workbench rules, density, and quiet success behaviour.

## What pages MAY differ on

- Registry column count according to the data.
- Status strip item count.
- Command groups according to available operations.

## Exports

### tokens.css

~~~css
:root {
  --color-paper: oklch(98.5% 0.004 250);
  --color-paper-2: oklch(96.5% 0.006 252);
  --color-paper-3: oklch(93.5% 0.008 252);
  --color-ink: oklch(24% 0.02 258);
  --color-ink-2: oklch(34% 0.018 257);
  --color-rule: oklch(87% 0.01 252);
  --color-rule-2: oklch(78% 0.012 254);
  --color-muted: oklch(51% 0.015 256);
  --color-neutral: oklch(42% 0.016 257);
  --color-accent: oklch(55% 0.20 256);
  --color-accent-ink: oklch(98.5% 0.004 250);
  --color-graphite: oklch(22% 0.016 260);
  --color-graphite-2: oklch(28% 0.018 260);
  --color-on-graphite: oklch(94% 0.008 252);
  --color-focus: var(--color-graphite);
  --color-positive: oklch(52% 0.145 148);
  --color-positive-soft: oklch(95% 0.034 148);
  --color-danger: oklch(55% 0.18 27);
  --color-danger-soft: oklch(95% 0.03 27);
  --color-warning: oklch(53% 0.13 78);
  --color-warning-soft: oklch(95% 0.034 78);
  --font-display: "SFMono-Regular", ui-monospace, "Hiragino Sans", "Yu Gothic UI", monospace;
  --font-body: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", sans-serif;
  --space-3xs: 0.25rem;
  --space-2xs: 0.5rem;
  --space-xs: 0.75rem;
  --space-sm: 1rem;
  --space-md: 1.5rem;
  --space-lg: 2rem;
  --space-xl: 3rem;
  --space-2xl: 4.5rem;
  --space-3xl: 7rem;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-micro: 120ms;
  --dur-short: 220ms;
  --dur-long: 420ms;
  --radius-card: 10px;
  --radius-pill: 999px;
  --radius-input: 6px;
}
~~~

### Tailwind v4 @theme

~~~css
@theme {
  --color-paper: oklch(98.5% 0.004 250);
  --color-paper-2: oklch(96.5% 0.006 252);
  --color-paper-3: oklch(93.5% 0.008 252);
  --color-ink: oklch(24% 0.02 258);
  --color-ink-2: oklch(34% 0.018 257);
  --color-rule: oklch(87% 0.01 252);
  --color-rule-2: oklch(78% 0.012 254);
  --color-muted: oklch(51% 0.015 256);
  --color-accent: oklch(55% 0.20 256);
  --color-graphite: oklch(22% 0.016 260);
  --color-graphite-2: oklch(28% 0.018 260);
  --color-on-graphite: oklch(94% 0.008 252);
  --color-focus: var(--color-graphite);
  --color-positive: oklch(52% 0.145 148);
  --color-danger: oklch(55% 0.18 27);
  --color-warning: oklch(53% 0.13 78);
  --font-display: "SFMono-Regular", ui-monospace, monospace;
  --font-body: -apple-system, BlinkMacSystemFont, sans-serif;
  --spacing-3xs: 0.25rem;
  --spacing-2xs: 0.5rem;
  --spacing-xs: 0.75rem;
  --spacing-sm: 1rem;
  --spacing-md: 1.5rem;
  --spacing-lg: 2rem;
  --spacing-xl: 3rem;
  --spacing-2xl: 4.5rem;
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-md: 1.25rem;
  --text-lg: 1.5625rem;
  --radius-card: 10px;
  --radius-input: 6px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
~~~

### DTCG tokens.json

~~~json
{
  "$schema": "https://design-tokens.github.io/community-group/format/",
  "color": {
    "paper": { "$value": "oklch(98.5% 0.004 250)", "$type": "color" },
    "paper-2": { "$value": "oklch(96.5% 0.006 252)", "$type": "color" },
    "paper-3": { "$value": "oklch(93.5% 0.008 252)", "$type": "color" },
    "ink": { "$value": "oklch(24% 0.02 258)", "$type": "color" },
    "ink-2": { "$value": "oklch(34% 0.018 257)", "$type": "color" },
    "rule": { "$value": "oklch(87% 0.01 252)", "$type": "color" },
    "rule-2": { "$value": "oklch(78% 0.012 254)", "$type": "color" },
    "muted": { "$value": "oklch(51% 0.015 256)", "$type": "color" },
    "accent": { "$value": "oklch(55% 0.20 256)", "$type": "color" },
    "graphite": { "$value": "oklch(22% 0.016 260)", "$type": "color" },
    "graphite-2": { "$value": "oklch(28% 0.018 260)", "$type": "color" },
    "on-graphite": { "$value": "oklch(94% 0.008 252)", "$type": "color" },
    "focus": { "$value": "oklch(22% 0.016 260)", "$type": "color" },
    "positive": { "$value": "oklch(52% 0.145 148)", "$type": "color" },
    "positive-soft": { "$value": "oklch(95% 0.034 148)", "$type": "color" },
    "danger": { "$value": "oklch(55% 0.18 27)", "$type": "color" },
    "danger-soft": { "$value": "oklch(95% 0.03 27)", "$type": "color" },
    "warning": { "$value": "oklch(53% 0.13 78)", "$type": "color" },
    "warning-soft": { "$value": "oklch(95% 0.034 78)", "$type": "color" }
  },
  "font": {
    "display": { "$value": "SFMono-Regular, ui-monospace, monospace", "$type": "fontFamily" },
    "body": { "$value": "-apple-system, BlinkMacSystemFont, sans-serif", "$type": "fontFamily" }
  },
  "space": {
    "3xs": { "$value": "0.25rem", "$type": "dimension" },
    "2xs": { "$value": "0.5rem", "$type": "dimension" },
    "xs": { "$value": "0.75rem", "$type": "dimension" },
    "sm": { "$value": "1rem", "$type": "dimension" },
    "md": { "$value": "1.5rem", "$type": "dimension" },
    "lg": { "$value": "2rem", "$type": "dimension" },
    "xl": { "$value": "3rem", "$type": "dimension" },
    "2xl": { "$value": "4.5rem", "$type": "dimension" }
  },
  "duration": {
    "micro": { "$value": "120ms", "$type": "duration" },
    "short": { "$value": "220ms", "$type": "duration" },
    "long": { "$value": "420ms", "$type": "duration" }
  }
}
~~~

### shadcn/ui CSS variables

~~~css
:root {
  --background: 98.5% 0.004 250;
  --foreground: 24% 0.02 258;
  --card: 96.5% 0.006 252;
  --card-foreground: 24% 0.02 258;
  --popover: 98.5% 0.004 250;
  --popover-foreground: 24% 0.02 258;
  --primary: 55% 0.20 256;
  --primary-foreground: 98.5% 0.004 250;
  --secondary: 93.5% 0.008 252;
  --secondary-foreground: 34% 0.018 257;
  --muted: 87% 0.01 252;
  --muted-foreground: 51% 0.015 256;
  --accent: 55% 0.20 256;
  --accent-foreground: 98.5% 0.004 250;
  --destructive: 55% 0.18 27;
  --destructive-foreground: 98.5% 0.004 250;
  --border: 87% 0.01 252;
  --input: 87% 0.01 252;
  --ring: 22% 0.016 260;
  --radius: 6px;
}
~~~
