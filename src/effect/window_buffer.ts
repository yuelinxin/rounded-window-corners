/** @file Capture window surfaces on their native pixel grid. */

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Graphene from 'gi://Graphene';

import {
    getFramebufferMapping,
    updateTextureFilters,
} from './texture_filters.js';

const PIXEL_EPSILON = 1 / 256;

/**
 * Clutter.OffscreenEffect rounds resource scales up to integers. Rendering a
 * 150% Wayland surface tree at 200% filters transparent holes in the parent
 * independently of the subsurfaces filling them, leaving seams. Keep the
 * fractional source scale and pixel phase when capturing the whole tree.
 */
export class WindowBuffer {
    #framebuffer: Cogl.Offscreen | null = null;
    #texture: Cogl.Texture | null = null;
    #key = '';

    clear() {
        this.#framebuffer = null;
        this.#texture = null;
        this.#key = '';
    }

    paint(
        actor: Clutter.Actor,
        pipeline: Cogl.Pipeline,
        node: Clutter.PaintNode,
        ctx: Clutter.PaintContext,
        flags: Clutter.EffectPaintFlags,
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

        const volume = actor.get_paint_volume();
        const origin = volume?.get_origin();
        // Leave one logical pixel of transparent padding for edge filtering.
        const x1 = Math.floor(((origin?.x ?? 0) - 1) * scale + phaseX);
        const y1 = Math.floor(((origin?.y ?? 0) - 1) * scale + phaseY);
        const x2 = Math.ceil(
            ((origin?.x ?? 0) + (volume?.get_width() ?? actor.width) + 1) *
                scale +
                phaseX,
        );
        const y2 = Math.ceil(
            ((origin?.y ?? 0) + (volume?.get_height() ?? actor.height) + 1) *
                scale +
                phaseY,
        );
        const width = x2 - x1;
        const height = y2 - y1;
        const box = new Clutter.ActorBox({
            x1: (x1 - phaseX) / scale,
            y1: (y1 - phaseY) / scale,
            x2: (x2 - phaseX) / scale,
            y2: (y2 - phaseY) / scale,
        });
        const key = [scale, x1, y1, x2, y2, phaseX, phaseY].join(',');
        const dirty =
            key !== this.#key ||
            // biome-ignore lint/suspicious/noBitwiseOperators: Clutter passes bit flags.
            Boolean(flags & Clutter.EffectPaintFlags.ACTOR_DIRTY);

        const framebuffer = this.#ensureFramebuffer(ctx, width, height);
        const texture = this.#texture;
        if (!(framebuffer && texture)) {
            pipeline.set_layer_null_texture(0);
            node.add_child(Clutter.ActorNode.new(actor, -1));
            return;
        }
        pipeline.set_layer_texture(0, texture);
        updateTextureFilters(pipeline, ctx, scale);
        const opacity = actor.get_paint_opacity() / 255;
        const color = new Cogl.Color();
        color.init_from_4f(opacity, opacity, opacity, opacity);
        pipeline.set_color(color);

        if (dirty) {
            framebuffer.set_modelview_matrix(
                new Graphene.Matrix().init_identity(),
            );
            framebuffer.orthographic(box.x1, box.y1, box.x2, box.y2, -1, 1);
            const layer = Clutter.LayerNode.new_to_framebuffer(
                framebuffer,
                pipeline,
            );
            layer.add_child(Clutter.ActorNode.new(actor, 255));
            node.add_child(layer);
            this.#key = key;
        }

        const target = Clutter.PipelineNode.new(pipeline);
        target.add_rectangle(box);
        node.add_child(target);
    }

    #ensureFramebuffer(
        ctx: Clutter.PaintContext,
        width: number,
        height: number,
    ) {
        if (
            this.#texture?.get_width() === width &&
            this.#texture.get_height() === height
        )
            return this.#framebuffer;

        try {
            const context = ctx.get_framebuffer().get_context();
            const texture = Cogl.Texture2D.new_with_size(
                context,
                width,
                height,
            );
            const framebuffer = Cogl.Offscreen.new_with_texture(texture);
            framebuffer.allocate();
            this.#texture = texture;
            this.#framebuffer = framebuffer;
            return framebuffer;
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

/** Ignore matrix noise while preserving subpixel placement to 1/256 pixel. */
function pixelPhase(value: number) {
    const fraction = value - Math.floor(value);
    return (Math.round(fraction / PIXEL_EPSILON) * PIXEL_EPSILON) % 1;
}
