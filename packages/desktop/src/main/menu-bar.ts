import { Menu, Tray, app, clipboard, nativeImage, shell } from 'electron';
import { join } from 'node:path';
import type { TunnelStatus } from '@localtunnel/agent';
import { summarize, type MenuBarSummary } from './menu-bar-model.js';

/**
 * The macOS menu bar item.
 *
 * macOS only. Electron's Tray is an NSStatusItem there, and the icons are
 * template images, so the system tints them for a light or dark menu bar and
 * inverts them again while the menu is open — which is the whole of light/dark
 * support for a status item, and the reason nothing here reads nativeTheme.
 *
 * It owns no tunnel state. Everything it shows comes from the agent's status
 * over the existing AgentSupervisor, and Start/Stop call the same supervisor
 * methods the window's buttons do, so there is exactly one implementation of
 * "start the tunnel" in the app.
 */

export interface MenuBarHandlers {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  /** Bring the main window forward; absent in menu-bar-only mode. */
  showWindow?(): void;
  quit(): void;
}

/** Would a menu bar item make sense on this platform? */
export function menuBarSupported(): boolean {
  return process.platform === 'darwin';
}

export class MenuBar {
  private tray: Tray | null = null;
  private summary: MenuBarSummary = summarize(null);
  /** Which template image is currently set, so it is not reassigned every second. */
  private icon: 'idle' | 'connected' | null = null;

  constructor(private readonly handlers: MenuBarHandlers) {}

  /** Create the status item. Safe to call on any platform; a no-op off macOS. */
  create(): void {
    if (!menuBarSupported() || this.tray) return;
    this.tray = new Tray(trayImage('idle'));
    this.icon = 'idle';
    this.render();
  }

  /** Show what the agent last reported. */
  update(status: TunnelStatus | null): void {
    this.summary = summarize(status);
    this.render();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
    this.icon = null;
  }

  private render(): void {
    const tray = this.tray;
    if (!tray) return;
    if (this.icon !== this.summary.icon) {
      tray.setImage(trayImage(this.summary.icon));
      this.icon = this.summary.icon;
    }
    tray.setToolTip(this.summary.tooltip);
    tray.setContextMenu(Menu.buildFromTemplate(this.template()));
  }

  private template(): Electron.MenuItemConstructorOptions[] {
    const s = this.summary;
    const items: Electron.MenuItemConstructorOptions[] = [
      // Disabled items are how a status menu shows state: macOS status menus
      // are menus, not windows, and grey non-actionable lines are the native
      // idiom for the ones you read rather than click.
      { label: s.stateLabel, enabled: false },
    ];
    if (s.detail) items.push({ label: s.detail, enabled: false });

    if (s.services.length > 0) {
      items.push({ type: 'separator' });
      for (const service of s.services) {
        items.push({ label: service.name, enabled: false });
        items.push({
          label: `    ${service.url ?? 'Not published yet'}`,
          enabled: Boolean(service.url),
          // Clicking a URL opens it, which is what anyone reading it wants.
          click: service.url ? () => void shell.openExternal(service.url!) : undefined,
          toolTip: service.url ? 'Open in your browser' : undefined,
        });
        items.push({
          label: `    → ${service.target}${service.reachable === false ? ' (not listening)' : ''}`,
          enabled: false,
        });
      }
    }

    items.push(
      { type: 'separator' },
      {
        label: 'Copy Public URL',
        enabled: Boolean(s.primaryUrl),
        click: () => {
          if (s.primaryUrl) clipboard.writeText(s.primaryUrl);
        },
      },
      s.canStop
        ? { label: 'Stop Tunnel', click: () => void this.handlers.stop().catch(() => undefined) }
        : { label: 'Start Tunnel', enabled: s.canStart, click: () => void this.handlers.start().catch(() => undefined) },
    );

    if (this.handlers.showWindow) {
      items.push({ type: 'separator' }, { label: 'Open LocalTunnel…', click: () => this.handlers.showWindow!() });
    }

    items.push(
      { type: 'separator' },
      { label: `Quit ${app.getName()}`, accelerator: 'Command+Q', click: () => this.handlers.quit() },
    );
    return items;
  }
}

/**
 * A template image for the status item.
 *
 * The `Template` suffix is not decoration: macOS treats an image so named as a
 * mask to be tinted, which is what makes one asset correct in both appearances.
 * The path resolves the same packed or not — dist/main sits one level under the
 * package root in the repo and under app.asar in a build, and Electron reads
 * through the archive.
 */
function trayImage(icon: 'idle' | 'connected'): Electron.NativeImage {
  const name = icon === 'connected' ? 'trayConnectedTemplate.png' : 'trayTemplate.png';
  const image = nativeImage.createFromPath(
    join(__dirname, '..', '..', 'assets', 'icons', 'tray', name),
  );
  image.setTemplateImage(true);
  return image;
}
