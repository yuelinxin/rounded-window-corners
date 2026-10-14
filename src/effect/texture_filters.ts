/** @file Select filters for rounded window textures at their actual paint scale. */

import type Clutter from 'gi://Clutter';

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
        (0.5 - projected.get_y() / w / 2) * viewport[3] + viewport[1],
    ];
}

/** Project the actor origin and unit axes into destination pixels. */
export function getFramebufferMapping(paintContext: Clutter.PaintContext) {
    const framebuffer = paintContext.get_framebuffer();
    const transform = framebuffer
        .get_modelview_matrix()
        .multiply(framebuffer.get_projection_matrix());
    const viewport = framebuffer.get_viewport4fv();

    const [originX, originY] = project(ORIGIN, transform, viewport);
    const [rightX, rightY] = project(UNIT_RIGHT, transform, viewport);
    const [downX, downY] = project(UNIT_DOWN, transform, viewport);

    return {
        originX,
        originY,
        rightX: rightX - originX,
        rightY: rightY - originY,
        downX: downX - originX,
        downY: downY - originY,
    };
}

/** Select filters using the actual number of source texels per logical unit. */
export function updateTextureFilters(
    pipeline: Cogl.Pipeline,
    paintContext: Clutter.PaintContext,
    sourceScale: number,
) {
    const {rightX, rightY, downX, downY} = getFramebufferMapping(paintContext);
    const scale =
        Math.max(Math.hypot(rightX, rightY), Math.hypot(downX, downY)) /
        sourceScale;

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
