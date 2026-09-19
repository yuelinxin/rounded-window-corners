/** @file Contains the implementation of the preferences page. */

import type Adw from 'gi://Adw';

import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {prefsTabs} from './preferences/index.js';
import {logDebug} from './utils/log.js';
import {initPrefs, uninitPrefs} from './utils/settings.js';

export default class RoundedWindowCornersRebornPrefs extends ExtensionPreferences {
    // biome-ignore lint/suspicious/useAwait: ExtensionPreferences requires this to be async
    async fillPreferencesWindow(win: Adw.PreferencesWindow) {
        initPrefs(this.getSettings());

        for (const page of prefsTabs) {
            win.add(new page());
        }

        // Disconnect all signals when closing the preferences
        win.connect('close-request', () => {
            logDebug('Disconnect Signals');
            uninitPrefs();
        });

        this.#loadCss();
    }

    #loadCss() {
        const display = Gdk.Display.get_default();
        if (display) {
            const css = new Gtk.CssProvider();
            css.load_from_file(this.dir.get_child('stylesheet-prefs.css'));
            Gtk.StyleContext.add_provider_for_display(display, css, 0);
        }
    }
}
