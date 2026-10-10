/** Windows 索引器可能短暂持有旧快照；原子替换重试，绝不先删目标造成记录丢失。 */
import { rename } from 'node:fs/promises'
export async function replaceAssistantFile(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 6) throw error
      await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt))
    }
  }
}
