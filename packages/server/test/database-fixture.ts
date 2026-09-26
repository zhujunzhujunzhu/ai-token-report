/** 测试的显式身份导入；生产启动绝不调用此助手或自动读取凭证文件。 */
import { preparePortalDatabase, type PortalTarget } from '@ai-token-report/core/db'
import type { CredentialInput } from '../src/credentials.js'
import { IdentityRepository } from '../src/identity/index.js'

export async function seedDatabaseIdentity(target: PortalTarget, entries: CredentialInput[]): Promise<IdentityRepository> {
  await preparePortalDatabase(target)
  const repository = new IdentityRepository(target)
  const credentials = entries.some(entry => entry.role === 'admin') ? entries : [
    ...entries, { name: '夹具管理员', role: 'admin' as const, token: 'fixture-admin-bootstrap-secret' },
  ]
  await repository.importCredentials(credentials, 'isolated-test-fixture')
  return repository
}
