// biome-ignore-all lint/performance/noAwaitInLoops: Each capture must finish before changing the scene.
/** Integration fixture loaded only by tests/rendering.py's isolated Shell. */
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import {RoundedCornersEffect} from './effect/rounded_corners_effect.js';
import {initPrefs, setPref} from './utils/settings.js';

const context = global.stage.get_context().get_backend().get_cogl_context();
const output = GLib.getenv('RWC_TEST_OUTPUT');
const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
    `${output}/data/gnome-shell/extensions/rwc-test@local/schemas`,
    Gio.SettingsSchemaSource.get_default(),
    false,
);
initPrefs(
    new Gio.Settings({
        settingsSchema: schemaSource.lookup(
            'org.gnome.shell.extensions.rounded-window-corners-reborn',
            false,
        ),
    }),
);
setPref('border-width', 1);

const OldEffect = GObject.registerClass(
    class RwcRegressionOldEffect extends Shell.GLSLEffect {
        vfunc_paint_target(node, ctx) {
            const pipeline = this.get_pipeline();
            pipeline.set_blend(
                'RGBA = ADD (SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))',
            );
            pipeline.set_layer_filters(
                0,
                Cogl.PipelineFilter.LINEAR,
                Cogl.PipelineFilter.LINEAR,
            );
            super.vfunc_paint_target(node, ctx);
        }
    },
);

function delay() {
    return new Promise(resolve =>
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }),
    );
}

function capture(name) {
    return new Promise((resolve, reject) => {
        const stream = Gio.File.new_for_path(`${output}/${name}.png`).replace(
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null,
        );
        const shot = new Shell.Screenshot();
        shot.screenshot(false, stream, (_source, result) => {
            try {
                shot.screenshot_finish(result);
                stream.close(null);
                resolve();
            } catch (error) {
                reject(error);
            }
        });
    });
}

function fixture(parent, scale, position, transparentLine = false) {
    const root = new Clutter.Actor({
        x: position,
        y: position,
        width: 320,
        height: 240,
    });
    // Mimic Mutter's surface-container snapping on odd logical positions.
    const offset = Math.round(position * scale) / scale - position;
    const surface = new Clutter.Actor({
        x: offset,
        y: offset,
        width: 320,
        height: 240,
    });
    const width = 320 * scale;
    const height = 240 * scale;
    const bytes = new Uint8Array(width * height * 4);
    for (let y = 0; y < 64 * scale; y++) {
        for (let x = 0; x < width; x++) {
            const translucent =
                x >= 40 * scale &&
                x < 60 * scale &&
                y >= 20 * scale &&
                y < 40 * scale;
            const line = transparentLine && y === Math.floor(50 * scale);
            bytes.set(
                line ? [0, 0, 0, 0] : [60, 60, 60, translucent ? 128 : 255],
                (y * width + x) * 4,
            );
        }
    }
    const texture = Cogl.Texture2D.new_from_data(
        context,
        width,
        height,
        Cogl.PixelFormat.RGBA_8888,
        width * 4,
        bytes,
    );
    surface.content = Clutter.TextureContent.new_from_texture(texture, null);
    surface.add_child(
        new Clutter.Actor({
            x: 0,
            y: 64,
            width: 320,
            height: 176,
            backgroundColor: new Cogl.Color({
                red: 220,
                green: 220,
                blue: 220,
                alpha: 255,
            }),
        }),
    );
    root.add_child(surface);
    parent.add_child(root);
    return root;
}

function apply(root, opaque = false) {
    const effect = new RoundedCornersEffect();
    root.add_effect_with_name('rounded', effect);
    effect.updateUniforms(
        {
            borderRadius: 12,
            smoothing: 0,
            padding: {left: 0, top: 0, right: 0, bottom: 0},
            borderColor: [0.5, 0.5, 0.5, 1],
        },
        {x1: 0, y1: 0, x2: 320, y2: 240},
        opaque,
    );
    return effect;
}

export async function run(scale) {
    const background = new Clutter.Actor({
        width: global.stage.width,
        height: global.stage.height,
        backgroundColor: new Cogl.Color({
            red: 200,
            green: 0,
            blue: 200,
            alpha: 255,
        }),
    });
    global.stage.add_child(background);
    try {
        for (const position of [40, 41]) {
            const prefix = `${scale}-${position}`;
            const root = fixture(background, scale, position);
            await delay();
            await capture(`${prefix}-native`);
            root.add_effect_with_name('old', new OldEffect());
            await delay();
            await capture(`${prefix}-old`);
            root.clear_effects();
            const effect = apply(root);
            await delay();
            await capture(`${prefix}-fixed`);
            root.queue_redraw();
            await delay();
            await capture(`${prefix}-redrawn`);
            root.opacity = 128;
            await delay();
            await capture(`${prefix}-faded`);
            root.opacity = 255;
            await delay();
            await capture(`${prefix}-restored`);

            // Exercise both the native interior and captured edge strips with
            // new content, not just a redraw of an unchanged texture.
            const child = root.get_first_child().get_first_child();
            child.backgroundColor = new Cogl.Color({
                red: 170,
                green: 200,
                blue: 100,
                alpha: 255,
            });
            await delay();
            await capture(`${prefix}-updated`);
            child.backgroundColor = new Cogl.Color({
                red: 220,
                green: 220,
                blue: 220,
                alpha: 255,
            });
            effect.enabled = false;
            await delay();
            effect.enabled = true;
            await delay();
            await capture(`${prefix}-reenabled`);
            const clone = new Clutter.Clone({
                source: root,
                x: 380,
                y: 50,
                scaleX: 0.4,
                scaleY: 0.4,
            });
            background.add_child(clone);
            await delay();
            await capture(`${prefix}-clone`);
            root.queue_redraw();
            await delay();
            await capture(`${prefix}-clone-redrawn`);
            clone.destroy();
            root.set_position(position + 1, position + 1);
            await delay();
            await capture(`${prefix}-moved`);
            effect.enabled = false;
            await delay();
            await capture(`${prefix}-moved-native`);
            root.destroy();
        }
        const root = fixture(background, scale, 40, true);
        apply(root, true);
        await delay();
        await capture(`${scale}-opaque`);
        root.destroy();
    } finally {
        background.destroy();
    }
}
