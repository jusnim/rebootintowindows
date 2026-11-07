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

const GRUB_CONFIG_PATH = "/boot/grub/grub.cfg"

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
      const entry = await this.getWindowsGrubEntry();
      if (!entry) throw new Error('Windows GRUB entry not found');

      const proc = new Gio.Subprocess({
        argv: ['pkexec', 'grub-reboot', entry],
        flags: Gio.SubprocessFlags.NONE,
      });
      proc.init(null);

      await new Promise((resolve, reject) => {
        proc.wait_check_async(null, (obj, res) => {
          try {
            obj?.wait_check_finish(res);
            resolve(true);
          } catch (e) {
            reject(e);
          }
        });
      });

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

  private async readGrubConfig(): Promise<string> {
    const file = Gio.File.new_for_path(GRUB_CONFIG_PATH);
    try {
      const contents = await new Promise<Uint8Array>((resolve, reject) => {
        file.load_contents_async(null, (obj, res) => {
          try {
            resolve(obj!.load_contents_finish(res)[1]);
          } catch (e) {
            reject(e);
          }
        });
      });
      return new TextDecoder('utf-8').decode(contents);
    } catch (e) {
      if (!(e instanceof GLib.Error) || !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED)) {
        throw e;
      }
    }

    // no permission to read the GRUB config directly --> pkexec
    const proc = new Gio.Subprocess({
      argv: ['pkexec', 'cat', GRUB_CONFIG_PATH],
      flags: Gio.SubprocessFlags.STDOUT_PIPE,
    });
    proc.init(null);

    return new Promise((resolve, reject) => {
      proc.communicate_utf8_async(null, null, (obj, res) => {
        try {
          const [, stdout] = obj!.communicate_utf8_finish(res);
          if (!obj!.get_successful()) throw new Error('Reading GRUB config failed');
          resolve(stdout ?? '');
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  // entry cached together with grub.cfg mtime --> pkexec only required if grub.cfg changed
  private async getWindowsGrubEntry(): Promise<string | null> {
    const mtime = await this.getGrubConfigMtime();
    const cachedEntry = this.settings?.get_string('grub-entry');
    if (cachedEntry && this.settings?.get_int64('grub-cfg-mtime') === mtime) {
      return cachedEntry;
    }

    const entry = this.parseWindowsGrubEntry(await this.readGrubConfig());
    if (entry) {
      this.settings?.set_string('grub-entry', entry);
      this.settings?.set_int64('grub-cfg-mtime', mtime);
    }
    return entry;
  }

  // reading mtime needs access to /boot/grub
  private getGrubConfigMtime(): Promise<number> {
    const file = Gio.File.new_for_path(GRUB_CONFIG_PATH);
    return new Promise((resolve, reject) => {
      file.query_info_async(
        Gio.FILE_ATTRIBUTE_TIME_MODIFIED,
        Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT,
        null,
        (obj, res) => {
          try {
            const info = obj!.query_info_finish(res);
            resolve(info.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED));
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }

  private parseWindowsGrubEntry(grubConfig: string): string | null {
    const menuEntryPattern = /^\s*menuentry\s+(['"])(.*?)\1/;
    for (const line of grubConfig.split(/\r?\n/)) {
      const title = menuEntryPattern.exec(line)?.[2];
      if (title?.toLowerCase().includes('windows')) return title;
    }
    return null;
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
