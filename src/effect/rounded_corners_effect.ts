/** @file Binds the actual corner rounding shader to the windows. */

import type Clutter from 'gi://Clutter';
import type {Bounds, RoundedCornerSettings} from '../utils/types.js';

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {readShader} from '../utils/file.js';
import {getPref} from '../utils/settings.js';
import {updateTextureFilters} from './texture_filters.js';

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
}

export const RoundedCornersEffect = GObject.registerClass(
    {},
    class Effect extends Shell.GLSLEffect {
        #blendConfigured = false;

        /**
         * To store a uniform value, we need to know its location in the shader,
         * which is done by calling `this.get_uniform_location()`. This is
         * expensive, so we cache the location of uniforms when the shader is
         * created.
         */
        static uniforms: Uniforms = new Uniforms();

        constructor() {
            super();

            for (const k in Effect.uniforms) {
                Effect.uniforms[k as keyof Uniforms] =
                    this.get_uniform_location(k);
            }
        }

        vfunc_build_pipeline() {
            this.add_glsl_snippet(
                Cogl.SnippetHook.VERTEX,
                'uniform mat4 inverseModelview; varying vec2 rwcActorPosition;',
                `vec4 actorPoint = inverseModelview * cogl_modelview_matrix * cogl_position_in;
                 rwcActorPosition = actorPoint.xy / actorPoint.w;`,
                false,
            );
            this.add_glsl_snippet(
                Cogl.SnippetHook.FRAGMENT,
                declarations,
                code,
                false,
            );
        }

        vfunc_paint_target(node: Clutter.PaintNode, ctx: Clutter.PaintContext) {
            const pipeline = this.get_pipeline();
            if (!pipeline) return;

            // The offscreen texture includes padding and can change size as a
            // window moves. Recover actor coordinates from the destination
            // vertex transform instead of treating that texture as the window
            // bounds. This also works for clones and offscreen screenshots,
            // without depending on the destination framebuffer's Y orientation.
            const framebuffer = ctx.get_framebuffer();
            const [invertible, inverse] = framebuffer
                .get_modelview_matrix()
                .inverse();
            if (!invertible) return;

            this.set_uniform_matrix(
                Effect.uniforms.inverseModelview,
                false,
                4,
                inverse.to_float(),
            );
            if (!this.#blendConfigured) {
                // The shader emits premultiplied colors, including edge coverage
                // and animation opacity. Shell.GLSLEffect defaults to straight
                // alpha blending, which would multiply that coverage twice.
                pipeline.set_blend(
                    'RGBA = ADD (SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))',
                );
                this.#blendConfigured = true;
            }
            updateTextureFilters(this, ctx);
            super.vfunc_paint_target(node, ctx);
        }

        /**
         * Update uniforms of the shader.
         * For more information, see the comments in the shader file.
         *
         * @param config - Rounded corners configuration
         * @param windowBounds - Bounds of the window without padding
         */
        updateUniforms(config: RoundedCornerSettings, windowBounds: Bounds) {
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
            const uniforms = Effect.uniforms;
            this.set_uniform_float(uniforms.bounds, 4, bounds);
            this.set_uniform_float(uniforms.clipRadius, 1, [radius]);
            this.set_uniform_float(uniforms.borderWidth, 1, [borderWidth]);
            this.set_uniform_float(uniforms.borderColor, 4, borderColor);
            this.set_uniform_float(
                uniforms.borderedAreaBounds,
                4,
                borderedAreaBounds,
            );
            this.set_uniform_float(uniforms.borderedAreaClipRadius, 1, [
                borderedAreaRadius,
            ]);
            this.set_uniform_float(uniforms.exponent, 1, [exponent]);
            this.queue_repaint();
        }
    },
);
