/** @file Select filters for rounded window textures at their actual paint scale. */

import type Clutter from 'gi://Clutter';
import type Shell from 'gi://Shell';

import Cogl from 'gi://Cogl';
import Graphene from 'gi://Graphene';

// Match MetaShapedTexture: use mipmaps below half size in both dimensions.
// Above that, linear filtering preserves detail without aliasing.
const MIPMAP_SCALE_THRESHOLD = 0.5;

const ORIGIN = Graphene.Vec4.alloc().init(0, 0, 0, 1);
const UNIT_RIGHT = Graphene.Vec4.alloc().init(1, 0, 0, 1);
const UNIT_DOWN = Graphene.Vec4.alloc().init(0, 1, 0, 1);

/** Project a point in actor coordinates onto the destination framebuffer. */
function project(
    point: Graphene.Vec4,
    transform: Graphene.Matrix,
    viewport: number[],
) {
    const projected = transform.transform_vec4(point);
    const w = projected.get_w();

    return [
        (projected.get_x() / w / 2 + 0.5) * viewport[2] + viewport[0],
        (projected.get_y() / w / 2 + 0.5) * viewport[3] + viewport[1],
    ];
}

/**
 * Choose filters on every paint, including paints reusing cached contents.
 * Clutter can reset the filters after the window's contents are redrawn.
 *
 * Adapted from https://github.com/flexagoon/rounded-window-corners/pull/170.
 * Include the offscreen resource scale so mixed-scale monitors are handled
 * along with overview clones.
 */
export function updateTextureFilters(
    effect: Shell.GLSLEffect,
    paintContext: Clutter.PaintContext,
) {
    const pipeline = effect.get_pipeline();
    const actor = effect.actor;
    if (!(pipeline && actor)) return;

    const framebuffer = paintContext.get_framebuffer();
    const transform = framebuffer
        .get_modelview_matrix()
        .multiply(framebuffer.get_projection_matrix());
    const viewport = framebuffer.get_viewport4fv();

    const [originX, originY] = project(ORIGIN, transform, viewport);
    const [rightX, rightY] = project(UNIT_RIGHT, transform, viewport);
    const [downX, downY] = project(UNIT_DOWN, transform, viewport);

    // paint_target builds nodes before Clutter applies the transform that
    // divides texture coordinates by the actor's integer resource scale.
    // The matrix above therefore measures a logical unit, not one texel.
    // A 2x texture on a 1.5x monitor is scaled down to 0.75, not up to 1.5.
    const scale =
        Math.max(
            Math.hypot(rightX - originX, rightY - originY),
            Math.hypot(downX - originX, downY - originY),
        ) / actor.get_resource_scale();

    // Linear filtering also handles fractional placement and magnification.
    // At aligned 1:1 positions it preserves the original texels exactly.
    pipeline.set_layer_filters(
        0,
        scale < MIPMAP_SCALE_THRESHOLD
            ? Cogl.PipelineFilter.LINEAR_MIPMAP_NEAREST
            : Cogl.PipelineFilter.LINEAR,
        Cogl.PipelineFilter.LINEAR,
    );
}
