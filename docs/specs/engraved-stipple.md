# Engraved stipple for the Points view (animals counted by area)

Status: draft for build. Decisions marked **Final** are settled. Values marked **Tune** are starting points I chose by calculation, to be judged by eye with Joseph on real animals. Nothing here is a measured result.

## Problem

Joseph: "the scaling feels odd when zooming in. everything remains the same."

For animals with `binned` (0.35° squares, `AREA_CELL` in `src/heat.ts`), the Points view draws `createCellDots`: one filled circle per square, sized as a share of the square on the ground, in 5 classes cut from the whole range (`HEAT_TOP`). Three failures follow from that:

1. The dots are ground geometry. At the whole-globe view they are specks; at state zoom they are big overlapping blobs.
2. The classes never change. Zooming into one state shows the same pattern, only bigger. Nothing new appears.
3. Zoomed in, the regular 0.35° lattice shows through as a grid.

The heatmap already solved (2) with a detail layer redrawn from what is in view once the camera settles (`updateDetail` in `src/stage.ts`). Points has no equivalent.

## User

There are no persona files yet (`docs/research/personas/` holds only a README). I am designing for the user CLAUDE.md names: anyone curious where an animal lives, arriving with no mapping literacy, exploring by zooming from the globe into a place they know (their country, their state).

Assumption that carries the decision: **people read "more marks, closer together" as "more records here" without a size cue.** Engravings and dot-density maps rely on this, but I have no evidence from this app's users. How to test it cheaply: with 5 people, open one binned animal in Points, zoom to a state they know, and ask "where has this animal been recorded most?" and "what does an empty patch mean?". Pass if they point at the densest stipple and say empty means no records (not "no animals"). Results go here when run: `[gap: test not yet run]`.

## Decision

**Final.** For binned animals, the Points view draws the range as stipple: many fine marks of a fixed screen size, scattered inside each square that has records. Record density is shown by how closely the marks are packed (and, as a redundant cue, by the same warm-to-yellow ink ramp as the heatmap). Marks never grow when you zoom. As squares grow on screen, more marks fill them, and once the camera settles below the detail altitude the grades are re-cut against the squares in view, so local contrast appears where the whole-range grading had flattened it.

What the viewer reads first, and why that order is right:
1. The densest, brightest stipple: where this animal is recorded most. That is the question most people bring.
2. The faint dusting around it: the extent of the range.
3. The hard empty edge where squares stop: no records beyond here.
4. Then the plate legend, for the grading.

## How it works

### Data and weights (Final)

- Input: the same filtered `points` array `showRange` receives today (already clipped to the animal's listed continents by the previous commit), snapped onto the lattice exactly as `createCellDots` does (`snap`, merge duplicates by summing counts).
- Weight of a square: its own count (third value in `public/data/points/<id>.json`). If no point in the file has a third value, fall back to the existing 2° surface sampled at the square (`smoothed(cells)` in `createCellDots`). Keep that fallback; current builds always write the count, older cached files may not.
- Classes: 5 classes from `HEAT_TOP` quantiles of square weights, using the existing break rule in `createCellDots` (breaks must rise, so ties collapse classes instead of inventing a top class). Quantiles count squares, unweighted, as today.

### Honesty rules (Final)

- Every mark's centre lies inside a square that has records, inset 4% of the square's side from each edge, so antialiasing or rounding cannot push a mark into an empty neighbour.
- No mark is ever placed in a square without records. No smoothing, kernel or jitter crosses a square's edge.
- Marks inside a square are spread evenly. They do not encode where in the square the records were, and the copy says so. The data does not have finer positions for binned animals, so the stipple must not pretend it does.

### Placement (Final)

- Each square is identified by integer lattice indices: `row = floor((90 - lat) / AREA_CELL)`, `col = floor((lng + 180) / AREA_CELL)`. Seed = a 32-bit integer hash of `(row, col)` (any stable mix, for example a xorshift/murmur finaliser). Never seed from floats.
- Candidate marks per square come from an ordered, low-discrepancy sequence: the R2 sequence, `p_i = frac(o + i * (0.7548776662, 0.5698402910))`, where `o` is a 2D offset derived from the seed. Map `p_i` into the inset square in lat/lng (longitude extent divided by `cos lat` as in `createCellDots`).
- Why R2: any prefix of it is evenly spread. Showing "the first N marks" for any N looks like proper stipple, and showing N+1 adds a mark without moving the others. That is what makes zooming in add detail instead of reshuffling.
- Per-mark size jitter: multiply mark size by `0.9 + 0.2 * hash(seed, i) / 2^32` (revised from 0.85 to 1.15, see Mark appearance). Gives the hand-pulled look of an engraving without implying anything about the data.
- Same seed and sequence in the world and detail layers, so the first marks of a square sit in the same place in both.

### Mark appearance (Final shape and colour, Tune size)

Revised 2026-10-28 after the first in-browser check: the 3 px mark's rim was under a pixel at `dpr` 1 to 1.5, so it blended away and marks fell under 3:1 over snow and sand.

- Rendered as screen-space `THREE.Points` with a custom shader, like the existing `records` layer. Size is in CSS pixels times the renderer's clamped `dpr` (the same `dpr` that `setPointSize` uses, including the slow-frame downgrade).
- Point sprite: 4.5 CSS px (`MARK_PX`, Tune). Fragment: a round core of radius 0.27 of the sprite (`MARK_CORE`, about 2.4 CSS px across) in the class ink, a dark rim from there out to the sprite's edge (0.5) in `#1c0904` (the `records` rim colour). The core-to-rim edge is hard (a step); only the outer edge is antialiased, over half a device pixel inside the sprite. Discard below alpha 0.01.
- Core ink per class: the RGB of `HEAT_BANDS[1..5]` at alpha 1.0. The rim at alpha 0.95.
- Per-mark size factor 0.9 to 1.1 (narrowed from 0.85 to 1.15 so the smallest mark still keeps a whole-pixel rim).
- Why a rim: the globe is satellite imagery with dark forest and ocean but also snow and desert. Checked by a per-pixel simulation of the sprite as the GPU rasterises it (pixel centres inside the point, `gl_PointCoord` at each centre, the fragment shader's colour and alpha composited over the ground), at `dpr` 1, 1.25, 1.5 and 2, size factors 0.9, 1.0 and 1.1, 64 sub-pixel positions, all five grades. Against white, snow `#ebeef2`, sand `#dec496` and dark sand `#c4a070`, every case has at least 4 pixels at 3:1 or more, and the best pixel is at least 7:1. Against dark forest `#1e321e` (where the core carries the contrast) every case has at least 2 pixels at 3:1 or more, the best at least 4.4:1. The ground colours are my picks, not samples from the texture. The old 3 px mark failed 193 of 240 light-ground cases in the same simulation.
- Why not short strokes (hachures): their direction would read as flow or slope, which the data does not have.

### Density mapping (Tune values, Final formula)

Revised 2026-10-28 after the first in-browser check: at continent zoom most squares showed no mark at all and the map did not read as a tone.

Target spacing between marks, in CSS px, per class 1 to 5: `S = [10.3, 8.5, 7.05, 5.94, 5.15]`. They are set from target ink coverage: with a 4.5 px mark (about 15.9 px² of ink), they cover about 15%, 22%, 32%, 45% and 60% of the ground in a run of squares with records. So the top grade reads as near-solid stipple and the lowest as a clear dusting, 4x apart. Coverage is the same at every zoom: zoomed out it comes from the share of squares that light, zoomed in from marks per square.

In the vertex shader, per mark `i` (0-based) of a square of class `k`:

```
pxPerUnit = viewportHeightCssPx / (2 * tan(fov / 2) * viewDepth)        // viewDepth = -mvPosition.z
side      = R * AREA_CELL * PI / 180                                     // ground side of a square, world units
facing    = max(0, dot(surfaceNormal, directionToCamera))               // world space
lambda    = (pxPerUnit * side)^2 * cos(lat) * facing / (S[k] * spacingScale)^2
lambda    = max(lambda, floorLambda * facing)                            // presence floor, below
lambda    = facing > 0 ? lambda : 0                                      // nothing on the far side
alpha     = clamp((lambda - i - h) * 5, 0, 1)                            // 0: not drawn (gl_PointSize = 0)
```

- `lambda` is the expected number of marks in that square at the current zoom. Zooming changes it every frame on the GPU, so marks appear one by one and fade in over a fifth of a mark, never pop, with no CPU work.
- `h` is the square's dither threshold in [0, 1): `frac(0.5 + row * 0.7548776662 + col * 0.5698402910)`, the R2 sequence over the lattice. Mark `i` shows once `lambda > i + h`, so the expected count is still about `lambda`. Where `lambda` is under 1 (zoomed out, squares smaller than a mark), that lights an evenly spread share of the squares at full strength, instead of every square at a faint alpha, which is what made the first build unreadable. The same squares light every time.
- `facing` thins marks toward the limb. Without it the same marks crowd into foreshortened squares and the limb reads darker, which would look like more records at the edge of the globe. The floor is multiplied by `facing` too, for the same reason: single-mark squares crowded at the limb read as a bright rim.
- Presence floor (aggregation over the neighbourhood): `floorLambda = min(1, 2 / n)`, where `n` is the number of squares with records in the square's 5x5 lattice neighbourhood (itself included). So a lone square or a pair keeps a whole mark each (as before), and a thin patch of range keeps about 2 marks per 5x5 neighbourhood between its squares, so its shape shows from the whole globe. Marks still fall only in squares with records. Precomputed on the CPU from the lattice.
- When the animal has fewer than 30 squares in total, every square gets `floorLambda = 1`.

Expected marks per square from the density term, at the equator, facing the camera, fov 50° (confirmed: three-render-objects creates `new PerspectiveCamera()`, whose default is 50°, and globe.gl does not change it). Calculated, not measured. Under 1, the number is also the share of squares lit.

| Viewport | Altitude | Square on screen | Class 1 | Class 2 | Class 3 | Class 4 | Class 5 |
|---|---|---|---|---|---|---|---|
| 900 x 600 | 2 | 2.0 px | 0.04 | 0.05 | 0.08 | 0.11 | 0.15 |
| 900 x 600 | 1 | 3.9 px | 0.15 | 0.22 | 0.31 | 0.44 | 0.59 |
| 900 x 600 | 0.5 | 7.9 px | 0.59 | 0.86 | 1.25 | 1.77 | 2.35 |
| 900 x 600 | 0.3 | 13.2 px | 1.63 | 2.40 | 3.48 | 4.91 | 6.53 |
| 1400 x 900 | 2 | 3.0 px | 0.08 | 0.12 | 0.18 | 0.25 | 0.33 |
| 1400 x 900 | 1 | 5.9 px | 0.33 | 0.49 | 0.71 | 0.99 | 1.32 |
| 1400 x 900 | 0.5 | 11.8 px | 1.32 | 1.94 | 2.82 | 3.97 | 5.29 |
| 1400 x 900 | 0.3 | 19.7 px | 3.67 | 5.39 | 7.84 | 11.04 | 14.69 |

The floor adds to this where it is higher. In a solid run of squares it is 2/25 = 0.08 per square, so on the 900 x 600 screen at altitude 2 the lowest three grades read alike (about the floor's 33% coverage there): at that zoom on a small screen the map shows the range's extent more than its grades. On the 1400 x 900 screen the floor's coverage at altitude 2 is about 14%, under the lowest grade, so all five grades separate. From altitude 1 down the density term is above the floor in any solid run.

### Two layers across zoom (Final)

Mirrors the heatmap's world and detail layers, with the same `DETAIL_ALT = 0.9` and `SETTLE_MS = 160`.

- **World stipple layer**, altitude 0.9 and above, and while moving below it until the settle. All squares, classes from the whole range, up to `M_world = 6` candidate marks per square (enough for class 5 at altitude 0.9 on a 1440 px tall viewport, where `lambda` is about 6.3). Built once per animal in `showRange`.
- **Detail stipple layer**, below 0.9 after the camera settles. Built from the squares inside the same box the heat detail uses (`halfSpan = min(80, altitude * 30 * max(1, aspect) * 1.5)`), plus a one-square margin.
  - Re-banding: if the box holds at least 30 squares, classes are re-cut from the squares in the box. Below 30, keep the whole-range classes. Reason: 3% of 30 is about one square, the smallest set where the top grade can hold anything.
  - Candidates per square: `n = min(256, ceil(lambdaAtSettle(k) * 1.6) + 1)`, where `lambdaAtSettle` uses the view-centre scale. The 1.6 headroom covers zooming in to 0.8x the drawn altitude before the existing freshness check (altitude ratio 0.8 to 1.25, pan under 0.3 of `halfSpan`) triggers a redraw: 1/0.8 = 1.25 in length is 1.56 in area.
  - Redrawn on the same freshness rule as the heat detail. Keep a separate `drawnAt` for stipple, or reset it on mode switch, so switching Heatmap/Points never reuses the other layer's box.
- `updateDetail` currently returns early when `coarse` or not in heat mode. Extend it so binned animals in Points mode run the stipple path, and non-binned animals in Points mode run nothing (as today).

### Transitions (Final)

- World to detail, detail to detail, detail to world: a 200 ms crossfade of per-layer opacity uniforms, ease-out. Double-buffer the detail layer (A/B) so the old one fades out while the new one fades in. Because both layers share seeds and sequence, a square's first marks overlap exactly and only the marks that change grade visibly fade.
- `prefers-reduced-motion: reduce` (the existing `reduced` flag): swap instantly, no crossfade. The per-mark fade in the shader stays: it follows the user's own zoom input, it does not move on its own.
- Switching Heatmap/Points: instant, as today.

### Performance limits (Final rule, Tune numbers)

- World layer budget: 400,000 marks. If `squares * 6` exceeds it, `M_world = max(2, floor(400000 / squares))`. Densest areas then look slightly lighter between altitude 0.9 and about 1.2, and the detail layer takes over below that.
- Detail layer budget: 250,000 marks. Estimate the total from the per-square `n` before building. If over, raise `spacingScale` to `sqrt(estimate / 250000)` and recompute `n`. This lightens every grade by the same factor, so their order and relative tone hold; nothing is dropped from one area and kept in another.
- Building the detail buffer must not block input: target under 50 ms on a mid-range laptop for the 250,000-mark case. If it does not meet that when measured, build in a worker or in chunks across frames while the old layer stays up. Measured 2026-10-28 in Node 25 on Joseph's Mac (not in a browser, and not on a mid-range laptop), timing the pure build in `src/stipple.ts` (box selection, re-banding, candidate counts and vertex buffers) for the Southern elephant seal at its heaviest view found by a sweep (altitude 0.25, 2560 by 1440 screen, 249,999 marks): median 12.5 to 13.1 ms over three runs of 40, slowest single build 26 ms. Re-measured after the density revision (heaviest view now altitude 0.25 on 1440 by 900, 249,999 marks): median 15.7 and 16.0 ms over two runs of 40, slowest 27.5 ms. Not included: the GPU upload of the new buffers and the in-view check, which were not timed. Built on the main thread for now. `[gap: browser timing on a mid-range laptop not yet measured]`
- I do not know the largest square count in the current data. Before building, run a one-off count over `public/data/points/*.json` for binned animals and record the top three here. Counted 2026-10-28 over 237 binned animals: Southern elephant seal 38,380, barn swallow 33,066, rock dove 26,938; the average is 4,622. At 6 marks each the largest world layer is about 230,000 marks, under the 400,000 budget.
- Per-vertex attributes: position, candidate index `i`, class `k`, presence floor flag, size jitter. Packing is the engineer's call.

## Rejected alternatives

- **Fixed-pixel graduated dots, one per square.** Fixes the ballooning but not "nothing new appears", turns solid zoomed out where 3 px dots on 3 px squares touch, and brings the lattice grid back zoomed in.
- **Rescaling the ground dots by altitude.** Same lattice, same classes. It treats the symptom Joseph described as size when the actual complaint is that nothing changes.
- **Scattering marks around squares with a kernel or random offsets.** Prettier edges, but it puts marks where there are no records. Breaks the honesty rule.
- **Rebuilding all marks on the CPU every frame.** The shader threshold does the same job continuously for free.
- **Cream monochrome ink, the purist engraving.** Loses the shared key with the heatmap and separates poorly over snow without changing the rim. The heatmap ramp keeps both modes in one vocabulary.
- **Stipple for non-binned animals too.** Out of scope, deliberately. Their points are real (rounded) record positions drawn at fixed screen size, so zooming in already reveals more as they spread apart. Stippling them would mean inventing mark positions around each record, which implies records where there are none. Whether their point style should later match the stipple mark (size, rim) is an open question below.

## Copy (exact strings)

All in the binned branch of `renderPlate` in `src/main.ts`. Non-binned strings are unchanged.

- `.map-caveat` in Points mode for binned animals:
  `The stipple shows where people logged this animal on GBIF, not an expert range map.`
- Legend key: replace `heatLegend('top 50% of squares', 'top 3%')` with a stipple key of 5 swatches, ends labelled `every square with records` and `busiest 3%`. Each swatch is a small inline SVG (about 30 by 12 CSS px) with dots drawn by the same R2 sequence at that class's spacing and ink, on `var(--bg)`. Keep `aria-hidden="true"` on the key, as now. (The current low label "top 50% of squares" sits under the swatch that stands for all squares, which is why I am changing it.)
- `.legend-point` line: `Marks fall only in squares with records; closer and brighter where there are more` followed by the existing ` · N shown` suffix, reworded to ` · ${n} squares`. The `<i>` glyph becomes three 2 px dots in a cluster instead of one 7 px dot (CSS change in `.legend-point i`).
- The details summary for binned animals changes from `About these points` to `How to read the map`, matching the heatmap. Body:
  `Each square is about 39 km across (0.35°) and holds at least two GBIF records of this animal. It has too many records to draw one by one, so they are counted by area. Every square with records is filled with fine stipple, like the shading on an engraved map: the more records, the closer and brighter the marks. The grades are the top half, quarter, 10% and 3% of squares. Zoomed out they are taken from the whole range; zoomed in, from the squares in view, and more marks appear as the squares grow. Marks are spread evenly inside a square, so they show how busy the square is, not where in it the records were. Squares with no records stay empty. It follows where people look as well as where the animal lives, so treat it as a guide, not a population count.`
- No-records-in-view line (state below), a `<p class="note">` under the legend:
  `None of its squares are in view. Zoom out to find its range.`
- Load failure (state below): `Could not load its squares just now.`

tech-writer should check these against README.md once built.

## States

| State | What shows | Status |
|---|---|---|
| Loading (points not yet fetched) | No marks. The previous animal's stipple is cleared when a new animal is selected, not when the new data arrives. Legend shows without the ` · N squares` suffix, as today. | Final |
| Load failed | No marks. The legend line is replaced with the load-failure string. The Heatmap button still works if the range file loaded. Check what the current code does on a rejected `loadPoints`; if nothing handles it, this is new. | Final copy, open wiring |
| Very few squares (under 30 in total) | Every square gets at least one mark at every zoom (presence floor). Classes always from the whole range, never re-banded. | Final |
| View with no records (settled below 0.9, no squares in the visible view, not just the box) | No marks. The no-records line appears under the legend; it goes away on the next settle that has squares. Updated in place, not by re-rendering the whole plate, and not in a live region: panning would make a screen reader announce it repeatedly. | Final |
| Detail box over budget | Uniformly lighter stipple via `spacingScale`. No message. | Final |
| Moving (before settle) | The current layer stays put; the shader keeps adjusting mark counts with zoom. | Final |
| Permission-denied | Not applicable: no accounts, no location in this feature. | n/a |
| WebGL unavailable | Existing app behaviour, unchanged. | n/a |

This is data, not model output, so there is no model to be wrong. The uncertainty that matters is resolution (39 km squares) and observer bias; both are carried by the copy above, and the even spread inside a square avoids faking finer resolution.

## Accessibility (Final)

- Marks: core plus dark rim, at least 3:1 against the ground on white, snow, sand and dark forest, by the per-pixel simulation above. Legend swatches on `--bg` `#06070a`: the lowest ink `#ff5a36` is about 6.5:1.
- The stipple's own text (the no-records line, the load-failure line, the How to read the map body and the key's end labels) uses `--ink-2`, not `--ink-3`, which is about 3.2:1 on the plate. The shared token is unchanged.
- The load-failure line is a `role="status"` region, so it is announced. The no-records line sits in an `aria-live="off"` paragraph whose text is swapped in place, because the plate itself is an `aria-live="polite"` region and panning would otherwise announce it again and again.
- Density is not the only cue: ink also steps from orange to yellow by grade, as on the heatmap.
- Reduced motion: no crossfades. No autonomous animation is added.
- The Heatmap/Points toggle (`aria-pressed` buttons in the `Show the range as` group) is unchanged and keyboard operable. Switching is instant.
- The map stays a supplement. The text alternatives (Range facts, country and state lists, record count, the notes) are unchanged and still describe where the animal lives without the canvas.
- New legend glyphs and swatches are `aria-hidden`; their meaning is in the visible text next to them.

## Acceptance criteria

Placement and honesty (testable as pure functions; I suggest putting the seeding, R2 placement, class cutting, presence floor and budget maths in `src/stipple.ts` so test-writer can run them under `tsx`; the repo has no test runner yet):
- [ ] For a given `(row, col)`, candidate `i` always has the same lat/lng, across runs and across world and detail layers.
- [ ] The first N candidates of a square are identical to the first N of the same square at N+M (prefix property).
- [ ] For every binned animal in `public/data/points/`, every generated mark lies inside its square, inset 4%. Zero marks in squares without records.
- [ ] Seeds come from integer lattice indices, so a point at 12.34999 and 12.35001 in the same square give the same seed.
- [ ] Class breaks match `createCellDots` on the same input (whole-range grading).
- [ ] Re-banding happens only when the detail box holds at least 30 squares.
- [ ] A square with `n` squares (itself included) in its 5x5 neighbourhood has `floorLambda = min(1, 2 / n)`, so 1 when `n` is at most 2; all squares have 1 when the animal has under 30.
- [ ] Dither: for `lambda` under 1, the share of a run of squares that lights is within 0.03 of `lambda`, and no 5x5 block of it is off by more than 2.5 squares.
- [ ] Over the detail budget, `spacingScale` is set so the estimated total is at most 250,000, and class order is unchanged.

Rendering and behaviour (manual, on the largest, a middle-sized and the smallest binned animal):
- [ ] Mark size on screen is the same at altitude 2, 1, 0.3 and 0.18 (measure a mark in a screenshot at each).
- [ ] Zooming in from the globe to a state, marks are added, none move, none grow.
- [ ] Below 0.9, after the camera stops, grading re-cuts to the view within about 160 ms plus build time, with a 200 ms crossfade and no flash of empty globe.
- [ ] With reduced motion on, the swap is instant.
- [ ] Panning back to a spot gives the same marks in the same places.
- [ ] Marks remain distinguishable over Sahara, Greenland ice and dark forest.
- [ ] The globe limb does not read darker than the centre for an evenly recorded range.
- [ ] Changing `devicePixelRatio` (browser zoom, or the slow-frame downgrade) keeps mark size in CSS px and tone unchanged.
- [ ] Frame rate while orbiting the largest animal at altitude 2 is no worse than the current `createCellDots`. `[gap: baseline frame rate not yet measured]`
- [ ] Non-binned animals in Points look and behave exactly as before.

Copy and accessibility (a11y-auditor):
- [ ] All strings above appear exactly, with no em dashes.
- [ ] The legend key and glyph are `aria-hidden`; the text beside them carries the meaning.
- [ ] Toggle works by keyboard and reports `aria-pressed` correctly in both modes.
- [ ] The no-records line appears and clears correctly and is not announced on every pan.
- [ ] Marks and swatches meet 3:1 non-text contrast as specified.

## Open questions

1. Is the globe-level view right now? After the revision the lowest grade covers about 15% of the ground at every zoom and the neighbourhood floor keeps thin patches visible, but on a small screen at altitude 2 the lowest three grades merge. Decide by eye on three animals.
2. The spacing and mark size values are Tune. Review on a real screen before shipping, ideally at dpr 1 and 2.
3. Largest square count per animal, and whether the detail build fits in 50 ms or needs a worker.
4. Should the non-binned Points mark adopt the stipple mark (size, rim) so both kinds of animal share one visual language? Separate decision, after this ships.
5. The comprehension test under "User" has not been run.
6. Whether `createCellDots` is deleted or kept as a fallback. I would delete it: two ways of drawing the same data is maintenance without a user benefit.
