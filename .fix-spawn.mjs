import { readFileSync, writeFileSync } from 'node:fs'

const path = 'packages/sandbox/sandbox-windows-acl/src/spawn.ts'
let text = readFileSync(path, 'utf8')

const edits = [
  [
    ' * pipe-based and unaffected; the child shares the host console.\n',
    ' * pipe-based and unaffected; the child shares the host console. When that\n'
    + ' * console is one this process had to allocate for itself, the child is started\n'
    + ' * with the hidden show state so attaching to it does not raise its window.\n',
  ],
  [
    "import { allocPtrSlot,",
    "import { hostConsoleIsHidden } from './console.ts'\nimport { allocPtrSlot,",
  ],
  [
    "  setInheritable(api, stdErr.write, 'stderr write end')\n\n  const startupInfo = allocStartupInfo()\n"
    + '  encodeStartupInfo(startupInfo, {\n    cb: abi.STARTUPINFOW_SIZE,\n    dwFlags: abi.STARTF_USESTDHANDLES,\n',
    "  setInheritable(api, stdErr.write, 'stderr write end')\n\n"
    + '  // A child attaching to a shared console re-shows its window unless it asks\n'
    + '  // for the hidden state; only a console this process created may be kept down.\n'
    + '  const hidden = hostConsoleIsHidden(api)\n'
    + '  const startupInfo = allocStartupInfo()\n'
    + '  encodeStartupInfo(startupInfo, {\n    cb: abi.STARTUPINFOW_SIZE,\n'
    + '    dwFlags: abi.STARTF_USESTDHANDLES | (hidden ? abi.STARTF_USESHOWWINDOW : 0),\n'
    + '    wShowWindow: hidden ? abi.SW_HIDE : 0,\n',
  ],
  [
    "  makeInheritable(stdErr, 'stderr')\n\n  const startupInfo = allocStartupInfo()\n"
    + '  encodeStartupInfo(startupInfo, {\n    cb: abi.STARTUPINFOW_SIZE,\n    dwFlags: abi.STARTF_USESTDHANDLES,\n',
    "  makeInheritable(stdErr, 'stderr')\n\n"
    + '  // Same reason as the piped spawn: a shared console must not be raised by\n'
    + '  // the child attaching to it.\n'
    + '  const hidden = hostConsoleIsHidden(api)\n'
    + '  const startupInfo = allocStartupInfo()\n'
    + '  encodeStartupInfo(startupInfo, {\n    cb: abi.STARTUPINFOW_SIZE,\n'
    + '    dwFlags: abi.STARTF_USESTDHANDLES | (hidden ? abi.STARTF_USESHOWWINDOW : 0),\n'
    + '    wShowWindow: hidden ? abi.SW_HIDE : 0,\n',
  ],
]

for (const [from, to] of edits) {
  if (!text.includes(from)) throw new Error(`anchor not found: ${JSON.stringify(from.slice(0, 60))}`)
  text = text.replace(from, to)
}

writeFileSync(path, text, 'utf8')
const bytes = readFileSync(path)
console.log('validUtf8=', Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes))
