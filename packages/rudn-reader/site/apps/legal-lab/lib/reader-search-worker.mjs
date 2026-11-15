// Standalone so an existing window always uses its pinned release, even after
// the course service worker has installed a newer one. Same search normalization
// as core.mjs; equivalence is covered against the canonical search tests.
const normalize=v=>String(v??'').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').replace(/[«»„“”"'’]/g,'').replace(/[–—−]/g,'-').replace(/\s+/g,' ').trim();
let loading=null,index=null,revision=0,latest=0,resolveBytes=null,rejectBytes=null;
const cancelled=new Set(),pause=()=>new Promise(resolve=>setTimeout(resolve,0));
async function load(message){
  const current=++revision;index=null;
  const bytes=await new Promise((resolve,reject)=>{resolveBytes=resolve;rejectBytes=reject;});
  const decode=async(buffer,sha256)=>{
    const digest=await crypto.subtle.digest('SHA-256',buffer),hash=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
    if(hash!==sha256)throw new Error('hash');
    const value=JSON.parse(new TextDecoder().decode(buffer));
    if(value.schema!==1||value.docId!==message.docId||value.locale!==message.locale||value.contentVersion!==message.contentVersion)throw new Error('index');
    return value;
  };
  let value;
  if(message.blocks){
    if(!Array.isArray(bytes)||bytes.length!==message.blocks.length)throw new Error('index');
    value={encoding:'indexed-v1',rows:[]};
    for(let i=0;i<bytes.length;i++){
      const pin=message.blocks[i],block=await decode(bytes[i],pin.sha256);
      if(block.id!==i||block.units?.length!==pin.count)throw new Error('index');
      for(const unit of block.units)value.rows.push([unit.id,unit.sectionId,normalize(unit.text+' '+(unit.locator||'')),unit.text.slice(0,500)]);
      bytes[i]=null;if(i%8===0)await pause();if(current!==revision)return;
    }
  }else{value=await decode(bytes,message.sha256);if(!Array.isArray(value.rows))throw new Error('index');}
  if(current!==revision)return;index=value;postMessage({type:'ready'});
}
async function search(message){const request=message.request;latest=request;try{await loading;if(cancelled.has(request)||latest!==request)return;if(!index||index.encoding!=='indexed-v1')throw new Error('index');const words=normalize(message.query).split(' ').filter(Boolean),matches=[];if(words.length)for(let i=0;i<index.rows.length;i++){const row=index.rows[i];if(words.every(word=>row[2].includes(word)))matches.push(i);if(i&&i%512===0){await pause();if(cancelled.has(request)||latest!==request)return;}}const total=matches.length,pages=Math.max(1,Math.ceil(total/message.pageSize)),page=Math.min(message.page,pages-1),hits=matches.slice(page*message.pageSize,(page+1)*message.pageSize).map(i=>{const row=index.rows[i];return {id:row[0],sectionId:row[1],text:row[3]};});if(!cancelled.has(request)&&latest===request)postMessage({type:'result',request,result:{hits,total,page,pages}});}catch(error){if(!cancelled.has(request)&&latest===request)postMessage({type:'error',request,code:'reader/search-'+(['load','hash','index'].includes(error.message)?error.message:'failed')});}finally{cancelled.delete(request);}}
self.onmessage=({data})=>{if(data?.type==='load'){loading=load(data);loading.catch(()=>{});}else if(data?.type==='index'){resolveBytes?.(data.bytes);resolveBytes=rejectBytes=null;}else if(data?.type==='index-error'){rejectBytes?.(new Error('load'));resolveBytes=rejectBytes=null;}else if(data?.type==='cancel'){cancelled.add(data.request);if(cancelled.size>100)cancelled.delete(cancelled.values().next().value);}else if(data?.type==='search')void search(data);};
