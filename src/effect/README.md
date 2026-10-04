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

Window bounds and padding are expressed in actor coordinates. Clutter adds
padding to the offscreen texture and may change its extent as a window moves,
so multiplying normalized texture coordinates by the actor size is incorrect.
The vertex shader instead maps the actual vertex modelview transform back
through the inverse actor modelview. This includes Clutter's texture offset and
unscale transform without relying on its private buffer-allocation rules, and
also handles overview clones and screenshot framebuffers.

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

The effect selects texture filters on every paint, including cached paints.
Clutter can otherwise reset them to nearest-neighbor filtering when an actor's
highest monitor scale is an integer. A window spanning 200% and 150% monitors
can then have jagged text on the 150% monitor, including when only its
client-side shadow crosses the edge.

Following [PR #170](https://github.com/flexagoon/rounded-window-corners/pull/170),
the source window's mipmaps are disabled while the effect is attached. This
prevents a low-resolution window copy being enlarged into the full-resolution
effect buffer in the overview. Removing the effect restores source mipmaps.
The result uses linear filtering. Below 50% scale in both dimensions it uses
`LINEAR_MIPMAP_NEAREST`, matching Mutter's native window texture rendering:
choose the nearest mipmap level and interpolate linearly within that level.
This avoids both undersampling small text and blurring it by blending mipmap
levels. Overview previews no longer need a second offscreen effect.

The projected size of a logical unit must be divided by the actor's integer
resource scale to measure the size of an offscreen texel. Clutter applies that
division in a paint node after `paint_target` builds the nodes. For example,
a 2x texture painted on a 1.5x monitor is scaled to 0.75, not 1.5. The framebuffer
transform also accounts for overview clones and animations.

This fixes the mixed-scale sampling artifacts, but does not remove Clutter's
intermediate buffer. That buffer uses a rounded-up integer resource scale, so
native fractional-scale clients can still undergo an extra resampling pass.
See [Clutter's offscreen rendering implementation](https://github.com/GNOME/mutter/blob/50.5/clutter/clutter/clutter-offscreen-effect.c).
[Mutter !5179](https://gitlab.gnome.org/GNOME/mutter/-/merge_requests/5179)
proposes a separate fix for buffer sizing and pixel alignment.

To check this, place a window across a 150%/200% monitor boundary, redraw its
contents (for example, type into a text field), and compare text with the
extension disabled. Also move it fully onto each monitor and check overview
previews and minimize/restore animations.

## `shader`

This is the directory where the Fragment shaders are stored.

If you're interested in implementation details of the shader, you can read the
`shader/rounded_corners.frag` file, which is well commented and explains how
it works in great detail.
