/**
 * Portal v4 数据库设计原型：执行两份 DDL 并验证真实约束、事务和历史引用。
 * 这不是应用 E2E，也不是生产迁移。只建随机隔离 SQLite / MySQL schema。
 * MySQL 不可连接或无建库权限时明确失败；不进入配置 URL 原来指定的业务库。
 * 用法：bun run packages/server/verify/verify-database-design.ts
 */
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSqliteDatabase } from '../../core/src/db/driver.js'
import { openMysqlBackend, type MysqlBackend } from '../../core/src/db/mysql.js'

type Params = Record<string, string | number | null>
interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T[]>
  get<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T | null>
  run(sql: string, params?: Params): Promise<{ changes: number }>
  exec(sql: string): Promise<void>
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
  close(): Promise<void>
}
const root = resolve(import.meta.dir, '../../..')
const artifactDir = mkdtempSync(join(tmpdir(), 'atr-database-v4-'))
const mysqlSchema = `atr_v4_verify_${Date.now()}_${randomBytes(5).toString('hex')}`
assert.match(mysqlSchema, /^atr_v4_verify_[0-9]+_[a-f0-9]{10}$/)
const mysqlConnection = process.env['ATR_MYSQL_URL']?.trim()
if (!mysqlConnection) throw new Error('请显式设置 ATR_MYSQL_URL 为可创建隔离测试库的连接')
const mysqlUrl = new URL(mysqlConnection)
// ★ 控制连接只读 information_schema；Bun 的空路径会默认连 mysql 系统库。
// 不打开 URL 原来指定的 ai-token 等业务库。
mysqlUrl.pathname = '/information_schema'
mysqlUrl.search = ''
mysqlUrl.hash = ''
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const seedAdmin = '00000000-0000-4000-8000-000000000001'
const seedMember = '00000000-0000-4000-8000-000000000002'
const tableNames = ['departments','members','roles','permissions','member_roles','role_permissions','login_accounts','report_tokens','report_token_scopes','auth_sessions','auth_challenges','auth_rate_limit_buckets','admin_audit_log','legacy_attribution_map','portal_identity_state','portal_schema_migrations','usage_event']
const results: { backend: string; checks: string[]; error?: string }[] = []
const ddlHashes: Record<string, string> = {}
const versions: Record<string,string>={runtime:`Bun ${Bun.version}`}

function sqlite(path: string): Db {
  const db = createSqliteDatabase(path)
  let closed=false
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL')
  const api: Db = {
    async all<T>(sql: string, params?: Params) { return db.query<T>(sql).all(params as never) },
    async get<T>(sql: string, params?: Params) { return db.query<T>(sql).get(params as never) ?? null },
    async run(sql, params) { return { changes: Number(db.query(sql).run(params as never).changes) } },
    async exec(sql) { db.exec(sql) },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      // 仅测试编排器：同步 SQLite 锁等待必须让出事件循环，否则另一个事务不能提交。
      for (let attempt = 0; ; attempt++) {
        try { db.exec('BEGIN IMMEDIATE'); break } catch (error) {
          if (!/SQLITE_BUSY|database is locked/.test(String(error)) || attempt >= 100) throw error
          await Bun.sleep(10)
        }
      }
      try { const value = await fn(api); db.exec('COMMIT'); return value }
      catch (error) { db.exec('ROLLBACK'); throw error }
    },
    async close() { if(!closed) {db.close();closed=true} },
  }
  return api
}

function safeError(error: unknown): string {
  // 不打印驱动错误的 URL、SQL 参数或连接秘密；具体失败由当前检查标签定位。
  if (error instanceof assert.AssertionError) return error.message.split('\n')[0]!
  const code = (error as { code?: string; errno?: number } | null)?.code
  let message=error instanceof Error?error.message:'unknown'
  for(const secret of [mysqlUrl.href,mysqlUrl.password,decodeURIComponent(mysqlUrl.password),mysqlUrl.username,decodeURIComponent(mysqlUrl.username)]) {
    if(secret) message=message.replaceAll(secret,'[redacted]')
  }
  message=message.replace(/mysql:\/\/\S+/g,'[mysql-url]').split('\n')[0]!.slice(0,240)
  return `数据库执行失败 (${code ?? (error as { name?: string } | null)?.name ?? 'unknown'}): ${message}`
}

async function verify(db: Db, kind: 'sqlite' | 'mysql', second: () => Promise<Db>): Promise<void> {
  const result = { backend: kind, checks: [] as string[] }
  results.push(result)
  let active = '建表'
  const check = (label: string, value: unknown) => {
    active = label
    assert.ok(value, label)
    result.checks.push(label)
    console.log(`  PASS ${kind}: ${label}`)
  }
  const rejected = async (label: string, action: () => Promise<unknown>) => {
    active = label
    let constraint = false
    try { await action() } catch (error) {
      constraint = /constraint|foreign key|duplicate entry|data too long|check.*violated/i.test(String(error))
      if (!constraint) throw error
    }
    check(label, constraint)
  }
  const insert = (table: string, values: Params, tx = db) => {
    assert.ok(tableNames.includes(table))
    const keys = Object.keys(values)
    assert.ok(keys.every(k => /^[a-z_]+$/.test(k)))
    const params = Object.fromEntries(keys.map((key, i) => [`$p${i}`, values[key]!]))
    return tx.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$p${i}`).join(',')})`, params)
  }
  const scalar = async (sql: string, params?: Params) => Number((await db.get<{ n: unknown }>(sql, params))?.n)
  try {
    const ddl = readFileSync(join(root, `docs/database-v4/schema.${kind}.sql`), 'utf8')
    ddlHashes[kind] = sha(ddl)
    assert.ok(!/^\s*(ALTER|DROP)\s/im.test(ddl), 'DDL 只允许创建新库结构')
    await db.exec(ddl)
    check('17 张表可真实创建', (await Promise.all(tableNames.map(t=>scalar(`SELECT COUNT(*) AS n FROM ${t}`)))).every(Number.isFinite))
    check('12 个权限与两个内置角色', await scalar('SELECT COUNT(*) AS n FROM permissions')===12 && await scalar('SELECT COUNT(*) AS n FROM roles')===2)
    check('admin 有 12 项、member 有 4 项权限', await scalar('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=$id', {$id:seedAdmin})===12 && await scalar('SELECT COUNT(*) AS n FROM role_permissions WHERE role_id=$id', {$id:seedMember})===4)
    check('DDL 没伪造迁移完成或初始化管理员', await scalar('SELECT COUNT(*) AS n FROM portal_schema_migrations')===0 && await scalar('SELECT COUNT(*) AS n FROM login_accounts')===0)
    const migrationId = randomUUID()
    await insert('portal_schema_migrations', {migration_id:migrationId,version:4,checksum:sha(ddl),status:'started',last_completed_step:1,checkpoint_json:JSON.stringify({verified_tables:tableNames}),started_at_ms:1})
    check('独立 v4 迁移步骤可记录为未完成', Number((await db.get('SELECT version FROM portal_schema_migrations'))?.version)===4 && (await db.get('SELECT completed_at_ms FROM portal_schema_migrations'))?.completed_at_ms===null)
    await rejected('迁移未填完成时间不能标成功', ()=>db.run("UPDATE portal_schema_migrations SET status='completed'"))
    if(kind==='sqlite') check('本地 user_version 未被提升为 v4', Number((await db.get('PRAGMA user_version'))?.user_version)===0)
    const departmentId=randomUUID(), memberId=randomUUID(), otherId=randomUUID(), accountId=randomUUID(), tokenId=randomUUID()
    const member = (id:string,name:string,dept:string|null=departmentId):Params => ({member_id:id,display_name:name,department_id:dept,created_at_ms:10,updated_at_ms:10})
    await insert('departments',{department_id:departmentId,name:'研发',created_at_ms:10,updated_at_ms:10})
    await insert('members',member(memberId,'张三'))
    await insert('members',member(otherId,'张三'))
    check('同名人员可存在且 UUID 不同', await scalar("SELECT COUNT(*) AS n FROM members WHERE display_name='张三'")===2)
    await rejected('UUID 格式约束执行',()=>insert('members',member('not-uuid','错误')))
    await rejected('人员部门外键拒绝悬空引用',()=>insert('members',member(randomUUID(),'不存在部门',randomUUID())))
    await rejected('部门名称唯一',()=>insert('departments',{department_id:randomUUID(),name:'研发',created_at_ms:10,updated_at_ms:10}))
    await rejected('状态 CHECK 真实执行',()=>db.run("UPDATE members SET status='root' WHERE member_id=$id",{$id:memberId}))
    for(const [label,unit] of [['中文','汉'],['emoji','😀']] as const) {
      const id=randomUUID()
      await insert('members',member(id,unit.repeat(32)))
      check(`${label}姓名 32 Unicode 字符容量一致`,(await db.get('SELECT display_name FROM members WHERE member_id=$id',{$id:id}))?.display_name===unit.repeat(32))
      await rejected(`${label}姓名超过 32 字符被拒绝`,()=>insert('members',member(randomUUID(),unit.repeat(33))))
      const dept=randomUUID()
      await insert('departments',{department_id:dept,name:unit.repeat(64),created_at_ms:10,updated_at_ms:10})
      check(`${label}部门 64 字符容量一致`,(await db.get('SELECT name FROM departments WHERE department_id=$id',{$id:dept}))?.name===unit.repeat(64))
      await rejected(`${label}部门超过 64 字符被拒绝`,()=>insert('departments',{department_id:randomUUID(),name:unit.repeat(65),created_at_ms:10,updated_at_ms:10}))
    }
    await insert('member_roles',{member_id:memberId,role_id:seedAdmin,granted_at_ms:10})
    await insert('member_roles',{member_id:otherId,role_id:seedMember,granted_at_ms:10})
    await rejected('人员角色关系不能重复',()=>insert('member_roles',{member_id:memberId,role_id:seedAdmin,granted_at_ms:10}))
    // 这里只验证已有 KDF 编码的存储形状；密码算法本身由应用测试覆盖。
    const passwordHash='$atr-scrypt$1$'+'ab'.repeat(16)+'$'+'cd'.repeat(32)
    await insert('login_accounts',{account_id:accountId,member_id:memberId,username_normalized:'qa.admin',password_hash:passwordHash,created_at_ms:10,updated_at_ms:10})
    await rejected('用户名全局唯一',()=>insert('login_accounts',{account_id:randomUUID(),member_id:otherId,username_normalized:'qa.admin',password_hash:passwordHash,created_at_ms:10,updated_at_ms:10}))
    await rejected('同一人员只能绑定一个账号',()=>insert('login_accounts',{account_id:randomUUID(),member_id:memberId,username_normalized:'qa.other',password_hash:passwordHash,created_at_ms:10,updated_at_ms:10}))
    await rejected('用户名必须预先小写归一',()=>db.run("UPDATE login_accounts SET username_normalized='QA.Admin' WHERE account_id=$id",{$id:accountId}))
    await rejected('密码字段拒绝明显明文',()=>db.run("UPDATE login_accounts SET password_hash='plain-password' WHERE account_id=$id",{$id:accountId}))
    const rawToken=randomBytes(32).toString('base64url'), rawSession=randomBytes(32).toString('base64url'), rawBinding=randomBytes(32).toString('base64url')
    const token = (id:string,owner=memberId,digest=sha(randomBytes(32))):Params => ({token_id:id,member_id:owner,token_hash:digest,token_prefix:'atr-test',label:'设计验证',created_at_ms:10})
    await insert('report_tokens',token(tokenId,memberId,sha(rawToken)))
    await rejected('Token 摘要唯一',()=>insert('report_tokens',token(randomUUID(),memberId,sha(rawToken))))
    await rejected('token_hash 只接受 64 位 hex 摘要形状',()=>insert('report_tokens',token(randomUUID(),memberId,rawToken)))
    await db.run("INSERT INTO report_token_scopes (token_id,permission_id) SELECT $id,permission_id FROM permissions WHERE code IN ('identity:read','usage:write')",{$id:tokenId})
    const effective = (id:string) => db.all<{code:string}>(`SELECT DISTINCT p.code FROM report_tokens t JOIN report_token_scopes s ON s.token_id=t.token_id JOIN permissions p ON p.permission_id=s.permission_id JOIN member_roles mr ON mr.member_id=t.member_id JOIN roles r ON r.role_id=mr.role_id AND r.status='active' JOIN role_permissions rp ON rp.role_id=mr.role_id AND rp.permission_id=s.permission_id JOIN members m ON m.member_id=t.member_id WHERE t.token_id=$id AND t.status='active' AND m.status='active' AND (t.expires_at_ms IS NULL OR t.expires_at_ms>20) ORDER BY p.code`,{$id:id})
    check('管理员新上报 Token 也只有两项 scope 交集',JSON.stringify((await effective(tokenId)).map(r=>r.code))===JSON.stringify(['identity:read','usage:write']))
    const adminPermission=(await db.get<{permission_id:string}>("SELECT permission_id FROM permissions WHERE code='members:manage'"))!.permission_id
    const memberToken=randomUUID()
    await insert('report_tokens',token(memberToken,otherId))
    await insert('report_token_scopes',{token_id:memberToken,permission_id:adminPermission})
    check('scope 不能越过人员角色提权',(await effective(memberToken)).length===0)
    const sessionId=randomUUID()
    await insert('auth_sessions',{session_id:sessionId,session_hash:sha(rawSession),account_id:accountId,password_version:1,created_at_ms:10,expires_at_ms:1000,last_seen_at_ms:10})
    const challengeId=randomUUID(), hmacKey=randomBytes(32), answer='1234'
    const answerHmac=createHmac('sha256',hmacKey).update(`${challengeId}:${answer}`).digest('hex')
    await insert('auth_challenges',{challenge_id:challengeId,challenge_hash:sha(randomBytes(32)),binding_hash:sha(rawBinding),answer_hmac:answerHmac,hmac_key_id:'qa-test-key',created_at_ms:10,expires_at_ms:100})
    check('挑战答案使用带随机密钥及挑战绑定的 HMAC',answerHmac!==sha(answer) && (await db.get('SELECT answer_hmac FROM auth_challenges'))?.answer_hmac===answerHmac)
    check('验证码消费 CAS 第一次成功', (await db.run('UPDATE auth_challenges SET consumed_at_ms=20,attempt_count=attempt_count+1 WHERE challenge_id=$id AND consumed_at_ms IS NULL AND expires_at_ms>20',{$id:challengeId})).changes===1)
    check('验证码消费 CAS 第二次失败', (await db.run('UPDATE auth_challenges SET consumed_at_ms=20,attempt_count=attempt_count+1 WHERE challenge_id=$id AND consumed_at_ms IS NULL AND expires_at_ms>20',{$id:challengeId})).changes===0)
    await rejected('过期时间不得早于创建时间',()=>insert('auth_sessions',{session_id:randomUUID(),session_hash:sha(randomBytes(32)),account_id:accountId,password_version:1,created_at_ms:10,expires_at_ms:9,last_seen_at_ms:10}))
    const subjectHash=sha('qa-account-subject')
    await insert('auth_rate_limit_buckets',{bucket_id:randomUUID(),scope:'login:account',subject_hash:subjectHash,window_started_at_ms:10,expires_at_ms:100})
    await rejected('同 scope/subject 只有一个限流桶',()=>insert('auth_rate_limit_buckets',{bucket_id:randomUUID(),scope:'login:account',subject_hash:subjectHash,window_started_at_ms:10,expires_at_ms:100}))
    const event=(id:string):Params=>({event_id:id,session_id:'qa-session',seq:1,ts:10,provider:'provider',model:'model',user_id:'旧姓名',user_name:'旧姓名',dept:'旧部门',input_tokens:11,output_tokens:22,cache_read_tokens:333,cache_write_tokens:44,reasoning_tokens:7,member_id:memberId,department_id:departmentId,report_token_id:tokenId,received_at_ms:20})
    await insert('usage_event',event('qa-session:1'))
    const before=await db.get('SELECT * FROM usage_event WHERE event_id=$id',{$id:'qa-session:1'})
    await rejected('重复 event_id 主键拒绝第二次写入',()=>insert('usage_event',{...event('qa-session:1'),input_tokens:999,member_id:otherId,report_token_id:memberToken}))
    const count=await scalar('SELECT COUNT(*) AS n FROM usage_event')
    check('去重后只有首条事件且四项 token 独立保留',count===1 && JSON.stringify([before?.input_tokens,before?.output_tokens,before?.cache_read_tokens,before?.cache_write_tokens].map(Number))==='[11,22,333,44]')
    for(const id of ['Case:1','case:1','case:1 ']) await insert('usage_event',event(id))
    check('事件键区分大小写与尾空格，跨库一致',await scalar('SELECT COUNT(*) AS n FROM usage_event')===4)
    await insert('usage_event',event('x'.repeat(255)))
    await rejected('事件键超过 255 字符被拒绝',()=>insert('usage_event',event('x'.repeat(256))))
    await insert('usage_event',{...event('metadata:1'),provider:'',model:'',turn:-1,step:-9007199254740991})
    check('兼容现有协议空 provider/model 与负 turn/step',(await db.get('SELECT provider,model,turn,step FROM usage_event WHERE event_id=$id',{$id:'metadata:1'}))?.provider==='' && Number((await db.get('SELECT step FROM usage_event WHERE event_id=$id',{$id:'metadata:1'}))?.step)===-9007199254740991)
    await rejected('事件 Token 与人员归属必须一致',()=>insert('usage_event',{...event('bad-owner:1'),member_id:otherId}))
    await rejected('token 数超过安全整数被拒绝',()=>insert('usage_event',{...event('unsafe:1'),input_tokens:9007199254740992}))
    await rejected('负 token 被拒绝',()=>insert('usage_event',{...event('negative:1'),cache_read_tokens:-1}))
    await db.run('UPDATE members SET display_name=$name,version=version+1,updated_at_ms=20 WHERE member_id=$id',{$name:'新姓名',$id:memberId})
    check('改名没有重写事件归属或快照',JSON.stringify(await db.get('SELECT * FROM usage_event WHERE event_id=$id',{$id:'qa-session:1'}))===JSON.stringify(before))
    const newTokenId=randomUUID()
    await db.transaction(async tx=>{
      assert.equal((await tx.run("UPDATE report_tokens SET status='revoked',revoked_at_ms=30,version=version+1 WHERE token_id=$id AND version=1",{$id:tokenId})).changes,1)
      await insert('report_tokens',token(newTokenId),tx)
    })
    check('Token 旧版本 CAS 不会覆盖已轮换状态',(await db.run('UPDATE report_tokens SET label=$label,version=version+1 WHERE token_id=$id AND version=1',{$label:'不该生效',$id:tokenId})).changes===0)
    check('轮换不修改历史接收 Token/人员及四项用量',JSON.stringify(await db.get('SELECT * FROM usage_event WHERE event_id=$id',{$id:'qa-session:1'}))===JSON.stringify(before))
    check('上报 Token 轮换不影响独立后台 session',await scalar('SELECT COUNT(*) AS n FROM auth_sessions s JOIN login_accounts a ON a.account_id=s.account_id WHERE s.session_hash=$hash AND s.password_version=a.password_version AND a.enabled=1 AND s.revoked_at_ms IS NULL',{$hash:sha(rawSession)})===1)
    await db.run('UPDATE login_accounts SET password_version=password_version+1,version=version+1,updated_at_ms=30 WHERE account_id=$id',{$id:accountId})
    check('密码版本变更使旧 session 校验失败',await scalar('SELECT COUNT(*) AS n FROM auth_sessions s JOIN login_accounts a ON a.account_id=s.account_id WHERE s.session_hash=$hash AND s.password_version=a.password_version',{$hash:sha(rawSession)})===0)
    const rollbackId=randomUUID(), rollbackAudit=randomUUID()
    try { await db.transaction(async tx=>{
      await insert('members',member(rollbackId,'应回滚'),tx)
      await insert('admin_audit_log',{audit_id:rollbackAudit,actor_member_id:memberId,action:'member.create',target_type:'member',target_id:rollbackId,result:'success',request_id:randomUUID(),metadata_json:'{}',occurred_at_ms:30},tx)
      throw new Error('rollback-probe')
    }) } catch(error) { assert.equal((error as Error).message,'rollback-probe') }
    check('业务与成功审计同事务回滚',await scalar('SELECT COUNT(*) AS n FROM members WHERE member_id=$id',{$id:rollbackId})===0 && await scalar('SELECT COUNT(*) AS n FROM admin_audit_log WHERE audit_id=$id',{$id:rollbackAudit})===0)
    await rejected('不能删除被历史事件引用的人员',()=>db.run('DELETE FROM members WHERE member_id=$id',{$id:memberId}))
    await rejected('不能删除被历史引用的 Token',()=>db.run('DELETE FROM report_tokens WHERE token_id=$id',{$id:tokenId}))
    await rejected('不能删除被引用部门',()=>db.run('DELETE FROM departments WHERE department_id=$id',{$id:departmentId}))
    const mappingId=randomUUID()
    await insert('legacy_attribution_map',{mapping_id:mappingId,legacy_user_id:'张三',status:'pending',source_import_ref:'qa-legacy-file',created_at_ms:10})
    await insert('usage_event',{...event('legacy:1'),user_id:'张三',user_name:'张三',member_id:null,department_id:null,report_token_id:null,received_at_ms:null})
    check('存在同名人员也不会自动归并 pending 历史',(await db.get('SELECT member_id FROM legacy_attribution_map WHERE mapping_id=$id',{$id:mappingId}))?.member_id===null && (await db.get('SELECT member_id FROM usage_event WHERE event_id=$id',{$id:'legacy:1'}))?.member_id===null)
    await rejected('映射不能无依据标为 mapped',()=>db.run("UPDATE legacy_attribution_map SET status='mapped' WHERE mapping_id=$id",{$id:mappingId}))
    await rejected('身份锁不能出现第二个单例',()=>insert('portal_identity_state',{state_id:randomUUID(),singleton_key:1,updated_at_ms:0}))
    const serialized=JSON.stringify(await Promise.all(tableNames.map(t=>db.all(`SELECT * FROM ${t}`))))
    check('数据库行不含原 Token/session/binding/HMAC 密钥',![rawToken,rawSession,rawBinding,hmacKey.toString('hex')].some(secret=>serialized.includes(secret)))
    // ★ 这是设计事务的行为探针，不代表应用已经实现了最后管理员护栏。
    await insert('member_roles',{member_id:otherId,role_id:seedAdmin,granted_at_ms:30})
    await insert('login_accounts',{account_id:randomUUID(),member_id:otherId,username_normalized:'qa.second',password_hash:passwordHash,created_at_ms:10,updated_at_ms:10})
    const other=await second()
    const demote=(conn:Db,id:string)=>conn.transaction(async tx=>{
      await tx.run('UPDATE portal_identity_state SET revision=revision+1 WHERE singleton_key=1')
      const n=Number((await tx.get<{n:unknown}>("SELECT COUNT(*) AS n FROM member_roles mr JOIN members m ON m.member_id=mr.member_id JOIN login_accounts a ON a.member_id=m.member_id WHERE mr.role_id=$role AND m.status='active' AND a.enabled=1",{$role:seedAdmin}))?.n)
      if(n<=1)return false
      await Bun.sleep(10)
      await tx.run('DELETE FROM member_roles WHERE member_id=$member AND role_id=$role',{$member:id,$role:seedAdmin})
      return true
    })
    try {
      const outcomes=await Promise.all([demote(db,memberId),demote(other,otherId)])
      check('两连接并发降级由数据库锁保留一个管理员',outcomes.filter(Boolean).length===1 && await scalar('SELECT COUNT(*) AS n FROM member_roles WHERE role_id=$role',{$role:seedAdmin})===1)
    } finally { await other.close() }
    // 校验 catalog 后才标记这个隔离原型的建表记录完成；不是生产迁移完成。
    await db.run("UPDATE portal_schema_migrations SET last_completed_step=17,checkpoint_json=$json,status='completed',completed_at_ms=40 WHERE migration_id=$id",{$json:JSON.stringify({verified_tables:tableNames,scope:'isolated-design-prototype'}),$id:migrationId})
    check('隔离原型记录可完成且保留真实 DDL checksum',(await db.get('SELECT checksum,status FROM portal_schema_migrations WHERE migration_id=$id',{$id:migrationId}))?.checksum===sha(ddl))
  } catch(error) {
    throw new Error(`${kind} / ${active}: ${safeError(error)}`)
  }
}

console.log('Portal v4 真实数据库设计验证；不是应用 E2E，不修改业务库。')
let controller: MysqlBackend|undefined, mysql: MysqlBackend|undefined, created=false
let failure: string|undefined
const sqlitePath=join(artifactDir,'portal-v4.sqlite')
const local=sqlite(sqlitePath)
try {
  versions.sqlite=String((await local.get('SELECT sqlite_version() AS version'))?.version)
  await verify(local,'sqlite',async()=>sqlite(sqlitePath))
  await local.close()
  controller=await openMysqlBackend(mysqlUrl.href)
  const server=await controller.get<{version:string}>('SELECT VERSION() AS version')
  versions.mysql=server?.version??'unknown'
  assert.match(server?.version??'',/^8\.4\./,'原型验证目标为 MySQL 8.4')
  await controller.exec(`CREATE DATABASE \`${mysqlSchema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`)
  created=true
  mysqlUrl.pathname=`/${mysqlSchema}`
  mysql=await openMysqlBackend(mysqlUrl.href)
  await verify(mysql,'mysql',async()=>openMysqlBackend(mysqlUrl.href))
} catch(error) {
  failure=error instanceof Error && /^(sqlite|mysql) \/ /.test(error.message)?error.message:safeError(error)
  console.error(`FAIL ${failure}`)
  process.exitCode=1
} finally {
  const cleanup={sqliteClosed:false,mysqlClosed:false,mysqlSchemaCreated:created,mysqlSchemaDropped:false,controllerClosed:false,errors:[] as string[]}
  try {await local.close();cleanup.sqliteClosed=true} catch(error) {cleanup.errors.push(`sqlite close: ${safeError(error)}`)}
  try {if(mysql) {await mysql.close();cleanup.mysqlClosed=true}} catch(error) {cleanup.errors.push(`mysql close: ${safeError(error)}`)}
  if(created && controller) {
    // 删除目标是本脚本成功 CREATE 的随机 schema；绝不使用输入 URL 的库名。
    assert.match(mysqlSchema,/^atr_v4_verify_[0-9]+_[a-f0-9]{10}$/)
    try {await controller.exec(`DROP DATABASE \`${mysqlSchema}\``);cleanup.mysqlSchemaDropped=true} catch(error) {cleanup.errors.push(`schema cleanup: ${safeError(error)}`)}
  }
  try {if(controller) {await controller.close();cleanup.controllerClosed=true}} catch(error) {cleanup.errors.push(`controller close: ${safeError(error)}`)}
  if(cleanup.errors.length) {process.exitCode=1;failure??='验证清理失败，见 cleanup.errors'}
  const report={scope:'isolated-database-design-not-application-e2e',at:new Date().toISOString(),versions,mysqlSchema,sqlitePath,ddlHashes,results,cleanup,failure:failure??null,total:results.reduce((n,r)=>n+r.checks.length,0)}
  mkdirSync(artifactDir,{recursive:true})
  writeFileSync(join(artifactDir,'report.json'),JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({passed:report.total,backends:results.map(r=>({backend:r.backend,checks:r.checks.length})),failure:report.failure,evidence:join(artifactDir,'report.json')}))
}
