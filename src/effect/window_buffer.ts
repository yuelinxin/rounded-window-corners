/** @file Capture window surfaces on their native pixel grid. */

import type {Bounds} from '../utils/types.js';

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Graphene from 'gi://Graphene';

import {
    getFramebufferMapping,
    updateTextureFilters,
} from './texture_filters.js';

const PIXEL_EPSILON = 1 / 256;

type BufferSlot = {
    framebuffer: Cogl.Offscreen;
    texture: Cogl.Texture;
    width: number;
    height: number;
};

/**
 * Clutter.OffscreenEffect rounds resource scales up to integers. Rendering a
 * 150% Wayland surface tree at 200% filters transparent holes in the parent
 * independently of the subsurfaces filling them, leaving seams. Keep the
 * fractional source scale and pixel phase when capturing the whole tree.
 */
export class WindowBuffer {
    #buffers: BufferSlot[] = [];
    #key = '';

    clear() {
        this.#buffers = [];
        this.#key = '';
    }

    paint(
        actor: Clutter.Actor,
        pipeline: Cogl.Pipeline,
        node: Clutter.PaintNode,
        ctx: Clutter.PaintContext,
        flags: Clutter.EffectPaintFlags,
        nativeInterior: Bounds | null,
    ) {
        // biome-ignore lint/suspicious/noBitwiseOperators: Clutter passes bit flags.
        if (flags & Clutter.EffectPaintFlags.BYPASS_EFFECT) {
            this.clear();
            node.add_child(Clutter.ActorNode.new(actor, -1));
            return;
        }

        // Match Mutter's highest-scale monitor, including windows spanning
        // monitors. get_resource_scale() has already rounded this value up.
        const views = actor.peek_stage_views();
        const scale =
            views.length > 0
                ? Math.max(...views.map(view => view.get_scale()))
                : actor.get_resource_scale();
        const mapping = getFramebufferMapping(ctx);
        const aligned =
            Math.abs(mapping.rightX - scale) < PIXEL_EPSILON &&
            Math.abs(mapping.downY - scale) < PIXEL_EPSILON &&
            Math.abs(mapping.rightY) < PIXEL_EPSILON &&
            Math.abs(mapping.downX) < PIXEL_EPSILON;
        const phaseX = aligned ? pixelPhase(mapping.originX) : 0;
        const phaseY = aligned ? pixelPhase(mapping.originY) : 0;

        const box = getCaptureBounds(actor, scale, phaseX, phaseY);
        const opacity = actor.get_paint_opacity() / 255;
        const interior = getNativeInterior(
            actor,
            box,
            nativeInterior,
            scale,
            phaseX,
            phaseY,
            aligned,
        );
        const key = [
            scale,
            box.x1,
            box.y1,
            box.x2,
            box.y2,
            phaseX,
            phaseY,
            interior?.x1,
            interior?.y1,
            interior?.x2,
            interior?.y2,
        ].join(',');
        const dirty =
            key !== this.#key ||
            // biome-ignore lint/suspicious/noBitwiseOperators: Clutter passes bit flags.
            Boolean(flags & Clutter.EffectPaintFlags.ACTOR_DIRTY);

        const rectangles = getEdgeRectangles(box, interior);
        const captures: (BufferSlot & {
            rect: Clutter.ActorBox;
            captureBox: Clutter.ActorBox;
        })[] = [];
        for (const [index, rect] of rectangles.entries()) {
            // A guard texel retains filtering across each strip's inner edge.
            const padding = interior ? 1 / scale : 0;
            const captureBox = new Clutter.ActorBox({
                x1: rect.x1 - padding,
                y1: rect.y1 - padding,
                x2: rect.x2 + padding,
                y2: rect.y2 + padding,
            });
            const buffer = this.#ensureFramebuffer(
                ctx,
                index,
                Math.round((captureBox.x2 - captureBox.x1) * scale),
                Math.round((captureBox.y2 - captureBox.y1) * scale),
            );
            if (!buffer) {
                pipeline.set_layer_null_texture(0);
                node.add_child(Clutter.ActorNode.new(actor, -1));
                return;
            }
            captures.push({rect, captureBox, ...buffer});
        }
        this.#buffers.length = captures.length;
        updateTextureFilters(pipeline, mapping, scale);
        const color = new Cogl.Color();
        color.init_from_4f(opacity, opacity, opacity, opacity);
        pipeline.set_color(color);

        // Scroll the interior natively. Only the edge strips need an extra
        // capture and mask pass; they also use strip-sized GPU buffers.
        if (interior) addClippedActor(node, actor, interior, -1);
        for (const {rect, captureBox, texture, framebuffer} of captures) {
            pipeline.set_layer_texture(0, texture);
            if (dirty) {
                framebuffer.set_modelview_matrix(
                    new Graphene.Matrix().init_identity(),
                );
                framebuffer.orthographic(
                    captureBox.x1,
                    captureBox.y1,
                    captureBox.x2,
                    captureBox.y2,
                    -1,
                    1,
                );
                const layer = Clutter.LayerNode.new_to_framebuffer(
                    framebuffer,
                    pipeline,
                );
                layer.add_child(Clutter.ActorNode.new(actor, 255));
                node.add_child(layer);
            }
            const target = Clutter.PipelineNode.new(pipeline);
            target.add_texture_rectangle(
                rect,
                (rect.x1 - captureBox.x1) / (captureBox.x2 - captureBox.x1),
                (rect.y1 - captureBox.y1) / (captureBox.y2 - captureBox.y1),
                (rect.x2 - captureBox.x1) / (captureBox.x2 - captureBox.x1),
                (rect.y2 - captureBox.y1) / (captureBox.y2 - captureBox.y1),
            );
            node.add_child(target);
        }
        this.#key = key;
    }

    #ensureFramebuffer(
        ctx: Clutter.PaintContext,
        index: number,
        width: number,
        height: number,
    ) {
        const existing = this.#buffers[index];
        if (existing?.width === width && existing.height === height)
            return existing;

        try {
            const context = ctx.get_framebuffer().get_context();
            const texture = Cogl.Texture2D.new_with_size(
                context,
                width,
                height,
            );
            const framebuffer = Cogl.Offscreen.new_with_texture(texture);
            framebuffer.allocate();
            const buffer = {texture, framebuffer, width, height};
            this.#buffers[index] = buffer;
            return buffer;
        } catch (error) {
            this.clear();
            logError(
                error instanceof Error ? error : new Error(String(error)),
                'Failed to allocate rounded window buffer',
            );
            return null;
        }
    }
}

function addClippedActor(
    node: Clutter.PaintNode,
    actor: Clutter.Actor,
    box: Clutter.ActorBox,
    opacity: number,
) {
    const clip = Clutter.ClipNode.new();
    clip.add_rectangle(box);
    clip.add_child(Clutter.ActorNode.new(actor, opacity));
    node.add_child(clip);
}

/** Ignore matrix noise while preserving subpixel placement to 1/256 pixel. */
function pixelPhase(value: number) {
    const fraction = value - Math.floor(value);
    return (Math.round(fraction / PIXEL_EPSILON) * PIXEL_EPSILON) % 1;
}

/** Snap the native interior inward to whole destination pixels. */
function getNativeInterior(
    actor: Clutter.Actor,
    box: Clutter.ActorBox,
    bounds: Bounds | null,
    scale: number,
    phaseX: number,
    phaseY: number,
    aligned: boolean,
) {
    if (
        !(bounds && aligned) ||
        actor.get_paint_opacity() !== 255 ||
        actor.is_in_clone_paint() ||
        // Keep source and preview on the same buffer layout during overview
        // transitions, instead of reallocating strips/full buffers every paint.
        actor.has_mapped_clones() ||
        actor.get_effects().filter(effect => effect.enabled).length !== 1
    )
        return null;
    const x1 = Math.max(
        box.x1,
        (Math.ceil(bounds.x1 * scale + phaseX) - phaseX) / scale,
    );
    const y1 = Math.max(
        box.y1,
        (Math.ceil(bounds.y1 * scale + phaseY) - phaseY) / scale,
    );
    const x2 = Math.min(
        box.x2,
        (Math.floor(bounds.x2 * scale + phaseX) - phaseX) / scale,
    );
    const y2 = Math.min(
        box.y2,
        (Math.floor(bounds.y2 * scale + phaseY) - phaseY) / scale,
    );
    return x2 > x1 && y2 > y1 ? new Clutter.ActorBox({x1, y1, x2, y2}) : null;
}

function getEdgeRectangles(
    box: Clutter.ActorBox,
    interior: Clutter.ActorBox | null,
) {
    return interior
        ? [
              new Clutter.ActorBox({
                  x1: box.x1,
                  y1: box.y1,
                  x2: box.x2,
                  y2: interior.y1,
              }),
              new Clutter.ActorBox({
                  x1: box.x1,
                  y1: interior.y2,
                  x2: box.x2,
                  y2: box.y2,
              }),
              new Clutter.ActorBox({
                  x1: box.x1,
                  y1: interior.y1,
                  x2: interior.x1,
                  y2: interior.y2,
              }),
              new Clutter.ActorBox({
                  x1: interior.x2,
                  y1: interior.y1,
                  x2: box.x2,
                  y2: interior.y2,
              }),
          ]
        : [box];
}

function getCaptureBounds(
    actor: Clutter.Actor,
    scale: number,
    phaseX: number,
    phaseY: number,
) {
    const volume = actor.get_paint_volume();
    const origin = volume?.get_origin();
    // Leave one logical pixel of transparent padding for edge filtering.
    const x1 = Math.floor(((origin?.x ?? 0) - 1) * scale + phaseX);
    const y1 = Math.floor(((origin?.y ?? 0) - 1) * scale + phaseY);
    const x2 = Math.ceil(
        ((origin?.x ?? 0) + (volume?.get_width() ?? actor.width) + 1) * scale +
            phaseX,
    );
    const y2 = Math.ceil(
        ((origin?.y ?? 0) + (volume?.get_height() ?? actor.height) + 1) *
            scale +
            phaseY,
    );
    return new Clutter.ActorBox({
        x1: (x1 - phaseX) / scale,
        y1: (y1 - phaseY) / scale,
        x2: (x2 - phaseX) / scale,
        y2: (y2 - phaseY) / scale,
    });
}
