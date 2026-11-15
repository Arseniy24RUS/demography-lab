// Compact transport only. Public document/unit identities and labels stay exact.
const ENCODING='indexed-v1';
function tables(sections,units){
 const strings=[],stringIds=new Map(),sectionIds=new Map(sections.map((s,i)=>[s.id,i])),unitIds=new Map(units.map((u,i)=>[u.id,i]));
 const str=value=>{value=String(value??'');if(!stringIds.has(value)){stringIds.set(value,strings.length);strings.push(value);}return stringIds.get(value);};
 const packedSections=sections.map(s=>[s.id,str(s.title),s.unitIds.map(id=>{if(!unitIds.has(id))throw new Error('Unknown section member');return unitIds.get(id);})]);
 return {strings,str,sectionIds,packedSections};
}
export function packStructure(doc){
 const {units,sections,provenance,tocInventory,...metadata}=doc,t=tables(sections,units);
 return {...metadata,encoding:ENCODING,strings:t.strings,sections:t.packedSections,units:units.map(u=>[u.id,t.sectionIds.get(u.sectionId)])};
}
export function unpackStructure(value){
 if(value.encoding!==ENCODING)return value;
 const {encoding,strings,units:rows,sections:packed,...metadata}=value;
 const units=rows.map(row=>({id:row[0],sectionId:packed[row[1]]?.[0]}));
 const sections=packed.map(row=>({id:row[0],title:strings[row[1]],unitIds:row[2].map(i=>units[i]?.id)}));
 return {...metadata,sections,units};
}
export function packDescriptor(doc){
 const {units,sections,labels,unitToBlock,...metadata}=doc,t=tables(sections,units);
 const rows=units.map(u=>[u.id,t.sectionIds.get(u.sectionId),u.block,u.heading?1:0,t.str(u.label),t.str(u.locator)]);
 return {...metadata,encoding:ENCODING,strings:t.strings,sections:t.packedSections,units:rows};
}
export function unpackDescriptor(value){
 if(value.encoding!==ENCODING)return value;
 const {encoding,strings,units:rows,sections:packed,...metadata}=value,labels={},unitToBlock={};
 const units=rows.map((row,index)=>{const unit={id:row[0],sectionId:packed[row[1]]?.[0],block:row[2],heading:Boolean(row[3]),label:strings[row[4]],locator:strings[row[5]],index};labels[unit.id]=unit.label;unitToBlock[unit.id]=unit.block;return unit;});
 const sections=packed.map(row=>({id:row[0],title:strings[row[1]],unitIds:row[2].map(i=>units[i]?.id)}));
 return {...metadata,sections,units,labels,unitToBlock};
}
