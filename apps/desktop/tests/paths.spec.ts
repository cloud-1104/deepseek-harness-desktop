import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveLayout } from '../src/paths.ts'

describe('desktop layout', () => {
  it('reads the backend out of extraResources when packaged', () => {
    const layout = resolveLayout({
      packaged: true,
      appPath: join('/Applications', 'Harness.app', 'Contents', 'Resources', 'app.asar'),
      resourcesPath: join('/Applications', 'Harness.app', 'Contents', 'Resources'),
      userData: join('/Users', 'someone', 'Library', 'Application Support', 'Harness'),
    })

    expect(layout.backendRoot).toBe(join('/Applications', 'Harness.app', 'Contents', 'Resources', 'backend'))
    expect(layout.backendEntry).toBe(join(layout.backendRoot, 'lib', 'bin.js'))
  })

  it('reads the staged closure in development too, never the workspace layout', () => {
    const layout = resolveLayout({
      packaged: false,
      appPath: join('/repo', 'apps', 'desktop'),
      resourcesPath: join('/somewhere', 'electron', 'resources'),
      userData: join('/Users', 'someone', 'Library', 'Application Support', 'Electron'),
    })

    expect(layout.backendEntry).toBe(join('/repo', 'apps', 'desktop', 'backend-dist', 'lib', 'bin.js'))
  })

  it('keeps the directories the shell owns under userData, and separate', () => {
    const userData = join('/Users', 'someone', 'AppData', 'Harness')
    const layout = resolveLayout({
      packaged: true,
      appPath: join('/app', 'resources', 'app.asar'),
      resourcesPath: join('/app', 'resources'),
      userData,
    })

    for (const path of [layout.workspaceDir, layout.logDir]) {
      expect(path.startsWith(userData)).toBe(true)
    }
    expect(layout.workspaceDir).not.toBe(layout.logDir)
  })

  it('ships the composition overlay outside the asar when packaged', () => {
    const layout = resolveLayout({
      packaged: true,
      appPath: join('/app', 'resources', 'app.asar'),
      resourcesPath: join('/app', 'resources'),
      userData: join('/Users', 'someone', 'AppData', 'Harness'),
    })

    expect(layout.patchFile).toBe(join('/app', 'resources', 'desktop.patch.yml'))
  })
})
