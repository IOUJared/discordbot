# Discord Music Remote Design System

## 0. Research Log

- **Embedded refs:** shortlisted Layer B Spotify (content-led dark music), Linear (compact operational restraint), and Sentry (dense dark tools) → selected **Layer A `minimalist-skill.md` + Layer B `spotify.md`**: the former prevents decorative sprawl; the latter contributes only the content-first charcoal hierarchy and album-art color role. No brand marks, proprietary type, green accent, pill-everything geometry, or copied screens are permitted.
- **Lazyweb:** 3 queries, 3 screens viewed (`music player dashboard queue desktop`; `music remote control playback mobile`; `dark dashboard audio controls`) → extracted only the layout grammar: a persistent player, visibly ordered queue, clear current-track focus, and a one-hand mobile control zone. Third-party screenshots were viewed transiently and are not retained in this repository.
- **Imagen drafts:** `.omo/evidence/design-research/concepts/concept-a-desktop-shell.png`, `.omo/evidence/design-research/concepts/concept-b-mobile-remote.png`, `.omo/evidence/design-research/concepts/concept-c-control-room.png` → selected `concept-c-control-room.png` as the desktop reference-fidelity contract; `concept-b-mobile-remote.png` confirms the mandatory mobile collapse order. These are original research drafts, not shipped artwork.
- **Interaction source:** consulted beui.dev `button`, `animated-badge`, `range-slider`, and `animated-toast-stack` source. Adopt mechanisms, not styling: press feedback, status change, slider drag feedback, stacked notification entry/exit, and their reduced-motion alternatives.

## 1. Atmosphere & Identity

This is a quiet control room for a private listening session: precise, compact, and warmly human without impersonating Discord or a music service. The interface recedes into ink and graphite so the current artwork can carry the room’s emotional color. Its signature is the **album-color instrument panel**—one artwork-led visual anchor above a thin, exact playback line, with muted indigo appearing only when a control has focus, state, or consequence. The chosen concept’s three-plane desktop composition (room, now playing, queue) is the reference contract; the companion mobile draft preserves that order as room context → artwork/current track → transport → queue.

## 2. Color

### Palette

| Role | Token | Dark value | Usage |
|---|---|---:|---|
| Canvas | `--surface-canvas` | `#0B0D12` | Shell background |
| Recessed | `--surface-recessed` | `#10131A` | Rails, player footer |
| Primary surface | `--surface-primary` | `#151923` | Main content plane |
| Raised surface | `--surface-raised` | `#1B202C` | Sheet, menu, active control group |
| Hover surface | `--surface-hover` | `#242B39` | Hovered row/control only |
| Text primary | `--text-primary` | `#F5F7FB` | Titles and essential controls |
| Text secondary | `--text-secondary` | `#B7BFCE` | Artist, time, supporting labels |
| Text muted | `--text-muted` | `#7E899C` | De-emphasized metadata and disabled labels |
| Divider | `--line-subtle` | `#2A3040` | Structural separators, never card decoration |
| Focus outline | `--focus-ring` | `#B8C4FF` | 2px keyboard focus outline |
| Indigo 050 | `--indigo-050` | `#171B2B` | Selected-row tonal wash |
| Indigo 100 | `--indigo-100` | `#222947` | Quiet selected surface |
| Indigo 200 | `--indigo-200` | `#303A68` | Hovered active control |
| Indigo 300 | `--indigo-300` | `#414F8D` | Secondary actionable fill |
| Indigo 400 | `--indigo-400` | `#596BBC` | Primary actionable fill with white text |
| Indigo 500 | `--indigo-500` | `#7D8FE4` | Active icon, progress fill, status emphasis |
| Indigo 600 | `--indigo-600` | `#B8C4FF` | Focus-visible / high-clarity active detail |
| Success | `--status-success` | `#4EC98A` | Confirmed connection or completion, never a brand accent |
| Warning | `--status-warning` | `#E1B35A` | Recoverable caution |
| Error | `--status-error` | `#F07883` | Failed action and destructive affordance |
| Info | `--status-info` | `#93A8FF` | Neutral service message |

### Rules

- The indigo ramp is functional, not atmospheric: `050–100` selected context, `200–300` hover/secondary action, `400` primary action, `500` active indicator/progress, and `600` focus visibility. Do not add arbitrary opacity variants.
- Album art is the sole vivid non-semantic color source. It may appear in the artwork frame and its thumbnail only; it never recolors text, shell surfaces, or controls.
- No green primary action, no Spotify color/mark, no Discord blurple/mark, and no copied palette.
- Body text meets WCAG 2.2 AA 4.5:1 minimum against its assigned surface; large text and non-text controls meet 3:1 minimum. `--focus-ring` must remain visible on every surface.

## 3. Typography

### Scale

| Level | Token | Size | Weight | Line height | Tracking | Usage |
|---|---|---:|---:|---:|---:|---|
| Display | `--type-display` | 32px | 650 | 1.12 | -0.025em | Current track at spacious desktop widths only |
| H1 | `--type-h1` | 24px | 650 | 1.2 | -0.02em | Primary screen heading |
| H2 | `--type-h2` | 20px | 600 | 1.25 | -0.01em | Section heading |
| H3 | `--type-h3` | 16px | 600 | 1.35 | 0 | Track / panel title |
| Body | `--type-body` | 15px | 450 | 1.5 | 0 | Default UI copy |
| Body compact | `--type-body-compact` | 14px | 450 | 1.4 | 0 | Queue rows and controls |
| Label | `--type-label` | 12px | 600 | 1.35 | 0.04em | Uppercase utility label only |
| Meta | `--type-meta` | 12px | 450 | 1.35 | 0.01em | Duration and secondary metadata |
| Mono meta | `--type-mono` | 12px | 500 | 1.35 | 0 | Timecode and shortcut hints |

### Font stack

- UI / display: `"Instrument Sans", "Noto Sans", ui-sans-serif, system-ui, sans-serif` — Instrument Sans is SIL Open Font Licensed; the rest are open-licensed/system fallbacks. Never use Inter or proprietary Spotify fonts.
- Mono: `"JetBrains Mono", ui-monospace, SFMono-Regular, Consolas, monospace` — JetBrains Mono is Apache 2.0 licensed.
- Two families maximum. Use case, spacing, and weight—not a third family—to establish hierarchy.

### Rules

- The UI is compact but never below 12px; task-critical labels and touch targets use 14px or more.
- Use sentence case. All-caps is reserved for short utility labels, never track or error copy.
- Long track/artist names clamp to two lines in now-playing and one line with an accessible full-name label in queue rows.

## 4. Spacing & Layout

### Base unit

All spatial values derive from **4px**.

| Token | Value | Usage |
|---|---:|---|
| `--space-1` | 4px | Icon-to-label tight pairing |
| `--space-2` | 8px | Inline controls, queue row interior |
| `--space-3` | 12px | Compact panel rhythm |
| `--space-4` | 16px | Standard screen padding |
| `--space-5` | 20px | Control groups |
| `--space-6` | 24px | Main panel padding |
| `--space-8` | 32px | Major inner separation |
| `--space-10` | 40px | Page section break |
| `--space-12` | 48px | Spacious desktop heading break |

### Shell and scroll ownership

| Layout state | Width | Frame | Fixed / persistent regions | Vertical scroll owner |
|---|---:|---|---|---|
| Desktop | `>= 1024px` | `100dvh` three-plane grid. At the selected reference's exact 1568×1003 viewport: 337px room rail / 670px player / 561px queue above a 156px player footer. Below that reference size the outer planes and footer scale fluidly toward 216px / 320px / 80px minima. | Room rail, player footer, queue heading | Main player body owns its own scroll; queue body owns its own scroll; room rail scrolls only if its own navigation overflows. The document never scrolls. |
| Tablet | `768–1023px` | `100dvh` grid: 64px icon rail / `minmax(0,1fr)` player; 72px footer | Icon rail, header, player footer; queue opens as a modal drawer | Main player body is the sole shell scroll owner. Drawer has a separately named queue-list scroll body and locks background scroll. |
| Mobile | `< 768px` | `100dvh` grid: 56px header / `minmax(0,1fr)` content / 72px control footer | Header and 72px control footer; room switcher is header action | Main content is the sole vertical scroll owner. Queue opens as bottom sheet; only its list body scrolls and background is locked. No nested carousel/list scrollbar. |

Implementation geometry uses named aliases so responsive CSS never repeats one-off dimensions: `--rail-width` (`clamp(216px,21.492347vw,337px)`), `--rail-collapsed` (64px), `--queue-width` (`clamp(320px,35.778061vw,561px)`), `--footer-desktop` (`clamp(80px,15.55334dvh,156px)`), `--footer-art` (96px), `--header-mobile` (56px), `--footer-mobile` (72px), `--panel-max` (720px), `--art-max` (598px), `--art-ratio` (the reference-derived 1.2916 landscape frame), `--art-mobile` (`clamp(220px,65vw,244px)`), `--drawer-tablet` (420px), `--queue-row` (64px), and `--queue-dock-min` (240px). The outer-plane maxima and artwork frame are derived directly from the selected 1568×1003 desktop reference; the 96px footer artwork, 240px lower queue module, and 244px maximum mobile artwork reproduce the observed Concept C density and Concept B 375×666 above-fold transport composition. Their minima preserve usability at narrower widths. Tablet and mobile keep their independent drawer/sheet geometry and square artwork collapse.

- Use logical properties, dynamic viewport units, and `min-block-size: 0` on every scroll child. No `100vh` shell and no unbounded flex/grid child.
- Desktop content has 24px gutters and `max-inline-size: 1440px`; tablet has 20px gutters; mobile has 16px gutters. The desktop center column uses a content-limiter of 720px for now-playing metadata and transport.
- Main queue tracks use an overflow-safe intrinsic grid only for artwork collections: `repeat(auto-fit, minmax(min(12rem, 100%), 1fr))`. The queue itself remains a single readable list.
- At 200% zoom, desktop adopts tablet behavior before controls collide; at 375px, every primary action remains in one readable column without horizontal primary-content scroll.

### Responsive content order

1. Room/context and connection status.
2. Current artwork, title, artist, and elapsed/remaining time.
3. Transport and volume/device controls.
4. Queue and request management.

This order is invariant; desktop reveals it concurrently, tablet defers queue to a drawer, and mobile defers queue to a sheet. On mobile the voice-channel selector is a collapsed secondary disclosure after playback/request content, so it cannot displace artwork, metadata, or transport from the initial 375×666 viewport.

## 5. Components

### Primitive showcase contract (before product screens)

Build a non-product `/design-system` showcase first. At 375px, 768px, and 1280px it must render every primitive below in **default, hover, active/pressed, focus-visible, disabled, loading, empty, and error** states where meaningful; state-only cases use an explicit “not applicable—static content” label rather than being silently omitted. Exercise keyboard focus order, long strings, no artwork, no queue rows, failed command, disconnected room, and reduced motion before composing dashboard screens. This is a binding implementation contract; no UI component is created by this document.

### App shell

- **Structure:** `header + room-nav + main(now-playing) + queue-region + player-footer`.
- **Variants:** desktop three-pane, tablet icon-rail + queue drawer, mobile header + queue sheet.
- **Spacing / layout:** `scroll-body-shell`, 4px token rhythm, exact ownership in Section 4.
- **States:** default; hover on actionable rail items; active selected room; focus-visible; disabled unavailable room; loading reconnect skeleton; empty no active room; error failed room load.
- **Accessibility:** named landmarks, skip link into main, one `h1`, predictable focus return when drawer/sheet closes.

### Room navigation

- **Structure:** `nav > button/listitem > Phosphor icon + room label + optional status`.
- **Variants:** labeled desktop, icon rail tablet, room-switch trigger mobile.
- **States:** common showcase contract; selected state uses `--indigo-100` plus a non-color current indicator; disabled rooms explain why by accessible description.
- **Accessibility / motion:** arrow-key roving focus only if implemented as a composite widget; otherwise native button tab sequence. The active indicator moves by opacity/color transition, not layout shift.

### Now-playing panel and artwork frame

- **Structure:** `section > artwork figure + heading/artist + seek range + actions`.
- **Variants:** full desktop, compact tablet, mobile stacked.
- **States:** default artwork; hover only on actionable artwork menu; active command; focus-visible menu; disabled unavailable command; loading metadata/skeleton; empty “Nothing is playing”; error unavailable media.
- **Accessibility:** artwork has informative `alt` only when it identifies media; otherwise empty alt. Track, artist, elapsed time, and playback state are exposed as text, not color.

### Transport button group

- **Structure:** native `button` elements for previous, play/pause, next, shuffle, repeat; Phosphor icons at a consistent bold weight.
- **Variants:** compact icon, primary play/pause, destructive stop if later needed.
- **States:** common showcase contract. Async command maps loading → success/error feedback while preserving its accessible name. Disabled controls remain discoverable with reason text.
- **Accessibility / motion:** minimum 44px target, visible focus ring, Space/Enter activation, no keyboard trap. Adapt beui `button` source: one press-scale transform only, cancelable on pointer release; reduced motion removes the transform and retains color/label feedback.

### Seek / volume range control

- **Structure:** labelled native range input + elapsed/current value + optional mute button.
- **Variants:** seek, volume, disabled, indeterminate loading.
- **States:** default, hover, active drag, focus-visible, disabled, loading stream position, empty unavailable media, error seek rejected.
- **Accessibility / motion:** native keyboard increments and announced values; never require drag. Adapt beui `range-slider`: spring-smoothed visual fill and 1.35× vertical thumb feedback only while dragging; reduced motion is immediate position without transform. Use `--indigo-500` for value fill.

### Queue list and queue sheet/drawer

- **Structure:** `section > heading/actions + ol > draggable-or-button row + empty/error region`.
- **Variants:** desktop pane, tablet modal drawer, mobile bottom sheet.
- **States:** common showcase contract; queue rows also cover selected, pending reorder, loading rows, empty “No requests”, and failed reorder with retry.
- **Accessibility:** queue count in heading, semantic ordered list, contextual actions labelled with track name, drag alternative via move-up/move-down controls, focus moves into overlay and returns to trigger.
- **Motion:** drawer/sheet opacity + transform only; no background scroll. Reduced motion uses instant opacity transition and no translated travel.

### Connection badge

- **Structure:** status text + icon/dot, never dot-only.
- **Variants:** connected, reconnecting, disconnected, degraded.
- **States:** default connected, hover if details trigger, focus-visible, disabled unavailable details, loading reconnecting, empty no configured room, error disconnected. Active does not apply and is labelled so in the showcase.
- **Accessibility / motion:** status is announced through a polite live region only when it changes. Adapt beui `animated-badge`: one short opacity/icon swap; reduced motion uses an immediate text update, never a pulsing dot.

### Playback source settings

- **Structure:** `section > heading/explanation + status + fieldset(priority) + connection action`.
- **Variants:** Mock TIDAL simulator connected or disconnected; “Mock TIDAL first, then YouTube” or “YouTube only”. This surface never requests an API key, password, OAuth token, or real TIDAL account.
- **States:** connected status names the local 48 kHz lossless WAV simulator; disconnected status explains that search uses YouTube. Pending mutations disable the affected controls, failures remain adjacent to the action, and successful changes are announced politely.
- **Visual language:** existing raised/recessed surfaces, indigo selection, compact labels, and native radio controls. No TIDAL logo, copied brand treatment, or color token is introduced; the word “Mock” remains visible wherever the source is identified.
- **Accessibility:** native `fieldset`/`legend`, 44px labelled rows, visible focus, keyboard selection, and live connection text. Mobile reaches settings from the header and returns to the player using the same toggle control.

### Toast stack

- **Structure:** polite live region containing individually dismissible status notifications.
- **Variants:** info, success, warning, error, queued action retry.
- **States:** default hidden, hover pause-dismiss, active dismiss, focus-visible dismiss, disabled automatic dismissal when action required, loading pending command, empty no notifications, error failed command.
- **Accessibility / motion:** no auto-dismiss for errors with recovery action; do not steal focus. Adapt beui `animated-toast-stack`: stack layout spring and content opacity swap; reduced motion removes positional spring and uses an opacity change only.

## 6. Motion & Interaction

### Timing

| Token | Value | Usage |
|---|---|---|
| `--motion-micro` | 120ms `cubic-bezier(.2,.8,.2,1)` | Hover tint, press feedback |
| `--motion-standard` | 220ms `cubic-bezier(.16,1,.3,1)` | Drawer/sheet opacity, toast content |
| `--spring-control` | stiffness 240, damping 24, mass .8 | Interruptible control/indicator position only |
| `--spring-stack` | stiffness 420, damping 34, mass .75 | Toast stack layout only |

### Rules

- Motion explains a state change; it is never decorative. Animate only `transform`, `opacity`, and (sparingly) `filter`.
- Button press feedback, connection change, range drag, drawer/sheet, and toast are the only initial motion patterns. No page-load reveals, parallax, ambient loops, or animated album art.
- On `prefers-reduced-motion: reduce`, remove transform/spring travel, shimmer, and blur; preserve an immediate color/text/state change and all feedback semantics.
- Beui source was consulted for the nearest mechanisms: `button`, `animated-badge`, `range-slider`, and `animated-toast-stack`. Implementations must respect this document’s tokens over upstream values and use the existing project stack rather than adding a motion library by default.

## 7. Depth & Surface

### Strategy: tonal shift

Depth comes from `canvas → recessed → primary → raised → hover` surface steps, not card stacks. Containers use 8px radius maximum; large areas do not become pills. Default cards have no shadows and no decorative borders. Structural separators may use the single `--line-subtle` token; focused controls use the 2px `--focus-ring` outline. Modal drawer/sheet separation is tonal plus an opaque backdrop, with no drop shadow.

| Layer | Token | Usage |
|---|---|---|
| 0 | `--surface-canvas` | Outer shell |
| 1 | `--surface-recessed` | Rails and player footer |
| 2 | `--surface-primary` | Main content |
| 3 | `--surface-raised` | Drawer, sheet, menu |
| 4 | `--surface-hover` | Hover/pressed row only |

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Target **WCAG 2.2 AA**: 4.5:1 normal text, 3:1 large text/non-text controls, 44px minimum touch targets for transport and footer actions, 24px minimum for dense inline controls with sufficient spacing.
- Keyboard/screen-reader persona: every control is native or correctly semantically equivalent; logical Tab order, visible focus, labelled icon buttons, live regions only for status changes, and focus managed in queue drawer/sheet.
- Low-vision/200%-zoom persona: compact typography never drops below 12px; text zoom and 200% browser zoom reflow to the tablet/mobile shell without lost actions or horizontal primary-content scroll.
- Situational one-hand mobile persona: play/pause, next, queue, and device controls remain in the lower reachable region; gesture-only reorder/dismiss has a labelled button alternative.
- Error recovery is plain-language, specific, and adjacent to retry/reconnect action; color is never the only signal.
- Reduced motion and high-contrast operating-system preferences are honored. Do not depend on a color scheme switch to make a task reachable.

### Accepted debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|

None at design-contract creation. New debt requires an affected persona, explicit owner acceptance, and a remediation path before it may be recorded here.
