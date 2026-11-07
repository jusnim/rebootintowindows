/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

/* exported init */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Pango from 'gi://Pango';
import { panel } from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';


import {
  Extension,
  gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class RebootToWindowsExtension extends Extension {
  private menu: any;
  private proxy!: any | null;
  private rebootToWindowsItem!: PopupMenu.PopupMenuItem | null;
  private counter!: number;
  private seconds!: number;
  private counterIntervalId!: GLib.Source;
  private messageIntervalId!: GLib.Source;
  private sourceId!: number | null;
  private manager!: any
  private settings!: Gio.Settings | null;

  constructor(metadata: any) {
    super(metadata);
  }

  private modifySystemItem(): void {
    this.menu =
      panel.statusArea.quickSettings?._system?.quickSettingsItems[0].menu;

    this.proxy = this.manager(
      Gio.DBus.system,
      'org.freedesktop.login1',
      '/org/freedesktop/login1',
    );

    this.rebootToWindowsItem = new PopupMenu.PopupMenuItem(
      `${_('Restart to Windows')}...`,
    );

    this.rebootToWindowsItem.connect('activate', () => {
      this.counter = 60;
      this.seconds = this.counter;

      const dialog = this.buildDialog();
      dialog.open();

      this.counterIntervalId = setInterval(() => {
        if (this.counter > 0) {
          this.counter--;
          if (this.counter % 10 === 0) {
            this.seconds = this.counter;
          }
        } else {
          this.clearIntervals();
          this.reboot();
        }
      }, 1000);
    });

    this.menu.addMenuItem(this.rebootToWindowsItem, 2);
  }

  private queueModifySystemItem(): void {
    this.sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      if (!panel.statusArea.quickSettings?._system) return GLib.SOURCE_CONTINUE;

      this.modifySystemItem();
      return GLib.SOURCE_REMOVE;
    });
  }

  enable() {
  const ManagerInterface: string = `<node>
  <interface name="org.freedesktop.login1.Manager">
    <method name="Reboot">
      <arg type="b" direction="in"/>
    </method>
  </interface>
  </node>`;
  this.manager = Gio.DBusProxy.makeProxyWrapper(ManagerInterface);
  this.settings = this.getSettings();
    if (!panel.statusArea.quickSettings?._system) {
      this.queueModifySystemItem();
    } else {
      this.modifySystemItem();
    }
  }

  disable() {
    this.manager = null
    this.settings = null;
    this.clearIntervals();
    this.rebootToWindowsItem?.destroy();
    this.rebootToWindowsItem = null;
    this.proxy = null;
    if (this.sourceId) {
      GLib.Source.remove(this.sourceId);
      this.sourceId = null;
    }
  }
private async reboot() {
    try {
      this.clearIntervals();
    } catch (e) {
      // ignore
    }

    try {
      // entry cached together with grub.cfg mtime --> pkexec cat only required if grub.cfg changed
      const GRUB_CONFIG_PATH = '/boot/grub/grub.cfg';
      const mtime = await this.getMtime(GRUB_CONFIG_PATH);
      let entry = this.settings!.get_int64('grub-cfg-mtime') === mtime ? this.settings!.get_string('grub-entry') : '';
      if (!entry) {
        const grubConfig = await this.spawn(['pkexec', 'cat', GRUB_CONFIG_PATH]);
        entry = grubConfig.match(/^\s*menuentry\s+['"]([^'"]*windows[^'"]*)['"]/im)?.[1] ?? '';
        if (!entry) throw new Error('Windows GRUB entry not found');
        this.settings!.set_string('grub-entry', entry);
        this.settings!.set_int64('grub-cfg-mtime', mtime);
      }
      await this.spawn(['pkexec', 'grub-reboot', entry]);

      this.proxy?.RebootRemote(true);
    } catch (e) {
      this.clearIntervals();
      console.error(`RebootToWindows Error:`, e);
      
      const errorDialog = new ModalDialog.ModalDialog({ styleClass: 'modal-dialog' });
      const label = new St.Label({
        text: _(`Error: Windows GRUB entry not found or authentication cancelled.`),
      });
      label.clutterText.lineWrap = true;
      
      errorDialog.contentLayout.add_child(label);
      errorDialog.setButtons([
        {
          label: _('OK'),
          action: () => errorDialog.close(),
          default: true,
        },
      ]);
      
      errorDialog.open();
    }
  }

  // reading mtime needs access to the parent directory only
  private getMtime(path: string): Promise<number> {
    return new Promise((resolve, reject) => {
      Gio.File.new_for_path(path).query_info_async(
        Gio.FILE_ATTRIBUTE_TIME_MODIFIED,
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        null,
        (obj, res) => {
          try {
            resolve(obj!.query_info_finish(res).get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED));
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }

  private spawn(argv: string[]): Promise<string> {
    const proc = new Gio.Subprocess({ argv, flags: Gio.SubprocessFlags.STDOUT_PIPE });
    proc.init(null);

    return new Promise((resolve, reject) => {
      proc.communicate_utf8_async(null, null, (obj, res) => {
        try {
          const [, stdout] = obj!.communicate_utf8_finish(res);
          if (!obj!.get_successful()) throw new Error(`${argv.join(' ')} failed`);
          resolve(stdout ?? '');
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private buildDialog(): ModalDialog.ModalDialog {
    const dialog = new ModalDialog.ModalDialog({ styleClass: 'modal-dialog' });
    dialog.setButtons([
      {
        label: _('Cancel'),
        action: () => {
          this.clearIntervals();
          dialog.close();
        },
        key: Clutter.KEY_Escape,
        default: false,
      },
      {
        label: _('Restart'),
        action: () => {
          this.clearIntervals();
          this.reboot();
        },
        default: false,
      },
    ]);

    const dialogTitle = new St.Label({
      text: _('Restart into Windows'),
      style: 'font-weight: bold;font-size:18px',
    });

    let dialogMessage = new St.Label({
      text: this.getDialogMessageText(),
    });
    dialogMessage.clutterText.ellipsize = Pango.EllipsizeMode.NONE;
    dialogMessage.clutterText.lineWrap = true;

    const titleBox = new St.BoxLayout({
      xAlign: Clutter.ActorAlign.CENTER,
    });
    titleBox.add_child(new St.Label({ text: '  ' }));
    titleBox.add_child(dialogTitle);

    let box = new St.BoxLayout({ yExpand: true, vertical: true });
    box.add_child(titleBox);
    box.add_child(new St.Label({ text: '  ' }));
    box.add_child(dialogMessage);

    this.messageIntervalId = setInterval(() => {
      dialogMessage?.set_text(this.getDialogMessageText());
    }, 500);

    dialog.contentLayout.add_child(box);

    return dialog;
  }

  private getDialogMessageText(): string {
    return _(`The system will restart automatically in %d seconds.`).replace(
      '%d',
      String(this.seconds),
    );
  }

  private clearIntervals(): void {
    clearInterval(this.counterIntervalId);
    clearInterval(this.messageIntervalId);
  }
}
