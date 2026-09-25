import { cleanChildEnv, resolveNodeBin } from '../../core/verify/lib/runtime.js'
/** 真 Node 执行插件产物，验证 SQL/直扫一致、增量追加与降级，并打印真实日志热态耗时。 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const home = mkdtempSync(join(tmpdir(), 'atr-plugin-sql-'))
const lib = pathToFileURL(resolve(import.meta.dir, '../lib/index.js')).href
// 用子进程自己的 zstd 和 SQLite，避免 Bun 冒充 Node 导致验证失真。
const script = `
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { queryUsage, resolveConfig } from ${JSON.stringify(lib)};
assert.equal(typeof globalThis.Bun, 'undefined');
const home = ${JSON.stringify(home)};
const dir = join(home, 'sessions', 'project', 'session-1');
mkdirSync(dir, {recursive: true});
const file = join(dir, 'session.v3.jsonl.zstd');
const time = Date.now();
const event = seq => ({type:'assistant/message', seq, time, data:{turn:1,step:seq,
message:{source:{kind:'model',provider:'test',model:'model'}},
usage:{inputTokens:100,outputTokens:20,cacheReadTokens:300,cacheWriteTokens:40,reasoningTokens:5,totalTokens:460}}});
const frame = rows => zstdCompressSync(Buffer.from(rows.map(JSON.stringify).join('\\n')+'\\n'));
writeFileSync(file, frame([{type:'session',version:3,id:'session-1',createdAt:time,cwd:'project'},event(1)]));
const context = {config:resolveConfig({dshHome:home}),sessionsRoot:join(home,'sessions'),dbPath:join(home,'usage.sqlite')};
const query = {period:'today',by:['provider-model','project','session','day','hour'],series:'hour'};
const sql = await queryUsage(context, query);
assert.equal(sql.source,'local-db');
assert.equal(sql.totals.total,460);
const scan = await queryUsage({...context,config:{...context.config,localDb:false}},query);
for(const key of ['totals','metrics','groups','series','sessions']) assert.deepEqual(sql[key],scan[key]);
const hot = await queryUsage(context,query);
assert.deepEqual(hot.totals,sql.totals);
appendFileSync(file,frame([event(2)]));
const [added, concurrent] = await Promise.all([queryUsage(context,query),queryUsage(context,{...query,period:'month'})]);
assert.equal(concurrent.source,'local-db');
assert.equal(added.totals.total,920);
const blocked = join(home,'blocked'); writeFileSync(blocked,'not a directory');
const fallback = await queryUsage({...context,dbPath:join(blocked,'usage.sqlite')},query);
assert.equal(fallback.source,'scan'); assert.ok(fallback.degradedReason);
assert.deepEqual(fallback.totals,added.totals);
console.log(JSON.stringify({runtime:process.version,sql:sql.source,coldMs:sql.elapsedMs,hotMs:hot.elapsedMs,incrementalMs:added.elapsedMs,parity:true,fallback:true}));
`
try {
  const result = spawnSync(resolveNodeBin() ?? 'node', ['--input-type=module', '-e', script], { encoding: 'utf8', env: cleanChildEnv(), timeout: 60_000 })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  assert.equal(result.status, 0, 'Node 产物 SQL 验证失败')
} finally {
  rmSync(home, { recursive: true, force: true })
}
