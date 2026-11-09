// Local HTTP smoke test. Build first: npm run build && node scripts/smoke-shop-queue.cjs
// Does not load .env, contact Supabase, send email, or connect to a printer.
require('reflect-metadata');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { randomUUID, createHash } = require('node:crypto');
const { join } = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { PDFDocument } = require('pdf-lib');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const compiled = name => require(join(__dirname, '..', 'dist', 'src', name));
const { ShopQueueController } = compiled('orders/shop-queue.controller');
const { ShopQueueService } = compiled('orders/shop-queue.service');
const { OrdersController } = compiled('orders/orders.controller');
const { OrdersService } = compiled('orders/orders.service');
const { PrintableDocumentService } = compiled('orders/printable-document.service');
const { EdgeController } = compiled('edge/edge.controller');
const { ReviewedBatchService } = compiled('edge/reviewed-batch.service');
const { PrintSpoolerService } = compiled('edge/print-spooler.service');
const { PrintJobsRepository } = compiled('edge/repositories/print-jobs.repository');
const { PrintAssetService } = compiled('edge/print-asset.service');
const { EdgeDaemonGateway } = compiled('edge/edge-daemon.gateway');
const { SupabaseService } = compiled('supabase/supabase.service');
const { SupabaseAuthGuard } = compiled('iam/guards/supabase-auth.guard');
const { RolesGuard } = compiled('iam/guards/roles.guard');
const { GlobalExceptionFilter } = compiled('common/global-exception.filter');

async function main() {
  const db = new PGlite();
  let app, base;
  const shop = randomUUID(), student = randomUUID(), other = randomUUID(), unverified = randomUUID(), device = randomUUID();
  const files = new Map(), tokens = new Map([['shop-token',shop],['student-token',student],['other-token',other],['unverified-token',unverified]]);
  const report = [];
  const pass = label => { report.push(label); console.log('PASS '+label); };
  const scalar = async (sql, args=[]) => Object.values((await db.query(sql,args)).rows[0])[0];
  const ident = name => { assert.match(name,/^[a-z_][a-z_0-9]*$/); return '"'+name+'"'; };
  const rpc = async (name,args) => {
    const entries=Object.entries(args);
    const result=await db.query('select public.'+ident(name)+'('+entries.map(([key],i)=>ident(key)+' => $'+(i+1)).join(',')+') as result',
      entries.map(([,value])=>value && typeof value==='object' && !Array.isArray(value) ? JSON.stringify(value) : value));
    if(name==='shop_queue_rows')return result.rows.map(row=>row.result);
    return result.rows[0]?.result;
  };
  // A small Supabase transport adapter. All reads and mutations execute real SQL.
  const client = {
    auth:{getUser:async token=>({data:{user:tokens.has(token)?{id:tokens.get(token)}:null},error:tokens.has(token)?null:{status:401}})},
    rpc(name,args){
      const run=async()=>{try{return {data:await rpc(name,args),error:null,status:200};}catch(error){return {data:null,error:{code:error.code,message:error.message,details:error.detail},status:400};}};
      return {then:(yes,no)=>run().then(yes,no),abortSignal:()=>run()};
    },
    from(table){
      assert.ok(['users','shops','orders','assets','print_jobs','print_batch_requests','print_batch_reviews','print_job_events','order_fulfillment_events'].includes(table));
      const where=[],params=[],sort=[]; let limit,insert,one=false;
      const chain={
        select(){return chain;},
        eq(key,value){params.push(value);where.push(ident(key)+'=$'+params.length);return chain;},
        in(key,values){params.push(values);where.push(ident(key)+'=any($'+params.length+')');return chain;},
        is(key,value){assert.equal(value,null);where.push(ident(key)+' is null');return chain;},
        order(key,options={}){sort.push(ident(key)+(options.ascending===false?' desc':' asc'));return chain;},
        limit(value){assert.ok(Number.isInteger(value));limit=value;return chain;},
        insert(value){insert=value;return chain;},
        single(){one=true;return run();},maybeSingle(){one=true;return run();},
        then(yes,no){return run().then(yes,no);},
      };
      async function run(){
        try {
          let result;
          if(insert){
            const entries=Object.entries(insert);
            result=await db.query('insert into public.'+ident(table)+'('+entries.map(([k])=>ident(k)).join(',')+') values('+entries.map((_,i)=>'$'+(i+1)).join(',')+') returning *',
              entries.map(([key,value])=>key==='items'?JSON.stringify(value):value));
          }else result=await db.query('select * from public.'+ident(table)+(where.length?' where '+where.join(' and '):'')+(sort.length?' order by '+sort.join(','):'')+(limit?' limit '+limit:''),params);
          return {data:one?(result.rows[0]||null):result.rows,error:null};
        }catch(error){return {data:null,error:{code:error.code,message:error.message}};}
      }
      return chain;
    },
    storage:{from:bucket=>({
      download:async path=>({data:files.has(bucket+'/'+path)?new Blob([files.get(bucket+'/'+path)],{type:'application/pdf'}):null,error:null}),
      upload:async(path,bytes)=>{files.set(bucket+'/'+path,Buffer.from(bytes));return {error:null};},
    })},
  };
  const storagePath = value => value;
  const supabase = {getAdminClient:()=>client,storagePath,
    createSignedStorageUrl:async(bucket,path)=>path?base+'/__smoke-storage/'+bucket+'/'+encodeURIComponent(path)+'?token=local-only':null};
  let connected=true,printers=['Smoke printer']; const sent=[];
  const gateway={
    hasConnectedDaemon:()=>connected,
    getConnectedAgent:()=>connected?{deviceId:device,supportsAttempts:true}:null,
    getAvailablePrinters:()=>printers,
    buildCommand:async attempt=>({attemptId:attempt.attempt_id,orderId:attempt.order_id}),
    emitPrintCommands:(_shop,_device,commands)=>{if(!connected)return false;sent.push(commands);return true;},
    broadcastAttempt(){},
  };
  const request=async(method,path,body,token='shop-token',status=200)=>{
    const response=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    assert.equal(response.status,status,method+' '+path+' '+JSON.stringify(data));
    return {data,response};
  };
  const decision=(id,action,data={})=>rpc('apply_order_decision',{p_order:id,p_actor:shop,p_actor_type:'SHOP',p_action:action,p_data:data});
  const getOrder=id=>db.query('select * from public.orders where id=$1',[id]).then(result=>result.rows[0]);
  const attempts=requestId=>db.query('select * from public.print_jobs where batch_request_id=$1 order by id',[requestId]).then(result=>result.rows);
  const checks=Object.fromEntries(['document','revision','paper','color','orientation','pages','copies'].map(key=>[key,true]));
  const pdf=await PDFDocument.create();pdf.addPage([595.28,841.89]);pdf.addPage([595.28,841.89]);
  const bytes=Buffer.from(await pdf.save());
  const create=async({method='CASH_ON_PICKUP',accepted=false,title='Smoke assignment',owner=shop,filename='Report.pdf',date='2026-10-09T16:00:00Z'}={})=>{
    const id=randomUUID(),path='private/'+id+'.pdf';
    await db.query("insert into public.orders(id,client_id,shop_id,state,total,payment_method,page_count,copies,order_name,created_at) values($1,$2,$3,'OPEN_INQUIRY',30,$4,2,3,$5,$6)",[id,student,owner,method,title,date]);
    await db.query("insert into public.assets(order_id,file_url,file_type,dpi,original_filename) values($1,$2,'PDF',300,$3)",[id,path,filename]);
    files.set('assets/'+path,bytes);
    if(accepted)await decision(id,'ACCEPT');
    return id;
  };
  const selection=async ids=>(await request('GET','/orders/shop/selection?onlyIds='+ids.join(','))).data;
  const preview=async(ids,mode='MANUAL')=>{
    const rows=await selection(ids),byId=new Map(rows.map(row=>[row.id,row]));
    const body={orders:ids.map(id=>({orderId:id,fingerprint:byId.get(id)?.fingerprint||'0'.repeat(32)})),mode,...(mode==='AGENT'?{printerName:'Smoke printer'}:{})};
    return (await request('POST','/edge/batch-preview',body,'shop-token',201)).data;
  };
  const execute=(ids,review,requestId=randomUUID(),status=201)=>request('POST',review.mode==='AGENT'?'/edge/batch-execute':'/edge/manual-production',
    {orderIds:ids,reviewToken:review.reviewToken,requestId,...(review.mode==='AGENT'?{printerName:review.printerName}:{})},'shop-token',status);
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create type public.order_state as enum ('DRAFT','OPEN_INQUIRY','PROOF_APPROVED','AWAITING_PAYMENT','AWAITING_PAYMENT_VERIFICATION','ESCALATED_DISPUTE','IN_PRODUCTION','PRINTED','EXPIRED');
      create table public.users(id uuid primary key,role text,first_name text,last_name text);
      create table public.shops(id uuid primary key,verification_status text);
      create table public.admins(id uuid primary key);
      create table public.orders(id uuid primary key default gen_random_uuid(),client_id uuid,shop_id uuid,state public.order_state default 'DRAFT',total numeric(12,2) default 15,created_at timestamptz default now(),expires_at timestamptz,shop_rejection_reason text,dispute_reason text,page_count integer default 2,copies integer default 1,paper_size text default 'A4',print_color_mode text default 'BLACK_AND_WHITE',orientation text default 'PORTRAIT',order_name text);
      create table public.assets(id uuid primary key default gen_random_uuid(),order_id uuid references public.orders(id),file_url text,file_type text,dpi integer,original_filename text);
      create table public.payment_receipts(id uuid primary key default gen_random_uuid(),order_id uuid references public.orders(id),uploaded_by uuid,receipt_url text,reference_number text,verified boolean default false,created_at timestamptz default now());
      create table public.notifications(id uuid primary key default gen_random_uuid(),order_id uuid,clerk_id uuid,is_read boolean default false);
      create table public.print_jobs(id bigint generated always as identity primary key,order_id uuid,shop_id uuid,status text,created_at timestamptz default now(),updated_at timestamptz default now());
      create unique index print_jobs_one_active_per_order_idx on public.print_jobs(order_id) where status <> 'FAILED';
    `);
    for(const file of readdirSync(join(__dirname,'../supabase/migrations')).filter(name=>/^202611.*\.sql$/.test(name)).sort())await db.exec(readFileSync(join(__dirname,'../supabase/migrations',file),'utf8'));
    await db.query("insert into public.users values($1,'STUDENT','Ana','Cruz'),($2,'CLERK','Smoke','Shop'),($3,'MANAGER','Other','Shop'),($4,'CLERK','Pending','Shop')",[student,shop,other,unverified]);
    await db.query("insert into public.shops values($1,'VERIFIED'),($2,'VERIFIED'),($3,'PENDING_REVIEW')",[shop,other,unverified]);
    const module=await Test.createTestingModule({
      controllers:[ShopQueueController,OrdersController,EdgeController],
      providers:[ShopQueueService,OrdersService,PrintableDocumentService,ReviewedBatchService,PrintSpoolerService,PrintJobsRepository,PrintAssetService,SupabaseAuthGuard,RolesGuard,
        {provide:SupabaseService,useValue:supabase},{provide:EdgeDaemonGateway,useValue:gateway}],
    }).compile();
    app=module.createNestApplication({logger:false});
    app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.getHttpAdapter().getInstance().get('/__smoke-storage/:bucket/:key',(req,res)=>{
      const file=files.get(req.params.bucket+'/'+req.params.key);
      if(req.query.token!=='local-only'||!file)return res.sendStatus(404);
      res.type('application/pdf').send(file);
    });
    await app.listen(0,'127.0.0.1');base=await app.getUrl();
    await request('GET','/orders/shop/queue',undefined,null,401);
    await request('GET','/orders/shop/queue',undefined,'student-token',403);
    await request('GET','/orders/shop/queue',undefined,'unverified-token',404);
    for(const suffix of ['pageSize=26','dateFrom=2026-W45','dateFrom=2026-11-10&dateTo=2026-11-09','onlyIds=invalid'])await request('GET','/orders/shop/queue?'+suffix,undefined,'shop-token',400);
    pass('HTTP authentication, roles, verified-shop access and DTO validation');

    const cash=await create({title:'Cash thesis'}),gcash=await create({method:'GCASH',title:'GCash thesis'});
    const receipt=await rpc('apply_order_decision',{p_order:gcash,p_actor:student,p_actor_type:'STUDENT',p_action:'UPLOAD_RECEIPT',p_data:{reference:'SMOKE-GCASH-REF',receiptPath:'private/smoke-receipt.png'}});
    for(let i=0;i<30;i++)await create({accepted:true,title:'Duplicate assignment',filename:i===29?'R\u00e9sum\u00e9 \u5b66\u751f.'+'long.'.repeat(30)+'docx':'Report.pdf',date:i===0?'2026-10-09T15:59:59Z':'2026-10-09T16:00:00Z'});
    const first=await request('GET','/orders/shop/queue?section=ready&pageSize=3');
    assert.equal(first.data.data.length,3);assert.equal(first.data.meta.totalItems,30);assert.equal(first.data.counts.new,2);
    assert.equal(first.response.headers.get('cache-control'),'no-store');
    const found=(await request('GET','/orders/shop/queue?section=ready&search='+encodeURIComponent('\u5b66\u751f.long.long'))).data;
    assert.equal(found.meta.totalItems,1);
    assert.equal((await request('GET','/orders/shop/queue?section=ready&search=ana%20cruz')).data.meta.totalItems,30);
    assert.equal((await request('GET','/orders/shop/queue?section=ready&dateFrom=2026-10-10&dateTo=2026-10-10')).data.meta.totalItems,29);
    assert.equal((await request('GET','/orders/shop/queue?section=ready&page=999&pageSize=25')).data.meta.currentPage,2);
    assert.equal((await request('GET','/orders/shop/queue',undefined,'other-token')).data.meta.totalItems,0);
    await request('GET','/orders/shop/'+cash,undefined,'other-token',404);
    pass('Joined Unicode search, pagination, Manila boundaries, counts and cross-shop isolation');

    await request('POST','/orders/'+cash+'/decision',{action:'ACCEPT'},'shop-token',201);
    await request('POST','/orders/'+gcash+'/verify-payment',{action:'APPROVE',receiptId:receipt.current_receipt_id,confirmed:true},'shop-token',201);
    const detail=(await request('GET','/orders/shop/'+gcash)).data;
    assert.equal(detail.selectable,true);assert.equal(detail.acceptance_status,'ACCEPTED');assert.equal(detail.payment_status,'VERIFIED');
    assert.equal(detail.current_receipt_id,receipt.current_receipt_id);assert.ok(!('source_path' in detail));assert.ok(!('raw_attempt' in detail));
    assert.deepEqual(Buffer.from(await (await fetch(detail.assets[0].file_url)).arrayBuffer()),bytes);
    pass('Cash acceptance and GCash verification authorize the current stored PDF through HTTP');

    const ids=[gcash,cash],review=await preview(ids),requestId=randomUUID();
    assert.ok(review.reviewToken);assert.equal(review.totalPrintedPages,12);
    assert.deepEqual(review.orders.map(row=>row.id),ids);
    assert.equal(Number(await scalar('select count(*) from public.print_jobs')),0);
    await request('POST','/edge/manual-production',{orderIds:ids,requestId},'shop-token',400);
    const accepted=(await execute(ids,review,requestId)).data;
    assert.deepEqual(accepted.acceptedOrderIds,ids);assert.equal(accepted.downloads.length,2);
    const download=await fetch(accepted.downloads[0].url);assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    assert.equal((await getOrder(cash)).state,'IN_PRODUCTION');
    assert.equal((await selection([cash]))[0].section,'pickup');
    const replay=(await execute(ids,review,requestId)).data;assert.equal(replay.replayed,true);assert.equal((await attempts(requestId)).length,2);
    const recovered=(await request('GET','/edge/batches/'+requestId)).data;
    assert.equal(recovered.status,'ACCEPTED');assert.deepEqual(recovered.result.acceptedOrderIds,ids);
    pass('Fresh manual review, pinned downloads, reviewed sequence, replay and request recovery');

    for(const id of ids){
      const attempt=accepted.attempts.find(item=>item.orderId===id);
      await request('PATCH','/orders/'+id+'/state',{state:'READY_FOR_PICKUP',expectedAttemptId:attempt.attemptId,confirmed:true,checks:{}},'shop-token',400);
      await request('PATCH','/orders/'+id+'/state',{state:'READY_FOR_PICKUP',expectedAttemptId:attempt.attemptId,confirmed:true,checks});
    }
    await request('POST','/orders/'+cash+'/decision',{action:'FLAG_UNCLAIMED'},'shop-token',201);
    assert.equal((await request('GET','/orders/shop/queue?section=pickup&status=UNCLAIMED')).data.meta.totalItems,1);
    await request('POST','/orders/'+cash+'/decision',{action:'COLLECT_CASH',confirmed:true},'shop-token',201);
    await request('PATCH','/orders/'+gcash+'/state',{state:'COMPLETED',expectedAttemptId:accepted.attempts[0].attemptId,confirmed:true});
    const history=(await request('GET','/orders/shop/queue?section=history&pageSize=20')).data;
    assert.equal(history.meta.totalItems,2);assert.ok(history.data.every(row=>row.closed_at&&row.state==='COMPLETED'));
    pass('Output inspection, unclaimed Pickup, cash collection, GCash handover and History');

    const candidates=first.data.data.map(row=>row.id),staleIds=candidates.slice(0,2),stale=await preview(staleIds),staleRequest=randomUUID();
    await request('DELETE','/orders/'+staleIds[1],undefined,'student-token',409);
    const competing=await preview([staleIds[1]]);await execute([staleIds[1]],competing);
    await execute(staleIds,stale,staleRequest,409);assert.equal((await attempts(staleRequest)).length,0);
    assert.equal((await request('GET','/edge/batches/'+staleRequest)).data.status,'FAILED');
    const foreign=await preview([randomUUID()]);assert.equal(foreign.reviewToken,null);
    await request('POST','/edge/batch-preview',{mode:'MANUAL',orders:Array.from({length:26},()=>({orderId:randomUUID(),fingerprint:'0'.repeat(32)}))},'shop-token',400);
    pass('Stale selection and inaccessible orders reject the entire batch; 25-order limit enforced');

    const latePayment=await create({method:'GCASH',title:'Closed financial follow-up'});
    const lateReceipt=await rpc('apply_order_decision',{p_order:latePayment,p_actor:student,p_actor_type:'STUDENT',p_action:'UPLOAD_RECEIPT',p_data:{reference:'LATE-SMOKE-REF',receiptPath:'private/late-receipt.png'}});
    await request('DELETE','/orders/'+latePayment,undefined,'student-token');
    await request('POST','/orders/'+latePayment+'/verify-payment',{action:'APPROVE',receiptId:lateReceipt.current_receipt_id,confirmed:true},'shop-token',201);
    const followUp=(await request('GET','/orders/shop/'+latePayment)).data;
    assert.equal(followUp.state,'CANCELLED');assert.equal(followUp.payment_status,'REFUND_DUE');assert.equal(followUp.section,'new');
    pass('Late verified payment on a closed order remains in New Orders as refund follow-up');

    const agentIds=[await create({accepted:true}),await create({accepted:true})],agentReview=await preview(agentIds,'AGENT');
    printers=[];await execute(agentIds,agentReview,randomUUID(),409);assert.equal(sent.length,0);printers=['Smoke printer'];
    const newAgentReview=await preview(agentIds,'AGENT'),agentRequest=randomUUID();
    const jobs=app.get(PrintJobsRepository),complete=jobs.completeBatchRequest.bind(jobs);let loseResponse=true;
    jobs.completeBatchRequest=async(...args)=>{if(loseResponse){loseResponse=false;throw new Error('Simulated response interruption after acceptance');}return complete(...args);};
    await execute(agentIds,newAgentReview,agentRequest,503);
    assert.equal(sent.length,1);assert.deepEqual(sent[0].map(command=>command.orderId),agentIds);
    const agentRecovered=(await request('GET','/edge/batches/'+agentRequest)).data;
    assert.equal(agentRecovered.status,'ACCEPTED');assert.equal((await attempts(agentRequest)).length,2);assert.equal(sent.length,1);
    for(const attempt of agentRecovered.result.attempts){
      for(const [index,status] of ['RECEIVED','DOWNLOADING','SUBMITTING','SUBMITTED'].entries()){
        if(status==='SUBMITTING')assert.equal((await rpc('print_authorize_attempt',{p_attempt_id:attempt.attemptId,p_shop_id:shop,p_device_id:device})).authorized,true);
        const event=await rpc('print_record_agent_event',{p_attempt_id:attempt.attemptId,p_shop_id:shop,p_device_id:device,p_sequence:index+1,p_status:status,p_failure_phase:null,p_error_code:null,p_error_message:null,p_occurred_at:new Date().toISOString()});assert.equal(event.ok,true);
      }
      assert.equal((await getOrder(attempt.orderId)).state,'IN_PRODUCTION');assert.equal((await selection([attempt.orderId]))[0].section,'pickup');
    }
    pass('Explicit printer selection, simulated agent dispatch, lost response and submission without automatic readiness');

    const abandonedId=await create({accepted:true}),abandonedReview=await preview([abandonedId]);
    const abandonedRequest=randomUUID();await rpc('print_begin_batch_request',{p_request_id:abandonedRequest,p_shop_id:shop,p_request_hash:createHash('sha256').update('abandoned').digest('hex'),p_actor_id:shop});
    await db.query("update public.print_batch_requests set created_at=now()-interval '16 minutes' where request_id=$1",[abandonedRequest]);
    assert.equal((await request('GET','/edge/batches/'+abandonedRequest)).data.status,'FAILED');
    const rejected=await rpc('print_claim_reviewed_batch',{p_token:abandonedReview.reviewToken,p_shop:shop,p_actor:shop,p_request:abandonedRequest});assert.equal(rejected.code,'REQUEST_NOT_PENDING');
    assert.equal((await attempts(abandonedRequest)).length,0);
    pass('Abandoned pre-claim recovery releases the request and blocks a late worker');
    console.log('\nHTTP smoke passed: '+report.length+' scenarios. Disposable database and simulated auth/storage/agent only; browser and physical printer not exercised.');
  } finally {if(app)await app.close();await db.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
