/** @file Binds the actual corner rounding shader to the windows. */

import type {Bounds, RoundedCornerSettings} from '../utils/types.js';

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

import {readShader} from '../utils/file.js';
import {getPref} from '../utils/settings.js';
import {WindowBuffer} from './window_buffer.js';

const [declarations, code] = await readShader(
    import.meta.url,
    'shader/rounded_corners.frag',
);

class Uniforms {
    bounds = 0;
    clipRadius = 0;
    borderWidth = 0;
    borderColor = 0;
    borderedAreaBounds = 0;
    borderedAreaClipRadius = 0;
    exponent = 0;
    inverseModelview = 0;
    opaqueContents = 0;
}

export const RoundedCornersEffect = GObject.registerClass(
    {},
    class Effect extends Clutter.Effect {
        readonly #buffer = new WindowBuffer();
        readonly #pipeline: Cogl.Pipeline;
        #purgeId = 0;

        /**
         * To store a uniform value, we need to know its location in the shader,
         * which is done by calling `pipeline.get_uniform_location()`. This is
         * expensive, so we cache the location of uniforms when the shader is
         * created.
         */
        readonly #uniforms = new Uniforms();

        constructor() {
            super();

            const context = global.stage
                .get_context()
                .get_backend()
                .get_cogl_context();
            this.#pipeline = Cogl.Pipeline.new(context);
            this.#pipeline.set_layer_null_texture(0);
            this.#pipeline.set_blend(
                'RGBA = ADD (SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))',
            );
            this.#pipeline.add_snippet(
                Cogl.Snippet.new(
                    Cogl.SnippetHook.VERTEX,
                    'uniform mat4 inverseModelview; varying vec2 rwcActorPosition;',
                    `vec4 actorPoint = inverseModelview * cogl_modelview_matrix * cogl_position_in;
                     rwcActorPosition = actorPoint.xy / actorPoint.w;`,
                ),
            );
            this.#pipeline.add_snippet(
                Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, code),
            );
            for (const k in this.#uniforms) {
                this.#uniforms[k as keyof Uniforms] =
                    this.#pipeline.get_uniform_location(k);
            }
        }

        vfunc_paint(
            node: Clutter.PaintNode,
            ctx: Clutter.PaintContext,
            flags: Clutter.EffectPaintFlags,
        ) {
            const actor = this.actor;
            if (!actor) return;
            // Cogl may batch rectangles using unit vertices plus a modelview
            // transform. Recover actor coordinates from that final transform.
            const [invertible, inverse] = ctx
                .get_framebuffer()
                .get_modelview_matrix()
                .inverse();
            if (!invertible) return;
            this.#pipeline.set_uniform_matrix(
                this.#uniforms.inverseModelview,
                4,
                1,
                false,
                inverse.to_float(),
            );
            this.#buffer.paint(actor, this.#pipeline, node, ctx, flags);
        }

        vfunc_set_actor(actor: Clutter.Actor | null) {
            // set_actor can run during construction, before private fields exist.
            if (#buffer in this) {
                this.#buffer.clear();
                this.#pipeline.set_layer_null_texture(0);
                if (this.#purgeId) global.stage.disconnect(this.#purgeId);
                this.#purgeId = actor
                    ? global.stage.connect('gl-video-memory-purged', () => {
                          this.#buffer.clear();
                          this.queue_repaint();
                      })
                    : 0;
            }
            super.vfunc_set_actor(actor);
        }

        vfunc_set_enabled(enabled: boolean) {
            if (#buffer in this) {
                this.#buffer.clear();
                this.#pipeline.set_layer_null_texture(0);
            }
            super.vfunc_set_enabled(enabled);
        }

        /**
         * Update uniforms of the shader.
         * For more information, see the comments in the shader file.
         *
         * @param config - Rounded corners configuration
         * @param windowBounds - Bounds of the window without padding
         * @param opaqueContents - Restore the browser client's opaque contents
         */
        updateUniforms(
            config: RoundedCornerSettings,
            windowBounds: Bounds,
            opaqueContents = false,
        ) {
            this.#pipeline.set_uniform_float(
                this.#uniforms.opaqueContents,
                1,
                1,
                [Number(opaqueContents)],
            );
            const borderWidth = getPref('border-width');
            const borderColor = config.borderColor;

            const outerRadius = config.borderRadius;
            const {padding, smoothing} = config;

            const bounds = [
                windowBounds.x1 + padding.left,
                windowBounds.y1 + padding.top,
                windowBounds.x2 - padding.right,
                windowBounds.y2 - padding.bottom,
            ];

            const borderedAreaBounds = [
                bounds[0] + borderWidth,
                bounds[1] + borderWidth,
                bounds[2] - borderWidth,
                bounds[3] - borderWidth,
            ];

            // This is needed for squircle corners
            const exponent = smoothing * 10 + 2;
            const radius = Math.max(
                0,
                Math.min(
                    outerRadius * 0.5 * exponent,
                    (bounds[2] - bounds[0]) / 2,
                    (bounds[3] - bounds[1]) / 2,
                ),
            );
            const borderedAreaRadius = Math.max(0, radius - borderWidth);

            this.#setUniforms(
                bounds,
                radius,
                borderWidth,
                borderColor,
                borderedAreaBounds,
                borderedAreaRadius,
                exponent,
            );
        }

        #setUniforms(
            bounds: number[],
            radius: number,
            borderWidth: number,
            borderColor: [number, number, number, number],
            borderedAreaBounds: number[],
            borderedAreaRadius: number,
            exponent: number,
        ) {
            const uniforms = this.#uniforms;
            this.#pipeline.set_uniform_float(uniforms.bounds, 4, 1, bounds);
            this.#pipeline.set_uniform_float(uniforms.clipRadius, 1, 1, [
                radius,
            ]);
            this.#pipeline.set_uniform_float(uniforms.borderWidth, 1, 1, [
                borderWidth,
            ]);
            this.#pipeline.set_uniform_float(
                uniforms.borderColor,
                4,
                1,
                borderColor,
            );
            this.#pipeline.set_uniform_float(
                uniforms.borderedAreaBounds,
                4,
                1,
                borderedAreaBounds,
            );
            this.#pipeline.set_uniform_float(
                uniforms.borderedAreaClipRadius,
                1,
                1,
                [borderedAreaRadius],
            );
            this.#pipeline.set_uniform_float(uniforms.exponent, 1, 1, [
                exponent,
            ]);
            this.queue_repaint();
        }
    },
);
