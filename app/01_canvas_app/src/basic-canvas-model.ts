import { annotationBounds, scaleAnnotation, type AnnotationState } from "./annotation-model.js";
import type { CanvasProjectDocument, CanvasProjectNode } from "./project-state.js";
import { restoreCanvasProjectStructure } from "./project-state.js";
import { autoArrangeCanvasObjects } from "./auto-layout.js";

export type BasicTool = "select" | "pan" | "text" | "arrow" | "freehand" | "rectangle";
export function basicObjects(doc: CanvasProjectDocument) {
  return [
    ...doc.canvas.nodes.filter(n => n.visible !== false).map(n => ({ id:n.id, ...(n.payload.annotation ? annotationBounds(n.payload.annotation as AnnotationState) : {x:n.x,y:n.y,width:n.width,height:n.height}), locked:n.locked })),
    ...(doc.workflow?.textCards ?? []).map(c => ({id:c.id,x:c.x,y:c.y,width:c.width,height:c.height,locked:false}))
  ];
}
export function moveBasicObjects(doc: CanvasProjectDocument, ids: string[], dx: number, dy: number) {
  for (const n of doc.canvas.nodes) if (ids.includes(n.id) && !n.locked) {
    n.x+=dx; n.y+=dy;
    const a=n.payload.annotation as AnnotationState|undefined; if(a){ a.x+=dx; a.y+=dy; }
  }
  for(const c of doc.workflow?.textCards ?? []) if(ids.includes(c.id)){c.x+=dx;c.y+=dy;}
  return doc;
}
export function selectBasicRect(doc: CanvasProjectDocument, x:number,y:number,endX:number,endY:number) {
  const left=Math.min(x,endX), top=Math.min(y,endY),right=Math.max(x,endX),bottom=Math.max(y,endY);
  return basicObjects(doc).filter(o=>o.x<=right && o.x+Math.max(1,o.width)>=left && o.y<=bottom && o.y+Math.max(1,o.height)>=top).map(o=>o.id);
}
export function deleteBasicObjects(doc:CanvasProjectDocument, ids:string[]) {
  const removable=new Set(basicObjects(doc).filter(o=>ids.includes(o.id)&&!o.locked).map(o=>o.id));
  doc.canvas.nodes=doc.canvas.nodes.filter(n=>!removable.has(n.id));
  if(doc.workflow)doc.workflow.textCards=doc.workflow.textCards.filter(c=>!removable.has(c.id));
  if(doc.simple)doc.simple.selectedIds=doc.simple.selectedIds.filter(id=>!removable.has(id));
  // Assets and versions are retained: undo and descendant provenance remain valid.
  return doc;
}
export function resizeBasicObject(doc:CanvasProjectDocument,id:string,width:number,height:number) {
  const c=doc.workflow?.textCards.find(c=>c.id===id);
  if(c){c.width=Math.max(320,width);c.height=Math.max(240,height);return doc;}
  const n=doc.canvas.nodes.find(n=>n.id===id); if(!n||n.locked)return doc;
  const a=n.payload.annotation as AnnotationState|undefined;
  if(a){ n.payload.annotation=scaleAnnotation(a,Math.max(8,width)/Math.max(1,n.width),Math.max(8,height)/Math.max(1,n.height)); const b=annotationBounds(n.payload.annotation as AnnotationState);Object.assign(n,b); }
  else {n.width=Math.max(32,width);n.height=Math.max(32,height);}
  return doc;
}
export function arrangeBasicObjects(doc:CanvasProjectDocument,ids:string[],direction:"horizontal"|"vertical"|"grid") {
  const objects=basicObjects(doc).filter(o=>(!ids.length||ids.includes(o.id))&&!o.locked);
  if(!objects.length)return doc;
  if(direction==="grid"){
    const allowed=new Set(objects.map(o=>o.id));
    const restored=restoreCanvasProjectStructure(doc);
    const result=autoArrangeCanvasObjects(restored.imageNodes.map(n=>({...n,src:""})),doc.workflow?.textCards??[],{
      nodeIds:restored.imageNodes.filter(n=>allowed.has(n.id)).map(n=>n.id),
      textCardIds:(doc.workflow?.textCards??[]).filter(c=>allowed.has(c.id)).map(c=>c.id)
    });
    for(const o of [...result.nodes,...result.textCards])if(allowed.has(o.id)){
      const before=objects.find(n=>n.id===o.id)!;moveBasicObjects(doc,[o.id],o.x-before.x,o.y-before.y);
    }
    return doc;
  }
  const left=Math.min(...objects.map(o=>o.x)),top=Math.min(...objects.map(o=>o.y));
  let x=left,y=top;
  objects.forEach(o=>{
    moveBasicObjects(doc,[o.id],x-o.x,y-o.y);
    if(direction==="vertical")y+=o.height+64;else x+=o.width+64;
  });return doc;
}
export function annotationNode(a:AnnotationState):CanvasProjectNode {
  return {id:`node_${crypto.randomUUID()}`,type:a.type,...annotationBounds(a),rotation:0,scaleX:1,scaleY:1,zIndex:0,locked:false,visible:true,payload:{annotation:a}};
}
export function basicPanRequested(button:number,tool:BasicTool,space:boolean){return button===1||(button===0&&(tool==="pan"||space));}

