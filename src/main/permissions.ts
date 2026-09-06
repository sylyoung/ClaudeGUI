/**
 * macOS privacy permissions (TCC) for ClaudeGUI and the Claude processes it is responsible for.
 * Some categories can be requested from the app (a system prompt appears), others can only be
 * switched on by the user in System Settings; for those we open the right pane.
 */
import { execFile } from 'child_process'
import dgram from 'dgram'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { desktopCapturer, Notification, shell, systemPreferences } from 'electron'
import type { PermissionInfo, PermissionState } from '@shared/types'

interface Probe {
  key: string
  label: string
  description: string
  pane?: string
  manual?: boolean
  status(): Promise<{ state: PermissionState; detail?: string }>
  request?(): Promise<void>
}

const HOME = os.homedir()
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security'

function folderProbe(key: string, label: string, dir: string, description: string, pane = 'Privacy_FilesAndFolders'): Probe {
  return {
    key,
    label,
    description,
    pane,
    status: async () => {
      if (!fs.existsSync(dir)) return { state: 'unsupported', detail: `${dir} does not exist` }
      try {
        await fs.promises.readdir(dir)
        return { state: 'granted', detail: dir }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        return { state: code === 'EPERM' || code === 'EACCES' ? 'denied' : 'unknown', detail: `${dir}: ${code ?? (err as Error).message}` }
      }
    },
    // The first read of a protected folder makes macOS show its permission prompt.
    request: async () => {
      try {
        await fs.promises.readdir(dir)
      } catch {
        /* prompt shown or denied */
      }
    }
  }
}

async function osascript(script: string, env: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { env, timeout: 60_000 }, (err, stdout, stderr) => {
      if (!err) resolve({ ok: true, message: String(stdout).trim() })
      else resolve({ ok: false, message: String(stderr || err.message).trim() })
    })
  })
}

function mediaState(kind: 'camera' | 'microphone' | 'screen'): PermissionState {
  try {
    const s = systemPreferences.getMediaAccessStatus(kind)
    return s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : s === 'restricted' ? 'restricted' : s === 'not-determined' ? 'not-determined' : 'unknown'
  } catch {
    return 'unknown'
  }
}

export class PermissionService {
  private remembered: Record<string, { state: PermissionState; detail?: string; at: number }> = {}
  private file: string
  private probes: Probe[]

  constructor(
    userDataPath: string,
    private getEnv: () => Promise<Record<string, string>>,
    private log: (...a: unknown[]) => void
  ) {
    this.file = path.join(userDataPath, 'permissions.json')
    try {
      this.remembered = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this.remembered = {}
    }
    const remember = (key: string, state: PermissionState, detail?: string) => {
      this.remembered[key] = { state, detail, at: Date.now() }
      try {
        fs.writeFileSync(this.file, JSON.stringify(this.remembered, null, 2))
      } catch {
        /* best effort */
      }
    }
    const automationProbe = (key: string, appName: string, script: string): Probe => ({
      key,
      label: `Automation: ${appName}`,
      description: `Let ClaudeGUI (and Claude's shell tools such as osascript) control ${appName} through AppleScript.`,
      pane: 'Privacy_Automation',
      status: async () => {
        const r = this.remembered[key]
        return r ? { state: r.state, detail: r.detail } : { state: 'not-determined', detail: 'Not requested yet' }
      },
      request: async () => {
        const r = await osascript(script, await this.getEnv())
        const denied = /-1743|not permitted|not allowed/i.test(r.message)
        remember(key, r.ok ? 'granted' : denied ? 'denied' : 'unknown', r.ok ? undefined : r.message.slice(0, 160))
      }
    })
    this.probes = [
      {
        key: 'fullDisk',
        label: 'Full Disk Access',
        description: 'Lets Claude read and write anywhere, including Mail, Safari, Time Machine and other protected folders. Must be switched on manually.',
        pane: 'Privacy_AllFiles',
        manual: true,
        status: async () => {
          const tcc = path.join(HOME, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
          try {
            await fs.promises.access(tcc, fs.constants.R_OK)
            return { state: 'granted' }
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code
            return { state: code === 'EPERM' || code === 'EACCES' ? 'denied' : 'unknown', detail: code === 'ENOENT' ? 'Probe file missing' : undefined }
          }
        }
      },
      folderProbe('desktop', 'Desktop folder', path.join(HOME, 'Desktop'), 'Access to files on the Desktop.'),
      folderProbe('documents', 'Documents folder', path.join(HOME, 'Documents'), 'Access to files in Documents.'),
      folderProbe('downloads', 'Downloads folder', path.join(HOME, 'Downloads'), 'Access to files in Downloads.'),
      folderProbe('icloud', 'iCloud Drive', path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), 'Access to files in iCloud Drive.'),
      {
        key: 'volumes',
        label: 'Removable and network volumes',
        description: 'Access to external disks and network shares under /Volumes.',
        pane: 'Privacy_FilesAndFolders',
        status: async () => {
          let names: string[]
          try {
            names = (await fs.promises.readdir('/Volumes')).filter((n) => n !== 'Macintosh HD')
          } catch {
            return { state: 'unknown' }
          }
          if (!names.length) return { state: 'unsupported', detail: 'No external or network volume is mounted' }
          const results: string[] = []
          let denied = false
          for (const n of names) {
            try {
              await fs.promises.readdir(path.join('/Volumes', n))
              results.push(`${n}: ok`)
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code
              if (code === 'EPERM' || code === 'EACCES') denied = true
              results.push(`${n}: ${code}`)
            }
          }
          return { state: denied ? 'denied' : 'granted', detail: results.join(', ') }
        },
        request: async () => {
          try {
            for (const n of await fs.promises.readdir('/Volumes')) await fs.promises.readdir(path.join('/Volumes', n)).catch(() => undefined)
          } catch {
            /* ignore */
          }
        }
      },
      {
        key: 'accessibility',
        label: 'Accessibility',
        description: 'Needed to control the keyboard and mouse of other apps (GUI automation tools). Must be switched on manually after the prompt.',
        pane: 'Privacy_Accessibility',
        manual: true,
        status: async () => ({ state: systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied' }),
        request: async () => {
          systemPreferences.isTrustedAccessibilityClient(true)
        }
      },
      {
        key: 'screen',
        label: 'Screen Recording',
        description: 'Needed for screenshots of other windows (for example the screencapture tool). Must be switched on manually after the prompt.',
        pane: 'Privacy_ScreenCapture',
        manual: true,
        status: async () => ({ state: mediaState('screen') }),
        request: async () => {
          try {
            await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
          } catch {
            /* prompt shown */
          }
        }
      },
      {
        key: 'camera',
        label: 'Camera',
        description: 'Only relevant when a tool asks for the camera.',
        pane: 'Privacy_Camera',
        status: async () => ({ state: mediaState('camera') }),
        request: async () => {
          await systemPreferences.askForMediaAccess('camera').catch(() => false)
        }
      },
      {
        key: 'microphone',
        label: 'Microphone',
        description: 'Only relevant when a tool records audio.',
        pane: 'Privacy_Microphone',
        status: async () => ({ state: mediaState('microphone') }),
        request: async () => {
          await systemPreferences.askForMediaAccess('microphone').catch(() => false)
        }
      },
      automationProbe('automationSystemEvents', 'System Events', 'tell application "System Events" to return name of first process'),
      automationProbe('automationFinder', 'Finder', 'tell application "Finder" to return name of startup disk'),
      automationProbe('automationTerminal', 'Terminal', 'tell application "Terminal" to return name'),
      {
        key: 'notifications',
        label: 'Notifications',
        description: 'Turn-finished, permission and error alerts. macOS asks the first time a notification is shown.',
        pane: 'Notifications',
        status: async () => {
          const r = this.remembered.notifications
          if (!Notification.isSupported()) return { state: 'unsupported' }
          return r ? { state: r.state, detail: r.detail } : { state: 'not-determined', detail: 'Not requested yet' }
        },
        request: async () => {
          const n = new Notification({ title: 'ClaudeGUI', body: 'Notifications are working.' })
          n.show()
          remember('notifications', 'granted', 'Test notification sent; if nothing appeared, allow ClaudeGUI in System Settings → Notifications')
        }
      },
      {
        key: 'localNetwork',
        label: 'Local Network',
        description: 'Needed when tools talk to devices on your local network (macOS 15 and later ask for it).',
        pane: 'Privacy_LocalNetwork',
        status: async () => {
          const r = this.remembered.localNetwork
          return r ? { state: r.state, detail: r.detail } : { state: 'not-determined', detail: 'Not requested yet' }
        },
        request: async () => {
          await new Promise<void>((resolve) => {
            const sock = dgram.createSocket('udp4')
            sock.on('error', () => resolve())
            sock.send(Buffer.from('claudegui'), 5353, '224.0.0.251', () => {
              sock.close()
              resolve()
            })
          })
          remember('localNetwork', 'granted', 'Prompt triggered (mDNS packet sent)')
        }
      },
      {
        key: 'devTools',
        label: 'Developer Tools',
        description: 'Lets the app run software that does not meet the system security policy (unsigned binaries). Manual.',
        pane: 'Privacy_DevTools',
        manual: true,
        status: async () => ({ state: 'unknown', detail: 'macOS does not expose this state; check System Settings' })
      },
      {
        key: 'appManagement',
        label: 'App Management',
        description: 'Lets the app update or modify other apps. Not needed for ClaudeGUI updating itself. Manual.',
        pane: 'Privacy_AppBundles',
        manual: true,
        status: async () => ({ state: 'unknown', detail: 'macOS does not expose this state; check System Settings' })
      }
    ]
  }

  async list(): Promise<PermissionInfo[]> {
    const out: PermissionInfo[] = []
    for (const p of this.probes) {
      let s: { state: PermissionState; detail?: string }
      try {
        s = await p.status()
      } catch (err) {
        s = { state: 'unknown', detail: (err as Error).message }
      }
      out.push({ key: p.key, label: p.label, description: p.description, state: s.state, detail: s.detail, canRequest: Boolean(p.request), hasPane: Boolean(p.pane), manual: p.manual })
    }
    return out
  }

  async request(key: string): Promise<PermissionInfo[]> {
    const p = this.probes.find((x) => x.key === key)
    if (!p) throw new Error(`Unknown permission ${key}`)
    if (p.request) {
      this.log(`[permissions] requesting ${key}`)
      await p.request()
    }
    return this.list()
  }

  /** Trigger every prompt the app can trigger itself, one after the other. */
  async requestAll(): Promise<PermissionInfo[]> {
    for (const p of this.probes) {
      if (!p.request) continue
      try {
        this.log(`[permissions] requesting ${p.key}`)
        await p.request()
      } catch (err) {
        this.log(`[permissions] ${p.key}: ${(err as Error).message}`)
      }
    }
    return this.list()
  }

  async openPane(key: string): Promise<void> {
    const p = this.probes.find((x) => x.key === key)
    if (key === 'notifications') return shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension')
    const pane = p?.pane
    await shell.openExternal(pane ? `${SETTINGS_URL}?${pane}` : SETTINGS_URL)
  }
}
