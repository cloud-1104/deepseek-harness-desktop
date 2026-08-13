// Copy the staged backend into the packaged app's resources directory.
//
// This is a hook rather than an `extraResources` entry because that path takes
// electron-builder's whole-directory copy, whose filter drops `node_modules`
// unconditionally — which is the entire backend. The result was an app that
// shipped a CLI entry with no runtime behind it, and no warning at build time.

const { cp, stat } = require('node:fs/promises')
const { join } = require('node:path')

const STAGING = join(__dirname, '..', 'backend-dist')

/**
 * @param {{ appOutDir: string, packager: { getResourcesDir: (out: string) => string } }} context
 */
exports.default = async function afterPack(context) {
  const entry = join(STAGING, 'lib', 'bin.js')
  try {
    await stat(entry)
  } catch {
    // ENOENT: nothing was staged, so the installer would carry no backend.
    throw new Error(`after-pack: ${entry} is missing; run pnpm run desktop:prepare first.`)
  }
  const destination = join(context.packager.getResourcesDir(context.appOutDir), 'backend')
  await cp(STAGING, destination, { recursive: true, dereference: true })
  console.log(`  • staged backend  to=${destination}`)
}
