const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const bounded=(value,min,max)=>Math.max(min,Math.min(max,value));
const escape=value=>CSS.escape(String(value));

/** Owns only the active document's three rendered blocks. Text and search live in Corpus. */
export class ReaderController {
  constructor(app,reader,spec){
    this.app=app;this.reader=reader;this.paper=reader.querySelector('.ll-paper');this.spec=spec;this.descriptor=spec.descriptor;
    this.abort=new AbortController();this.heights=new Map();this.nodes=new Map();this.center=-1;this.pendingCenter=null;this.generation=0;this.jumpGeneration=0;this.searchGeneration=0;this.closed=false;this.frameId=0;
    this.before=document.createElement('div');this.after=document.createElement('div');
    for(const el of [this.before,this.after]){el.className='ll-reader-spacer';el.setAttribute('aria-hidden','true');}
    this.paper.replaceChildren(this.before,this.after);this.paper.setAttribute('aria-busy','true');
    this.paper.addEventListener('scroll',()=>this.scheduleScroll(),{passive:true,signal:this.abort.signal});
    // No focus on pointerdown: native scrolling, pinch zoom and selection stay independent.
    window.addEventListener('pointerdown',()=>this.cancelJump(),{passive:true,signal:this.abort.signal});
    window.addEventListener('wheel',()=>this.cancelJump(),{passive:true,signal:this.abort.signal});
    this.paper.addEventListener('keydown',ev=>{if(['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(ev.key))this.cancelJump();void this.keyboard(ev);},{signal:this.abort.signal});
    this.paper.addEventListener('load',()=>this.measure(),{capture:true,signal:this.abort.signal});
    if(globalThis.ResizeObserver){this.resizeObserver=new ResizeObserver(()=>{if(this.closed||this.resizeFrame)return;this.resizeFrame=requestAnimationFrame(()=>{this.resizeFrame=0;if(this.closed||this.jumping)return;const width=this.paper.clientWidth;if(this.width&&width!==this.width)this.heights.clear();this.width=width;this.measure();this.scheduleScroll();});});this.resizeObserver.observe(this.paper);}
  }
  record(event,fields){try{this.app.opt?.diagnostics?.record(event,{docId:this.descriptor.docId,...fields});}catch{}}
  stats(){return {docId:this.descriptor.docId,locale:this.descriptor.locale,mountedUnits:this.paper.querySelectorAll('[data-unit]').length,blocks:this.nodes.size,searchPending:Boolean(this.searchPending),jumpPending:Boolean(this.jumping)};}
  height(index){return this.heights.get(index)||Math.max(160,this.descriptor.blocks[index].count*115);}
  prefix(index){let height=0;for(let i=0;i<index;i++)height+=this.height(i);return height;}
  locate(offset){let top=0;for(let i=0;i<this.descriptor.blocks.length;i++){top+=this.height(i);if(offset<top)return i;}return this.descriptor.blocks.length-1;}
  capture(){
    const box=this.paper.getBoundingClientRect();let unit=null;
    for(const el of this.paper.querySelectorAll('[data-unit]')){if(el.getBoundingClientRect().bottom>box.top+2){unit=el;break;}}
    return {docId:this.descriptor.docId,locale:this.descriptor.locale,top:this.paper.scrollTop,anchor:unit?{id:unit.dataset.unit,offset:unit.getBoundingClientRect().top-box.top}:null};
  }
  restore(position){
    if(position?.docId&&position.docId!==this.descriptor.docId)return;
    const anchor=position?.anchor,el=anchor&&this.paper.querySelector('[data-unit="'+escape(anchor.id)+'"]');
    if(el){const delta=el.getBoundingClientRect().top-this.paper.getBoundingClientRect().top-anchor.offset;if(Math.abs(delta)>.5)this.paper.scrollTop+=delta;}
    else if(position&&Math.abs(this.paper.scrollTop-(position.top||0))>.5)this.paper.scrollTop=position.top||0;
  }
  async initialize(position){
    if(position?.docId!==this.descriptor.docId)position=null;
    const start=performance.now(),rs=this.app.state.reader[this.descriptor.docId]||{},anchor=position?.anchor?.id||rs.anchorId;
    const block=anchor&&this.descriptor.unitToBlock[anchor];
    if(!await this.window(Number.isInteger(block)?block:this.locate(position?.top??rs.scrollTop??0),null))return;
    if(this.closed)return;
    this.restore(position||{top:rs.scrollTop||0,anchor:anchor?{id:anchor,offset:rs.anchorOffset||0}:null});
    this.record('document-load',{durationMs:Math.round(performance.now()-start),success:true,units:this.stats().mountedUnits});
  }
  scheduleScroll(){
    if(this.closed||this.suspended||this.frameId||this.jumping)return;
    this.frameId=requestAnimationFrame(()=>{this.frameId=0;if(this.closed||this.suspended||this.jumping||this.center<0)return;const position=this.capture(),rs=this.app.state.reader[this.descriptor.docId]||={};rs.scrollTop=position.top;if(position.anchor){rs.anchorId=position.anchor.id;rs.anchorOffset=position.anchor.offset;}
      const center=this.locate(this.paper.scrollTop+this.paper.clientHeight/2);
      if(center===this.center){if(Number.isInteger(this.pendingCenter))this.cancelWindow();}
      else if(center!==this.pendingCenter)void this.window(center,null,()=>center===this.locate(this.paper.scrollTop+this.paper.clientHeight/2)).catch(error=>this.app.fail(error));
    });
  }
  measure(){
    if(this.closed)return;const position=this.capture();let changed=false;
    for(const [index,element]of this.nodes){const height=element.getBoundingClientRect().height;if(this.heights.get(index)!==height){this.heights.set(index,height);changed=true;}}
    if(changed){this.spacers();this.restore(position);}
  }
  spacers(){
    const indexes=[...this.nodes.keys()].sort((a,b)=>a-b);if(!indexes.length)return;
    const start=indexes[0],end=indexes.at(-1)+1;
    const before=this.prefix(start)+'px',after=(this.prefix(this.descriptor.blocks.length)-this.prefix(end))+'px';if(this.before.style.height!==before)this.before.style.height=before;if(this.after.style.height!==after)this.after.style.height=after;
  }
  cancelWindow(){this.generation++;this.windowAbort?.abort();this.windowAbort=null;this.pendingCenter=null;}
  suspend(){this.suspended=true;this.cancelWindow();this.cancelJump();this.cancelSearch();}
  resume(){this.suspended=false;}
  async window(center,position,valid=()=>true){
    if(this.closed||this.suspended)return false;this.cancelWindow();const request=this.windowAbort=new AbortController();
    const generation=this.generation;center=bounded(center,0,this.descriptor.blocks.length-1);
    const indexes=[];for(let i=Math.max(0,center-1);i<=Math.min(this.descriptor.blocks.length-1,center+1);i++)indexes.push(i);
    if(center===this.center&&indexes.every(index=>this.nodes.has(index))){this.windowAbort=null;return true;}
    this.pendingCenter=center;
    try{
    let blocks;try{blocks=await Promise.all(indexes.map(index=>this.app.corpus.loadBlock(this.descriptor.docId,this.descriptor.locale,index,{signal:request.signal})));}
    catch(error){if(error.name==='AbortError'||request.signal.aborted)return false;throw error;}
    if(this.closed||request.signal.aborted||generation!==this.generation||!valid())return false;
    const oldPosition=position||this.capture();
    for(const [index,node]of this.nodes)if(!indexes.includes(index)){node.remove();this.nodes.delete(index);}
    for(let i=0;i<indexes.length;i++){const index=indexes[i];if(!this.nodes.has(index)){const box=document.createElement('div');box.className='ll-reader-block';box.dataset.readerBlock=String(index);box.innerHTML=this.spec.renderBlock(blocks[i]);this.nodes.set(index,box);}}
    // The right neighbour must already be mounted before inserting a new block.
    // Existing overlapping blocks stay in place, preserving focus and anchors.
    let next=this.after;
    for(let i=indexes.length-1;i>=0;i--){const node=this.nodes.get(indexes[i]);if(node.nextElementSibling!==next)this.paper.insertBefore(node,next);next=node;}
    this.center=center;this.paper.setAttribute('aria-busy','false');
    for(const [index,node]of this.nodes)this.heights.set(index,node.getBoundingClientRect().height);
    this.spacers();this.restore(oldPosition);this.spec.afterRender?.();
    return true;
    }finally{if(this.windowAbort===request){this.windowAbort=null;this.pendingCenter=null;}}
  }
  update(spec){this.spec=spec;const selected=new Set(spec.selected),correct=new Set(spec.correctIds);for(const el of this.paper.querySelectorAll('[data-unit]')){const disabled=!spec.readonly&&this.app.isLocked(),action=spec.readonly?'noop':'select-unit';if(el.disabled!==disabled)el.disabled=disabled;if(el.dataset.action!==action)el.dataset.action=action;const chosen=selected.has(el.dataset.unit);el.classList.toggle('selected',chosen);el.classList.toggle('correct',spec.review&&correct.has(el.dataset.unit));el.setAttribute('aria-pressed',String(chosen));const check=el.querySelector('.ll-check');if(check.textContent!==(chosen?'✓':''))check.textContent=chosen?'✓':'';}this.measure();this.spec.afterRender?.();}
  cancelJump(){if(this.jumping){this.cancelWindow();this.jumpGeneration++;this.jumping=false;this.record('document-jump',{durationMs:Math.round(performance.now()-this.jumpStarted),success:false,code:'cancelled'});}}
  async stableViewport(token){
    let last='',stable=0;const start=performance.now();
    while(performance.now()-start<700){await frame();if(this.closed||token!==this.jumpGeneration)return false;const viewport=visualViewport,key=[viewport?.height||innerHeight,viewport?.offsetTop||0,this.paper.clientHeight].map(x=>Math.round(x)).join(':');stable=key===last?stable+1:0;last=key;if(stable>=3&&performance.now()-start>=80)return true;}
    return !this.closed&&token===this.jumpGeneration;
  }
  async navigate(id,{teacher=false,focus=true}={}){
    const index=this.descriptor.unitToBlock[id];if(!Number.isInteger(index)){this.record('document-jump',{success:false,found:false,visible:false,code:'target-missing'});return false;}
    const token=++this.jumpGeneration;this.jumping=true;this.jumpStarted=performance.now();
    const focused=document.activeElement;if(focused?.matches('input')&&this.reader.contains(focused))focused.blur();
    try{
      if(!await this.window(index,null,()=>token===this.jumpGeneration)||!await this.stableViewport(token))return false;
      const el=this.paper.querySelector('[data-unit="'+escape(id)+'"]');if(!el){this.record('document-jump',{success:false,found:false,visible:false,code:'target-missing'});return false;}
      for(const previous of this.paper.querySelectorAll('.ll-search-target,.ll-teacher-target'))previous.classList.remove('ll-search-target','ll-teacher-target');el.classList.add(teacher?'ll-teacher-target':'ll-search-target');
      const section=this.descriptor.units.find(unit=>unit.id===id)?.sectionId,rs=this.app.state.reader[this.descriptor.docId]||={};if(section)rs.sectionId=section;
      for(const button of this.reader.querySelectorAll('[data-action="section"]'))button.classList.toggle('active',button.dataset.id===section);
      for(let attempt=0;attempt<2;attempt++){
        if(this.closed||token!==this.jumpGeneration)return false;
        const box=this.paper.getBoundingClientRect(),target=el.getBoundingClientRect();this.paper.scrollTop+=target.top-box.top-8;
        const bar=document.querySelector('.topbar')?.getBoundingClientRect(),dock=this.reader.querySelector('.ll-reader-dock'),wanted=Math.max(bar?.bottom||0,visualViewport?.offsetTop||0,parseFloat(getComputedStyle(dock).top)||0)+dock.getBoundingClientRect().height+8;
        window.scrollBy({top:this.paper.getBoundingClientRect().top-wanted,behavior:'instant'});await frame();
      }
      if(this.closed||token!==this.jumpGeneration)return false;
      if(focus)el.focus({preventScroll:true});const box=this.paper.getBoundingClientRect(),target=el.getBoundingClientRect(),visibleTop=visualViewport?.offsetTop||0,visible=target.bottom>Math.max(box.top,visibleTop)&&target.top<Math.min(box.bottom,visibleTop+(visualViewport?.height||innerHeight));
      const position=this.capture();rs.scrollTop=position.top;rs.anchorId=id;rs.anchorOffset=target.top-box.top;
      this.record('document-jump',{durationMs:Math.round(performance.now()-this.jumpStarted),success:visible,found:true,visible,code:visible?'ok':'timeout'});return visible;
    }catch(error){if(error.name!=='AbortError')this.record('document-jump',{durationMs:Math.round(performance.now()-this.jumpStarted),success:false,code:'load-failed'});throw error;}
    finally{if(token===this.jumpGeneration){this.jumping=false;this.scheduleScroll();}}
  }
  async search(query,page=0){
    const token=++this.searchGeneration,start=performance.now();this.app.corpus.cancelSearch();this.searchPending=true;
    try{const result=await this.app.corpus.searchDocument(this.descriptor.docId,this.descriptor.locale,query,{page,pageSize:20,signal:this.abort.signal});if(this.closed||token!==this.searchGeneration)return null;
      this.searchResult={...result,query,locale:this.descriptor.locale};this.record('document-search',{durationMs:Math.round(performance.now()-start),success:true,found:result.total>0,targetCount:result.total});return this.searchResult;
    }catch(error){if(error.name==='AbortError')return null;this.record('document-search',{durationMs:Math.round(performance.now()-start),success:false,code:'load-failed'});throw error;}
    finally{if(token===this.searchGeneration)this.searchPending=false;}
  }
  cancelSearch(){this.searchGeneration++;this.searchPending=false;this.app.corpus.cancelSearch();}
  async keyboard(ev){
    const unit=ev.target.closest('[data-unit]');if(!unit)return;
    const units=[...this.paper.querySelectorAll('[data-unit]')],index=units.indexOf(unit),forward=ev.key==='ArrowDown'||ev.key==='Tab'&&!ev.shiftKey,backward=ev.key==='ArrowUp'||ev.key==='Tab'&&ev.shiftKey;
    if(!forward&&!backward)return;const edge=forward?index===units.length-1:index===0;if(!edge)return;
    const current=this.descriptor.units.findIndex(item=>item.id===unit.dataset.unit),next=this.descriptor.units[current+(forward?1:-1)];if(next){ev.preventDefault();await this.navigate(next.id);}
  }
  destroy(){if(this.closed)return;this.closed=true;this.cancelWindow();this.jumpGeneration++;this.cancelSearch();cancelAnimationFrame(this.frameId);cancelAnimationFrame(this.resizeFrame);this.resizeObserver?.disconnect();this.abort.abort();this.nodes.clear();this.heights.clear();}
}
