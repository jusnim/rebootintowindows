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

  constructor(metadata: any) {
    super(metadata);
  }

  private modifySystemItem(): void {
    this.menu =
      panel.statusArea.quickSettings?._system?.quickSettingsItems[0].menu;

    // if(this.manager == null){
    //   return
    // }
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
    if (!panel.statusArea.quickSettings?._system) {
      this.queueModifySystemItem();
    } else {
      this.modifySystemItem();
    }
  }

  disable() {
    this.clearIntervals();
    this.rebootToWindowsItem?.destroy();
    this.rebootToWindowsItem = null;
    this.proxy = null;
    if (this.sourceId) {
      GLib.Source.remove(this.sourceId);
      this.sourceId = null;
    }
  }

  private get_windows_grub_entry(file_path : string) {
    const file = Gio.File.new_for_path(file_path);

    let boot_entry = ""
    let content = file.load_contents(null)[1]
    const contentsText = new TextDecoder('utf-8').decode(content);
    const arr = contentsText.split(/\r?\n/);

    let menu_pattern = new RegExp("^\\s*menuentry ['\"]([^'\"]*)['\"]")

    arr.forEach((line : string) => {
      let matches = menu_pattern.exec(line) 
      if (matches != null && ! matches[1].toLowerCase().search("windows")){ 
          boot_entry = matches[1]
      }   
    }
    );
    return boot_entry
}

  private async reboot(){
    let windows_grub_entry = this.get_windows_grub_entry(GRUB_CONFIG_PATH)
    const [, argv] = GLib.shell_parse_argv(`pkexec grub-reboot "${windows_grub_entry}"`)
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.NONE)
    await proc.wait_check_async(null);
    this.proxy?.RebootRemote(true);    
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
      // style_class: 'dialog-title' // TODO investigate why css classes are not working
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
