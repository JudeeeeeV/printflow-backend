// Disposable PostgreSQL tests. Does not read application configuration or contact Supabase.
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
async function main() {
 const db = new PGlite();
 const shop=randomUUID(), student=randomUUID(), other=randomUUID();
 const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
 const rpc=(name,args)=>scalar('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+')',args);
 try {
 await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create type public.order_state as enum ('DRAFT','OPEN_INQUIRY','PROOF_APPROVED','AWAITING_PAYMENT',
        'AWAITING_PAYMENT_VERIFICATION','ESCALATED_DISPUTE','IN_PRODUCTION','PRINTED','EXPIRED');
      create table public.users(id uuid primary key, role text);
      create table public.shops(id uuid primary key, verification_status text);
      create table public.admins(id uuid primary key);
      create table public.orders(id uuid primary key default gen_random_uuid(), client_id uuid, shop_id uuid,
        state public.order_state default 'DRAFT', total numeric(12,2) default 15, created_at timestamptz default now(),
        expires_at timestamptz, shop_rejection_reason text, dispute_reason text, page_count integer default 2,
        copies integer default 1);
      create table public.assets(id uuid primary key default gen_random_uuid(), order_id uuid references public.orders(id),
        file_url text, file_type text, dpi integer);
      create table public.payment_receipts(id uuid primary key default gen_random_uuid(), order_id uuid references public.orders(id),
        uploaded_by uuid, receipt_url text, reference_number text, verified boolean default false, created_at timestamptz default now());
      create table public.notifications(id uuid primary key default gen_random_uuid(), order_id uuid, clerk_id uuid, is_read boolean default false);
      create table public.print_jobs(id bigint generated always as identity primary key, order_id uuid, shop_id uuid,
        status text, created_at timestamptz default now(), updated_at timestamptz default now());
      create unique index print_jobs_one_active_per_order_idx on public.print_jobs(order_id) where status <> 'FAILED';
    `);
 await db.exec("alter table public.users add column first_name text, add column last_name text; alter table public.orders add column paper_size text default 'A4', add column print_color_mode text default 'BLACK_AND_WHITE', add column orientation text default 'PORTRAIT', add column order_name text; alter table public.assets add column original_filename text;");
 for(const name of readdirSync('supabase/migrations').filter(name=>/^202611.*\.sql$/.test(name)).sort()) await db.exec(readFileSync('supabase/migrations/'+name,'utf8'));
 await db.query("insert into public.users(id,role,first_name,last_name) values($1,'STUDENT','Ana','Cruz'),($2,'CLERK','Shop','Owner'),($3,'CLERK','Other','Shop')",[student,shop,other]);
 await db.query("insert into public.shops values($1,'VERIFIED'),($2,'VERIFIED')",[shop,other]);
 const create=async(overrides={})=>{
   const id=randomUUID();
   await db.query("insert into public.orders(id,client_id,shop_id,state,total,payment_method,payment_status,acceptance_status,order_name,created_at) values($1,$2,$3,$4,15,'CASH_ON_PICKUP',$5,'ACCEPTED',$6,$7)",[id,student,overrides.shop||shop,'OPEN_INQUIRY',overrides.payment||'DUE_AT_PICKUP',overrides.title||'Assignment',overrides.date||'2026-10-09T16:00:00Z']);
   await db.query("insert into public.assets(order_id,file_url,file_type,dpi,original_filename) values($1,$2,'PDF',300,$3)",[id,'private/'+id+'.pdf',overrides.filename||'R\u00e9sum\u00e9 \u5b66\u751f.v2.docx']);
   await db.query('update public.orders set state=$2,payment_status=$3 where id=$1',[id,overrides.state||'IN_PRODUCTION',overrides.payment||'DUE_AT_PICKUP']);
   if(overrides.noFile) await db.query('delete from public.assets where order_id=$1',[id]);
   return id;
 };
 // Set-returning RPCs use rows in SQL, unlike the scalar helper.
 const items=async(ids)=>(await db.query('select r as item from public.shop_queue_rows($1,$2) r',[shop,ids])).rows.map(row=>row.item);
 const query=q=>rpc('shop_queue_query',[shop,JSON.stringify(q)]);
 const a=await create({title:'Alpha'}), b=await create({title:'Beta'});
 const foreignOrder=await create({shop:other,title:'Secret cross-shop'});
 assert.equal(await rpc('shop_queue_detail',[shop,foreignOrder]),null);
 const detail=await rpc('shop_queue_detail',[shop,a]);
 assert.equal(detail.id,a);assert.equal(detail.order_name,'Alpha');assert.equal(detail.assets.length,1);
 assert.ok(Array.isArray(detail.payment_receipts));assert.ok(Array.isArray(detail.order_decisions));
 for(let i=0;i<28;i++) await create({title:'Assignment '+i});
 let q=await query({section:'ready',page:1,pageSize:3});
 assert.equal(q.data.length,3);assert.equal(q.meta.totalItems,30);assert.equal(q.counts.ready,30);
 q=await query({section:'ready',search:'\u5b66\u751f.v2',pageSize:25}); assert.equal(q.meta.totalItems,30);
 q=await query({section:'ready',search:b,pageSize:3});assert.equal(q.data[0].id,b);
 q=await query({section:'ready',search:'ana cruz',pageSize:3});assert.equal(q.meta.totalItems,30);
 assert.equal((await query({section:'ready',search:'Secret'})).meta.totalItems,0);
 assert.equal((await items([a])).length,1);
 assert.equal((await query({section:'ready',onlyIds:[a,b]})).meta.totalItems,2);
 await create({date:'2026-10-09T15:59:59Z',title:'Before Manila day'});
 await create({date:'2026-10-10T16:00:00Z',title:'After Manila day'});
 q=await query({section:'ready',dateFrom:'2026-10-10',dateTo:'2026-10-10',pageSize:3});assert.equal(q.meta.totalItems,30);
 q=await query({section:'ready',page:999,pageSize:25});assert.equal(q.meta.currentPage,2);assert.equal(q.data.length,7);
 const refund=await create({state:'CANCELLED',payment:'REFUND_DUE'});
 const closed=await create({state:'COMPLETED',payment:'COLLECTED'});
 const missing=await create({noFile:true});
 assert.equal((await items([refund]))[0].section,'new');assert.equal((await items([closed]))[0].section,'history');assert.equal((await items([missing]))[0].selectable,false);
 // The fingerprint changes when settings/payment change.
 const before=(await items([a]))[0].fingerprint;
 await db.query('update public.orders set copies=2 where id=$1',[a]); assert.notEqual((await items([a]))[0].fingerprint,before);
 const review=async(ids,mode='MANUAL')=>{
   const found=await items(ids), map=new Map(found.map(row=>[row.id,row]));
   const payload=ids.map(id=>{const row=map.get(id);return {orderId:id,fingerprint:row.fingerprint,sourceStored:row.source_path,sourcePath:row.source_path,settings:{paperSize:row.paper_size,colorMode:row.print_color_mode,orientation:row.orientation,copies:row.copies},printable:{path:row.source_path,sha256:'a'.repeat(64),size:100}}});
   const token=randomUUID(),request=randomUUID();
   await db.query('insert into public.print_batch_reviews(token,shop_id,actor_id,mode,items) values($1,$2,$2,$3,$4)',[token,shop,mode,JSON.stringify(payload)]);
   await rpc('print_begin_batch_request',[request,shop,'a'.repeat(64),shop]);
   return {token,request,payload};
 };
 const rejected=await review([b,a]);
 await db.query("update public.orders set state='CANCELLED',payment_status='REFUND_DUE' where id=$1",[a]);
 let result=await rpc('print_claim_reviewed_batch',[rejected.token,shop,shop,rejected.request]);
 assert.equal(result.ok,false);assert.equal(result.code,'BATCH_CHANGED');assert.equal(Number(await scalar('select count(*) from public.print_jobs where batch_request_id=$1',[rejected.request])),0);
 await db.query("update public.orders set state='IN_PRODUCTION',payment_status='DUE_AT_PICKUP' where id=$1",[a]);
 const valid=await review([b,a]);result=await rpc('print_claim_reviewed_batch',[valid.token,shop,shop,valid.request]);
 assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.attempts.map(row=>row.order_id),[b,a]);
 assert.equal((await items([b]))[0].section,'pickup');assert.equal((await items([b]))[0].selectable,false);
 assert.equal((await rpc('print_claim_reviewed_batch',[valid.token,shop,shop,valid.request])).code,'REVIEW_ALREADY_USED');
 // Accepted attempts cannot be rewritten as failed after a lost response.
 assert.equal(await rpc('print_fail_reviewed_batch',[valid.request,shop,JSON.stringify({body:{message:'lost'}})]),false);
 await db.query("update public.print_batch_requests set created_at=now()-interval '16 minutes' where request_id=$1",[valid.request]);
 assert.equal(await rpc('print_expire_unclaimed_batch',[valid.request,shop]),false); // Accepted attempts survive expiration.
 const c=await create(),d=await create(); const mixed=await review([c,d]);
 mixed.payload[1].settings.paperSize='LONG';await db.query('update public.print_batch_reviews set items=$2 where token=$1',[mixed.token,JSON.stringify(mixed.payload)]);
 assert.equal((await rpc('print_claim_reviewed_batch',[mixed.token,shop,shop,mixed.request])).code,'INVALID_BATCH');
 const foreign=await review([c]); assert.equal((await rpc('print_claim_reviewed_batch',[foreign.token,other,other,foreign.request])).code,'REVIEW_REQUIRED');
 const expired=await review([c]);await db.query("update public.print_batch_reviews set expires_at=now()-interval '1 second' where token=$1",[expired.token]);assert.equal((await rpc('print_claim_reviewed_batch',[expired.token,shop,shop,expired.request])).code,'REVIEW_EXPIRED');
 const abandoned=await review([c]);
 assert.equal(await rpc('print_expire_unclaimed_batch',[abandoned.request,shop]),false); // Active request remains pending.
 await db.query("update public.print_batch_requests set created_at=now()-interval '16 minutes' where request_id=$1",[abandoned.request]);
 assert.equal(await rpc('print_expire_unclaimed_batch',[abandoned.request,other]),false);
 assert.equal(await rpc('print_expire_unclaimed_batch',[abandoned.request,shop]),true);
 assert.equal((await rpc('print_claim_reviewed_batch',[abandoned.token,shop,shop,abandoned.request])).code,'REQUEST_NOT_PENDING');
 assert.equal(Number(await scalar('select count(*) from public.print_jobs where batch_request_id=$1',[abandoned.request])),0);
 // Force the second inner claim to fail after the first one has inserted rows.
 const rollback=await review([c,d]);rollback.payload[1].sourcePath=null;
 await db.query('update public.print_batch_reviews set items=$2 where token=$1',[rollback.token,JSON.stringify(rollback.payload)]);
 result=await rpc('print_claim_reviewed_batch',[rollback.token,shop,shop,rollback.request]);assert.equal(result.ok,false);
 assert.equal(Number(await scalar('select count(*) from public.print_jobs where batch_request_id=$1',[rollback.request])),0);
 assert.equal(Number(await scalar('select count(*) from public.print_job_events where order_id=any($1)',[[c,d]])),0);
 const competing=await create();const first=await review([competing]),second=await review([competing]);
 const concurrent=await Promise.all([first,second].map(value=>rpc('print_claim_reviewed_batch',[value.token,shop,shop,value.request])));
 assert.equal(concurrent.filter(value=>value.ok).length,1);assert.equal(Number(await scalar('select count(*) from public.print_jobs where order_id=$1',[competing])),1);
 const base={state:'IN_PRODUCTION',payment_method:'CASH_ON_PICKUP',payment_status:'DUE_AT_PICKUP',acceptance_status:'ACCEPTED',paper_size:'A4',print_color_mode:'BLACK_AND_WHITE',orientation:'PORTRAIT'};
 const incomplete=await rpc('shop_queue_classify',[JSON.stringify({...base,orientation:null}),null,true]);
 assert.equal(incomplete.selectable,false);assert.equal(incomplete.section,'new');assert.ok(incomplete.blocking_reasons.includes('Complete, valid print settings are required.'));
 const handedOver=await rpc('shop_queue_classify',[JSON.stringify({...base,handed_over_at:new Date().toISOString()}),null,true]);
 assert.equal(handedOver.selectable,false);
 for(const [status,section,action] of [['QUEUED','ready',null],['SUBMITTING','ready',null],['FAILED_PRE_SUBMISSION','ready','retry'],['OUTCOME_UNKNOWN','ready','resolve'],['SUBMITTED','pickup','confirm'],['MANUAL_STARTED','pickup','confirm']]) {
   const classified=await rpc('shop_queue_classify',[JSON.stringify(base),JSON.stringify({status,resolved_at:null,updated_at:new Date().toISOString()}),true]);
   assert.equal(classified.section,section);assert.equal(classified.selectable,false);if(action)assert.ok(classified.available_actions.includes(action));
 }
 const flagged=await rpc('shop_queue_classify',[JSON.stringify({...base,state:'READY_FOR_PICKUP',is_unclaimed:true,output_confirmed_at:new Date().toISOString()}),null,true]);assert.equal(flagged.section,'pickup');
 const disputed=await rpc('shop_queue_classify',[JSON.stringify({...base,state:'CANCELLED',payment_status:'DISPUTED'}),null,true]);assert.equal(disputed.section,'new');
 const oldClosed=await create({state:'COMPLETED',payment:'COLLECTED'}),recentClosed=await create({state:'COMPLETED',payment:'COLLECTED'});
 await db.query('update public.orders set handed_over_at=$2 where id=$1',[oldClosed,'2026-11-08T10:00:00Z']);
 await db.query('update public.orders set handed_over_at=$2 where id=$1',[recentClosed,'2026-11-09T10:00:00Z']);
 q=await query({section:'history',pageSize:20});assert.equal(q.data[0].id,recentClosed);assert.equal(q.data[1].id,oldClosed);
 const titled=await create({title:'  Alpha  '}), unnamed=await create(), untitled=await create();
 await db.query("update public.orders set order_name='   ' where id=any($1)",[[unnamed,untitled]]);
 await db.query("update public.assets set original_filename='Alphaa.pdf' where order_id=$1",[unnamed]);
 await db.query("update public.assets set original_filename=null where order_id=$1",[untitled]);
 q=await query({section:'ready',onlyIds:[untitled,unnamed,titled],sort:'title'});
 assert.deepEqual(q.data.map(row=>row.id),[titled,unnamed,untitled]);
 // Filename extensions must not change title ordering: the visible title of 'Alpha.z' is 'Alpha'.
 await db.query("update public.orders set order_name=null where id=$1",[titled]);
 await db.query("update public.assets set original_filename='Alpha.z' where order_id=$1",[titled]);
 q=await query({section:'ready',onlyIds:[unnamed,titled],sort:'title'});
 assert.deepEqual(q.data.map(row=>row.id),[titled,unnamed]);
 for(const name of ['shop_queue_query(uuid,jsonb)','shop_queue_rows(uuid,uuid[])','shop_queue_detail(uuid,uuid)','print_claim_reviewed_batch(uuid,uuid,uuid,uuid)','print_expire_unclaimed_batch(uuid,uuid)']) {
   assert.equal(await scalar("select has_function_privilege('anon',$1,'EXECUTE')",['public.'+name]),false);
   assert.equal(await scalar("select has_function_privilege('authenticated',$1,'EXECUTE')",['public.'+name]),false);
   assert.equal(await scalar("select has_function_privilege('service_role',$1,'EXECUTE')",['public.'+name]),true);
 }
 console.log('Shop queue and reviewed batch SQL passed: full-dataset search, counts, Manila dates, page clamping, financial follow-up, fingerprints, sequence, atomic rejection, recovery, ownership and grants.');
 }finally{await db.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
