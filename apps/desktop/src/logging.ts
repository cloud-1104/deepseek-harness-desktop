/**
 * Append-only capture of the backend child's output. The window shows the file
 * path when the backend fails, so a user can report a startup problem without
 * a terminal.
 * @module @deepseek-ai/dsh-desktop/logging
 */

import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

/** Current log file name inside the log directory. */
const CURRENT = 'backend.log'

/** Name the current file is rotated to once it exceeds the size limit. */
const PREVIOUS = 'backend.previous.log'

/** Writes backend output lines to a size-capped file, keeping one prior generation. */
export class BackendLog {
  /** Absolute path of the file currently being written. */
  readonly filePath: string

  private readonly stream: WriteStream

  /**
   * @param dir - directory the log files live in; created when missing.
   * @param maxBytes - size above which the existing log is rotated at open time.
   */
  constructor(dir: string, maxBytes: number) {
    mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, CURRENT)
    rotateIfLarge(this.filePath, join(dir, PREVIOUS), maxBytes)
    this.stream = createWriteStream(this.filePath, { flags: 'a' })
  }

  /**
   * Record one line with a timestamp.
   * @param line - the backend output line, without its terminator.
   */
  append(line: string): void {
    this.stream.write(`${new Date().toISOString()} ${line}\n`)
  }

  /** Flush and release the file handle. */
  close(): void {
    this.stream.end()
  }
}

/**
 * Rotate the current log when it has grown past the limit.
 * @param current - path of the active log file.
 * @param previous - path the active file is renamed to.
 * @param maxBytes - size above which rotation happens.
 */
function rotateIfLarge(current: string, previous: string, maxBytes: number): void {
  let size: number
  try {
    size = statSync(current).size
  } catch {
    // ENOENT only: no log from a previous run, so there is nothing to rotate.
    return
  }
  if (size <= maxBytes) return
  renameSync(current, previous)
}
