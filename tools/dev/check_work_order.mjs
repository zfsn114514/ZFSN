import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
test('work ordering requires auth, exact current IDs and a transactional batch',async()=>{
 const ids=['aaaaaaaa','bbbbbbbb'];let updates=[];
 const env={DB:{prepare(sql){let args=[];return {bind(...values){args=values;return this;},async first(){return sql.includes('sessions')&&args[0]==='valid'?{exp:Date.now()+60000}:null;},async all(){return{results:ids.map(id=>({id}))};},get sql(){return sql;},get args(){return args;}};},async batch(statements){updates=statements.map(s=>[s.sql,s.args]);return[];}},TZ_OFFSET:8};
 const save=(values,token='valid')=>worker.fetch(new Request('https://www.zfsnnb.dpdns.org/api/admin/works/order',{method:'POST',headers:{'Content-Type':'application/json','X-Admin-Token':token},body:JSON.stringify({ids:values})}),env,{});
 assert.equal((await save(ids,'bad')).status,401);
 assert.equal((await save(['aaaaaaaa','aaaaaaaa'])).status,400);
 assert.equal((await save(['aaaaaaaa'])).status,409);
 assert.equal((await save(['aaaaaaaa','cccccccc'])).status,409);
 assert.equal(updates.length,0);
 assert.equal((await save([...ids].reverse())).status,200);
 assert.deepEqual(updates.map(s=>s[1]),[[0,'bbbbbbbb'],[1,'aaaaaaaa']]);
});
