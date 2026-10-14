// biome-ignore-all lint/performance/noAwaitInLoops: Benchmark variants must run separately.
/** Real Wayland Chrome workload, loaded only in the isolated test Shell. */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// biome-ignore lint/correctness/noUndeclaredDependencies: Built into GJS.
import System from 'system';
import {RoundedCornersEffect} from './effect/rounded_corners_effect.js';
import {initPrefs, setPref} from './utils/settings.js';

const output = GLib.getenv('RWC_TEST_OUTPUT');
const schema = Gio.SettingsSchemaSource.new_from_directory(
    `${output}/data/gnome-shell/extensions/rwc-test@local/schemas`,
    Gio.SettingsSchemaSource.get_default(),
    false,
);
const prefs = new Gio.Settings({
    settingsSchema: schema.lookup(
        'org.gnome.shell.extensions.rounded-window-corners-reborn',
        false,
    ),
});
initPrefs(prefs);
setPref('border-width', 1);
const baselineUri = Gio.File.new_for_path(
    `${output}/data/gnome-shell/extensions/rwc-test@local/baseline/effect/rounded_corners_effect.js`,
).get_uri();
let BaselineEffect = null;
if (Gio.File.new_for_uri(baselineUri).query_exists(null)) {
    BaselineEffect = (await import(baselineUri)).RoundedCornersEffect;
    const settings = await import('./baseline/utils/settings.js');
    settings.initPrefs(prefs);
}
const config = {
    borderRadius: 12,
    smoothing: 0,
    padding: {left: 0, top: 0, right: 0, bottom: 0},
    borderColor: [0.5, 0.5, 0.5, 1],
};
function delay(ms) {
    return new Promise(resolve =>
        GLib.timeout_add(0, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }),
    );
}
function percentile(values, fraction) {
    return values[Math.floor(values.length * fraction)];
}
async function measure() {
    const paint = [];
    const intervals = [];
    let start = 0;
    let last = 0;
    let frames = 0;
    const before = global.stage.connect('before-paint', () => {
        start = GLib.get_monotonic_time();
    });
    const after = global.stage.connect('after-paint', () => {
        const end = GLib.get_monotonic_time();
        if (frames++ > 10) {
            paint.push((end - start) / 1000);
            intervals.push((end - last) / 1000);
        }
        last = end;
    });
    const began = GLib.get_monotonic_time();
    try {
        await delay(3000);
    } finally {
        global.stage.disconnect(before);
        global.stage.disconnect(after);
    }
    const seconds = (GLib.get_monotonic_time() - began) / 1e6;
    if (intervals.length === 0) throw new Error('No scrolling frames observed');
    paint.sort((a, b) => a - b);
    intervals.sort((a, b) => a - b);
    return {
        frames,
        fps: frames / seconds,
        paintMedianMs: percentile(paint, 0.5),
        frameMedianMs: percentile(intervals, 0.5),
        frameP95Ms: percentile(intervals, 0.95),
    };
}
export async function run(scale) {
    Main.overview.hide();
    const actor = global
        .get_window_actors()
        .find(a => a.metaWindow?.wmClass?.toLowerCase().includes('chrome'));
    if (!actor) throw new Error('No isolated Chrome window');
    actor.metaWindow.unmaximize(3);
    actor.metaWindow.move_resize_frame(
        true,
        40,
        40,
        Math.floor(global.stage.width - 80),
        Math.floor(global.stage.height - 80),
    );
    await delay(500);
    actor.get_texture()?.set_create_mipmaps(false);
    const variants = [['native', null]];
    for (let round = 0; round < 2; round++) {
        if (BaselineEffect) variants.push(['baseline', BaselineEffect]);
        variants.push(['current', RoundedCornersEffect]);
    }
    variants.push(['native', null]);
    const results = [];
    try {
        for (const [name, Effect] of variants) {
            actor.remove_effect_by_name('rwc-benchmark');
            if (Effect) {
                const effect = new Effect();
                actor.add_effect_with_name('rwc-benchmark', effect);
                effect.updateUniforms(
                    config,
                    {x1: 0, y1: 0, x2: actor.width, y2: actor.height},
                    true,
                );
            }
            await delay(500);
            System.gc();
            results.push({name, scale, ...(await measure())});
        }
    } finally {
        actor.remove_effect_by_name('rwc-benchmark');
    }
    GLib.file_set_contents(
        `${output}/scrolling-${scale}.json`,
        JSON.stringify(results, null, 2),
    );
}
