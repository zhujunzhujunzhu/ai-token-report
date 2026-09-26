/** 固定人员归属：同一批真实 SQLite/MySQL 数据逐接口对账，避免姓名快照合并人员。 */
import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openPortalStore, type PortalTarget } from '../src/db/portal-db.js'
import { openPortalStats, IdentityViewRequiredError } from '../src/db/portal.js'
import { openMysqlBackend, closeAllMysqlBackends } from '../src/db/mysql.js'
import type { QueryFilter } from '../src/db/query.js'

const folder = mkdtempSync(join(tmpdir(),'atr-stable-identity-'))
afterAll(async () => { await closeAllMysqlBackends(); rmSync(folder,{recursive:true,force:true}) })
const memberA = '10000000-0000-4000-8000-000000000001'
const memberB = '10000000-0000-4000-8000-000000000002'
const dept = '10000000-0000-4000-8000-000000000003'
const sqlite: PortalTarget = {sqlitePath:join(folder,'portal.sqlite')}
const fixture = [
  {id:'a-old',member:memberA,user:'同名',received:1000,n:1},
  {id:'a-new',member:memberA,user:'更名',received:1000,n:2},
  {id:'b-same',member:memberB,user:'同名',received:1000,n:4},
  {id:'legacy-pending',member:null,user:'历史待认',received:null,n:8},
  {id:'legacy-mapped',member:memberA,user:'历史已认',received:null,n:16},
  {id:'unknown',member:null,user:null,received:null,n:32},
  {id:'new-same-key',member:memberB,user:'历史已认',received:1000,n:64},
]
async function seed(target: PortalTarget): Promise<void> {
  const store=await openPortalStore(target)
  try { await store.transaction(async tx => {
    await tx.run("INSERT INTO departments (department_id,name,created_at_ms,updated_at_ms) VALUES ($id,'部门',1,1)",{$id:dept})
    for (const [id,name] of [[memberA,'更名'],[memberB,'同名']]) await tx.run('INSERT INTO members (member_id,display_name,department_id,created_at_ms,updated_at_ms) VALUES ($id,$name,$dept,1,1)',{$id:id,$name:name,$dept:dept})
    for (const item of fixture) await tx.run('INSERT INTO usage_event (event_id,session_id,seq,ts,provider,model,cwd,user_id,user_name,dept,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,member_id,department_id,received_at_ms) VALUES ($id,$session,1,$ts,$provider,$model,\'/workspace\',$user,$user,\'旧部门\',$n,$output,$read,$write,0,$member,$dept,$received)',{$id:item.id,$session:`session:${item.id}`,$ts:1700000000000+item.n,$provider:item.n===64?'p_%!\\':'p',$model:item.n===64?'m_%!\\':'m',$user:item.user,$n:item.n,$output:item.n*2,$read:item.n*3,$write:item.n*4,$member:item.member,$dept:item.member?dept:null,$received:item.received})
    await tx.run("INSERT INTO legacy_attribution_map (mapping_id,legacy_user_id,member_id,status,source_import_ref,decision_reason,created_at_ms,decided_at_ms) VALUES ($id,'历史已认',$member,'mapped','test','人工确认',1,2)",{$id:'10000000-0000-4000-8000-000000000004',$member:memberA})
    await tx.run("INSERT INTO legacy_attribution_map (mapping_id,legacy_user_id,source_import_ref,created_at_ms) VALUES ($id,'历史待认','test',1)",{$id:'10000000-0000-4000-8000-000000000005'})
  }) } finally {await store.close()}
}
async function snapshot(target: PortalTarget, filter: QueryFilter = {}) {
  const session = await openPortalStats(target,{identityView:'member',...filter})
  try { return {totals:await session.totals(),sessions:await session.sessions(),users:await session.distinctUsers(),unknown:await session.unattributedCalls(),bounds:await session.timeBounds(),groups:await session.groups('user'),provider:await session.groups('provider'),records:await session.records(100,0),series:await session.series('hour')} }
  finally {await session.close()}
}
const filters: QueryFilter[] = [
  {},{memberIds:[memberA]},{memberIds:[memberB]},{legacyUserIds:['历史已认']},{legacyUserIds:['历史待认']},{unattributedOnly:true},
  {memberIds:[memberA],legacyUserIds:['历史待认'],unattributedOnly:true},
  {memberIds:[memberA],legacyUserIds:['历史已认']},
  {memberIds:[memberA,memberB]},{providers:['p'],memberIds:[memberA]},
  ...['_','%','!','\\'].map(value=>({providers:[value]})),
  ...['_','%','!','\\'].map(value=>({models:[value]})),
]
let seeded=false
async function sqliteSeed(): Promise<void> {if(!seeded){await seed(sqlite);seeded=true}}
test('SQLite：同名人员分组、改名历史快照、pending/confirmed/unknown与联合筛选',async()=>{
  await sqliteSeed()
  const store=await openPortalStore(sqlite)
  await store.run("UPDATE members SET display_name='同名' WHERE member_id=$id",{$id:memberA})
  expect((await snapshot(sqlite)).groups.filter(row=>row.label==='同名').map(row=>row.key).sort()).toEqual([memberA,memberB].sort())
  await store.run("UPDATE members SET display_name='更名' WHERE member_id=$id",{$id:memberA})
  await store.close()
  const all=await snapshot(sqlite)
  expect(all.records.total).toBe(7)
  expect(all.groups.length).toBe(4)
  expect(all.users).toBe(3)
  expect(all.unknown).toBe(1)
  const a=all.groups.find(row=>row.key===memberA)!
  expect(a.counts.calls).toBe(3);expect(a.label).toBe('更名');expect(a.memberId).toBe(memberA)
  const b=all.groups.find(row=>row.key===memberB)!
  expect(b.counts.calls).toBe(2);expect(b.label).toBe('同名')
  expect(all.records.rows.find(row=>row.eventId==='a-old')?.userNameSnapshot).toBe('同名')
  expect(all.records.rows.find(row=>row.eventId==='legacy-mapped')?.attributionStatus).toBe('member')
  expect(all.groups.find(row=>row.attributionStatus==='legacy')?.key).toBe(`legacy:${Buffer.from('历史待认').toString('base64url')}`)
  const legacy=await snapshot(sqlite,{legacyUserIds:['历史已认']})
  expect(legacy.records.rows.map(row=>row.eventId)).toEqual(['legacy-mapped'])
  const union=await snapshot(sqlite,{memberIds:[memberA],legacyUserIds:['历史待认'],unattributedOnly:true})
  expect(union.records.total).toBe(5)
  expect(union.users).toBe(2)
  expect((await snapshot(sqlite,{memberIds:[memberA],legacyUserIds:['历史已认']})).records.total).toBe(3)
  for (const value of ['_','%','!','\\']) {
    expect((await snapshot(sqlite,{providers:[value]})).records.rows.map(row=>row.eventId)).toEqual(['new-same-key'])
    expect((await snapshot(sqlite,{models:[value]})).records.rows.map(row=>row.eventId)).toEqual(['new-same-key'])
  }
  await expect(openPortalStats(sqlite)).rejects.toBeInstanceOf(IdentityViewRequiredError)
  await expect(openPortalStats(sqlite,{userIds:['同名']})).rejects.toBeInstanceOf(IdentityViewRequiredError)
  const legacySafe=await openPortalStats(sqlite,{userIds:['历史待认']});await legacySafe.close()
})
describe.skipIf(!process.env.ATR_V4_TEST_MYSQL_URL)('真实MySQL固定归属对账',()=>{
  test('GROUP BY/NULL/筛选/全部统计接口与SQLite JSON逐位一致',async()=>{
    await sqliteSeed()
    const adminUrl=process.env.ATR_V4_TEST_MYSQL_URL!,admin=await openMysqlBackend(adminUrl)
    const schema=`atr_stable_verify_${Date.now()}_${randomUUID().slice(0,8)}`
    if(!/^atr_stable_verify_\d+_[a-f0-9]{8}$/.test(schema))throw new Error('隔离schema名称不合法')
    const url=new URL(adminUrl);url.pathname=`/${schema}`
    const mysql={sqlitePath:'unused',mysqlUrl:url.href}
    let created=false
    try{
      await admin.exec(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);created=true
      await seed(mysql)
      for(const filter of filters) expect(await snapshot(mysql,filter)).toEqual(await snapshot(sqlite,filter))
      await expect(openPortalStats(mysql)).rejects.toBeInstanceOf(IdentityViewRequiredError)
      await expect(openPortalStats(mysql,{userIds:['同名']})).rejects.toBeInstanceOf(IdentityViewRequiredError)
    }finally{await closeAllMysqlBackends();if(created)await admin.exec(`DROP DATABASE ${schema}`);await admin.close()}
  },30000)
})
