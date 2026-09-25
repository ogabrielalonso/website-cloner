# Inspection Guide

## Taking a Website Apart

Use this as the capture list whenever you inspect a target site, whether through Chrome MCP or the browser's own DevTools.

## Phase 1: What the Site Looks Like

### Screenshots
- [ ] Each distinct page at desktop, tablet and mobile widths
- [ ] The dark theme, when the site has one
- [ ] The light theme, when the site has one
- [ ] Important interaction states: hover, active, menus open, modals shown
- [ ] Loading states and skeletons
- [ ] What empty views look like
- [ ] What error views look like

### Design Tokens
- [ ] **Colors:** backgrounds, text (primary, secondary, muted), accent, borders, hover, plus error, success and warning
- [ ] **Typography:** font families, the size of each level (h1 to h6, body, caption, label), weights, line heights and letter spacing
- [ ] **Spacing:** the padding and margin values in use; most sites follow a scale such as 4, 8, 12, 16, 24, 32px and up
- [ ] **Border radius:** on buttons, cards, avatars and inputs
- [ ] **Shadows and elevation:** cards, dropdowns, the overlay behind modals
- [ ] **Breakpoints:** the widths at which the layout changes (find them with DevTools responsive mode)
- [ ] **Icons:** an icon library or custom SVGs, and at which sizes
- [ ] **Avatars:** sizes, shapes, and what shows when the image is missing
- [ ] **Buttons:** every variant (primary, secondary, ghost, icon-only, danger)
- [ ] **Form fields:** text inputs, textareas, selects, checkboxes, toggles

## Phase 2: The Components

Write down the following for every distinct UI component:
1. **Name:** what you would call it
2. **Structure:** the HTML elements and child components inside it
3. **Variants:** differences in size, color or state
4. **States:** default, hover, active, disabled, loading, error, empty
5. **Responsiveness:** how it changes from one breakpoint to the next
6. **Interactions:** click, hover, focus, keyboard navigation
7. **Animations:** transitions, enter and exit animations, micro-interactions

### Components That Usually Appear
- Navigation: top bar, sidebar, bottom bar
- Content containers: cards, list items
- Actions: buttons, links
- Forms: inputs and the other form controls
- Overlays: modals, dialogs, dropdowns, menus, tooltips, popovers
- Switchers: tabs, segmented controls
- Identity: avatars, user badges
- Feedback: loading skeletons, toast notifications

## Phase 3: How Pages Are Laid Out

- [ ] **Layout system:** CSS Grid, Flexbox, or fixed widths
- [ ] **Columns:** the column count at each breakpoint
- [ ] **Content width:** the max-width of the main content area
- [ ] **Sticky parts:** header, sidebar, floating buttons
- [ ] **Stacking order:** z-index of navigation, modals, tooltips, overlays
- [ ] **Long content:** infinite scroll, pagination, or virtualized scrolling

## Phase 4: What It Is Built With

- [ ] **Framework:** React, Vue, Angular? Look for `__NEXT_DATA__`, `__NUXT__`, `ng-version`
- [ ] **Styling approach:** Tailwind utility classes, CSS Modules, Styled Components, Emotion, or plain CSS
- [ ] **State management:** Redux (visible in its DevTools), React Query, Zustand, Pinia
- [ ] **APIs:** REST or GraphQL (watch the network tab for `/graphql` requests)
- [ ] **Fonts:** Google Fonts, self-hosted files, or system fonts
- [ ] **Images:** CDN delivery, lazy loading, srcset, WebP or AVIF
- [ ] **Motion:** a library such as Framer Motion or GSAP, or plain CSS transitions

## Phase 5: Files to Write

When the inspection is done, write these files to `docs/research/`:
1. `DESIGN_TOKENS.md`: every color, typography and spacing value extracted
2. `COMPONENT_INVENTORY.md`: each component, with notes on its structure
3. `LAYOUT_ARCHITECTURE.md`: page layouts, the grid system, responsive behavior
4. `INTERACTION_PATTERNS.md`: animations, transitions, hover states
5. `TECH_STACK_ANALYSIS.md`: what the site is built with and the equivalents we chose
