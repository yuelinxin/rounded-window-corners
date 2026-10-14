# `effect`

This directory contains the code for applying GLSL effects to windows.

## `clip_shadow_effect.ts`

Due to a bug in GNOME, window shadows are drawn behind window contents. This
effect loads a simple Fragment shader that clips the shadow behind the window.
The CSS actor contains a white fill over a black shadow. Subtracting the fill's
premultiplied RGB from alpha removes the fill even at partially sampled edges;
a brightness threshold leaves light fringes at fractional scales. The remaining
alpha keeps the previous shadow strength outside the fill.

## `rounded_corners_effect.ts`

This effect loads the actual Fragment shader that rounds the corners and draws
custom borders for the window. The class applies the effect and provides a
function to change uniforms passed to the effect.

Window bounds and padding are expressed in actor coordinates. The vertex shader
maps Cogl's actual vertex modelview transform back through the inverse actor
modelview, since Cogl can batch rectangles using unit vertices. This also works
for overview clones and screenshot framebuffers.

`window_buffer.ts` captures the window at the highest **fractional** scale of its
stage views. Clutter's default offscreen effect rounds 150% up to 200%, then
scales back down. This filters transparent holes in a parent surface separately
from the subsurfaces filling them, creating a desktop-colored seam. The custom
buffer preserves the destination pixel phase as well as the scale, and
invalidates cached contents when either changes. Source contents are captured
at full opacity; the final composite applies window/animation opacity once.
Disabling, detaching, or purging video memory discards the capture. Allocation
failure falls back to painting the original window.

At the normal, fully opaque, untransformed desktop size, only the four edge
strips are captured and run through the mask shader. The interior is inset
beyond both rounded contours and the border's antialiasing region, and paints
directly through Mutter. The split is snapped inward to the same physical pixel
grid as the capture. This avoids copying and shading every pixel in a large
window on every scroll frame. Each strip uses a small buffer with a guard texel for
filtering, avoiding a full-window texture allocation and reducing the region
cleared on each scroll frame. Clones, fading, other enabled effects, and transforms
use the full capture; switching paths invalidates its cached contents.

Effect instances copy one shared shader pipeline, as `Shell.GLSLEffect` does.
The inverse modelview uniform changes only when the transform changes, and
texture filtering reuses the pixel mapping already computed for capture.

Normal Wayland Chrome/Chromium browser windows also need their opaque contents
preserved: their toolbar separator can contain unused transparent texels inside
an opaque region. Mutter paints that region without blending, but an RGBA
capture retains those alpha values. For the explicit browser WM classes in
`hasOpaqueBrowserContents`, the shader restores opaque alpha before applying
our window mask and animation opacity. Electron apps and other applications
retain their original alpha; Chromium process detection is deliberately not
used for this decision.

The fragment shader measures edge coverage using destination-pixel derivatives,
including straight edges. A one-logical-pixel border therefore covers 1.5 pixels
at 150% scale instead of alternating between one and two solid pixels. Window
and border coverage are combined as premultiplied colors, with matching blend
state, so antialiasing and animation opacity are applied only once. Padding is
symmetric on all four sides, and corner radii are limited by the actual bounds.

To check borders, use a window with light contents on a dark background at
100%, 125%, 150%, and 200%. Move it one logical pixel at a time and test odd and
even window sizes. Check both inner and outer borders, zero corner radius,
overview previews, and minimize/restore animations. Hiding just the shadow in
an isolated test session should not change the border's coverage; showing just
the shadow should never make any background pixel brighter.

## `texture_filters.ts`

The effect selects texture filters on every paint, including cached paints,
using the actual source buffer scale. A 2x source painted on a 1.5x monitor is
scaled to 0.75, not 1.5. Linear filtering preserves detail above half size;
below half size in both dimensions, `LINEAR_MIPMAP_NEAREST` matches Mutter's
native window texture rendering. Overview previews need no second effect.

The source window's mipmaps are disabled while the effect is attached, following
[PR #170](https://github.com/flexagoon/rounded-window-corners/pull/170), and
restored when it is removed.

## Rendering regression tests

Run `/usr/bin/python3 tests/rendering.py` from the repository root after
installing the development dependencies. This requires GNOME Shell 50,
`dbus-run-session`, `gsettings`, Python GI, and Pillow. It compiles into a
fresh temporary directory and runs a software-rendered headless compositor
with an isolated D-Bus session, settings, and extension directory. The normal
desktop is not modified. The compositor is stopped after the tests; screenshots
and logs remain in the printed temporary directory.

The fixture contains a parent texture with a transparent hole, a child filling
that hole, and an intentionally translucent patch. It compares the new effect
against native rendering at 100%, 125%, 150%, and 200%, at odd and even positions.
The old offscreen path is a negative control that must reproduce the seam at
fractional scales. It also checks cached versus redrawn contents, disabling and
re-enabling, overview-sized clones, the opaque browser separator case, opacity
transitions, one-pixel moves, and content updates in both the interior and edges.

To measure real Chrome scrolling against a Git revision:

```sh
/usr/bin/python3 tests/rendering.py --scrolling --baseline 936b9d1
```

This uses the GPU, a 2880×1920 virtual display at 120 Hz, and an isolated Chrome
profile showing a local scrolling page at 200% and 150%. It alternates the
baseline and current build twice, with native rendering as a control, and
prints frame counts, frame intervals, and CPU paint times. The benchmark does
not change the current desktop or browser profile. Results depend on GPU load
and are diagnostic measurements, not a timing assertion in the pixel tests.

For a desktop check, use Chrome on a 150% monitor and a 200% monitor. Scroll a
page or PDF, resize and move the window by one logical pixel, move it across
the monitor boundary, and enter/leave the overview. Check translucent terminal
windows as well. Reference implementations:
[Clutter offscreen effects](https://github.com/GNOME/mutter/blob/50.5/clutter/clutter/clutter-offscreen-effect.c),
[Mutter surface alignment](https://github.com/GNOME/mutter/blob/50.5/src/compositor/meta-surface-actor-wayland.c),
and [Mutter opaque-region painting](https://github.com/GNOME/mutter/blob/50.5/src/compositor/meta-shaped-texture.c).

## `shader`

This is the directory where the Fragment shaders are stored.

If you're interested in implementation details of the shader, you can read the
`shader/rounded_corners.frag` file, which is well commented and explains how
it works in great detail.
