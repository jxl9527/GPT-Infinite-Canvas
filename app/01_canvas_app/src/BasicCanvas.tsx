import { useEffect, useRef, useState, type ReactNode } from "react";
import { Stage, Layer, Group, Rect, Text, Line, Arrow, Image as KImage } from "react-konva";
import Konva from "konva";
import type { CanvasProjectDocument, CanvasProjectNode } from "./project-state";
import { annotationBounds, normalizeRectangle, type AnnotationState } from "./annotation-model";
import { annotationNode, arrangeBasicObjects, basicObjects, basicPanRequested, deleteBasicObjects, moveBasicObjects, resizeBasicObject, selectBasicRect, type BasicTool } from "./basic-canvas-model";
import { buildCanvasRelation, coverCrop } from "./canvas-layout";
import { useAssetImage } from "./simple-asset-image";
import { readCanvasAssetAsObjectUrl, releaseCanvasAssetObjectUrl } from "./bridge-client";

type Update=(fn:(d:CanvasProjectDocument)=>CanvasProjectDocument,remember?:boolean)=>void;
type Gesture={kind:"pan"|"move"|"marquee"|"resize"|"draw";sx:number;sy:number;dx:number;dy:number;scale:number;ids:string[];vx:number;vy:number;wx:number;wy:number;add:boolean;annotation?:AnnotationState;width?:number;height?:number};
function Bitmap({node,assetId}:{node:CanvasProjectNode;assetId:string}){
  const image=useAssetImage(assetId);
  const ratio=image?Math.min(node.width/image.naturalWidth,node.height/image.naturalHeight):1;
  const cropped=node.payload.fit==="cover";
  return <><Rect width={node.width} height={node.height} fill="#e8e8e2" stroke="#cdd1c8"/>{image?<KImage image={image} x={cropped?0:(node.width-image.naturalWidth*ratio)/2} y={cropped?0:(node.height-image.naturalHeight*ratio)/2} width={cropped?node.width:image.naturalWidth*ratio} height={cropped?node.height:image.naturalHeight*ratio} crop={cropped?coverCrop({width:image.naturalWidth,height:image.naturalHeight},node):undefined}/>:<Text width={node.width} y={node.height/2} text="正在载入图片…" align="center"/>}<Text y={node.height+10} width={node.width} text={String(node.payload.name??"图片")} fontSize={15} fill="#515b50" wrap="none" ellipsis/></>;
}
function Mark({a}:{a:AnnotationState}){
  return a.type==="text"?<Text text={a.text} width={a.width} fontSize={a.fontSize} fill={a.color}/>:a.type==="rectangle"?<Rect width={a.width} height={a.height} stroke={a.color} strokeWidth={2}/>:a.type==="arrow"?<Arrow points={a.points} stroke={a.color} fill={a.color} strokeWidth={2}/>:<Line points={a.points} stroke={a.color} strokeWidth={2} lineCap="round" lineJoin="round"/>;
}
export function BasicCanvas({doc,update,undo,canUndo,canRedo,hidden,onImport,onPreview,onEditText,children}:{doc:CanvasProjectDocument;update:Update;undo(redo?:boolean):void;canUndo:boolean;canRedo:boolean;hidden:boolean;onImport(files:File[]):void;onPreview(assetId:string,name:string):void;onEditText(id:string):void;children?:ReactNode}){
  const host=useRef<HTMLDivElement>(null),stage=useRef<Konva.Stage>(null);
  const [size,setSize]=useState({width:1000,height:700}),[tool,setTool]=useState<BasicTool>("select"),[space,setSpace]=useState(false),[gesture,setGesture]=useState<Gesture|null>(null);
  const gestureRef=useRef<Gesture|null>(null),spaceRef=useRef(false);
  const [color,setColor]=useState("#bb3c35"),[editor,setEditor]=useState<{id:string;text:string;kind:"annotation"|"name"}|null>(null);
  const latest=useRef({doc,update,hidden,tool});latest.current={doc,update,hidden,tool};
  const ids=doc.simple!.selectedIds;
  const select=(values:string[])=>update(d=>{d.simple!.selectedIds=values;return d;});
  const start=(g:Gesture)=>{gestureRef.current=g;setGesture(g);};
  const finish=()=>{
    const g=gestureRef.current;if(!g)return;gestureRef.current=null;setGesture(null);
    const {update,doc}=latest.current;
    if(g.kind==="pan"){update(d=>{d.canvas.viewport={x:g.vx+g.dx,y:g.vy+g.dy,scale:g.scale};return d;});return;}
    if(g.kind==="move" && (g.dx||g.dy)){update(d=>moveBasicObjects(d,g.ids,g.dx/g.scale,g.dy/g.scale),true);return;}
    if(g.kind==="resize"){update(d=>resizeBasicObject(d,g.ids[0]!,g.width!+g.dx/g.scale,g.height!+g.dy/g.scale),true);return;}
    if(g.kind==="marquee"){const values=selectBasicRect(doc,g.wx,g.wy,g.wx+g.dx/g.scale,g.wy+g.dy/g.scale);update(d=>{d.simple!.selectedIds=g.add?[...new Set([...g.ids,...values])]:values;return d;});return;}
    if(g.kind==="draw"&&g.annotation){let a=g.annotation;if(a.type==="rectangle")a=normalizeRectangle(a);if(Math.abs(g.dx)+Math.abs(g.dy)<3)return;const node=annotationNode(a);update(d=>{d.canvas.nodes.push(node);d.simple!.selectedIds=[node.id];return d;},true);setTool("select");}
  };
  const finishRef=useRef(finish);finishRef.current=finish;
  useEffect(()=>{if(!host.current)return;const observer=new ResizeObserver(([e])=>{if(e?.contentRect.width)setSize({width:e.contentRect.width,height:e.contentRect.height});});observer.observe(host.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    const move=(e:MouseEvent)=>{const current=gestureRef.current;if(!current)return;const g={...current,dx:e.clientX-current.sx,dy:e.clientY-current.sy};
      if(g.annotation){const a=structuredClone(g.annotation);if(a.type==="rectangle"){a.width=g.dx/g.scale;a.height=g.dy/g.scale;}else if(a.type==="arrow")a.points=[0,0,g.dx/g.scale,g.dy/g.scale];else if(a.type==="freehand")a.points.push(g.dx/g.scale,g.dy/g.scale);g.annotation=a;}
      gestureRef.current=g;setGesture(g);e.preventDefault();};
    const up=()=>finishRef.current();const blur=()=>{finishRef.current();spaceRef.current=false;setSpace(false);};
    window.addEventListener("mousemove",move);window.addEventListener("mouseup",up);window.addEventListener("blur",blur);
    return()=>{window.removeEventListener("mousemove",move);window.removeEventListener("mouseup",up);window.removeEventListener("blur",blur);};
  },[]);
  const viewport=gesture?.kind==="pan"?{x:gesture.vx+gesture.dx,y:gesture.vy+gesture.dy,scale:gesture.scale}:doc.canvas.viewport;
  const zoom=(scale:number,point={x:size.width/2,y:size.height/2})=>{scale=Math.min(8,Math.max(.03,scale));update(d=>{const v=d.canvas.viewport;d.canvas.viewport={scale,x:point.x-(point.x-v.x)/v.scale*scale,y:point.y-(point.y-v.y)/v.scale*scale};return d;});};
  const fit=()=>{const objects=basicObjects(doc);if(!objects.length)return;const x=Math.min(...objects.map(o=>o.x)),y=Math.min(...objects.map(o=>o.y));const w=Math.max(...objects.map(o=>o.x+o.width))-x,h=Math.max(...objects.map(o=>o.y+o.height+32))-y;const scale=Math.max(.03,Math.min(1,(size.width-100)/Math.max(1,w),(size.height-120)/Math.max(1,h)));update(d=>{d.canvas.viewport={scale,x:(size.width-w*scale)/2-x*scale,y:(size.height-h*scale)/2-y*scale};return d;});};
  const actions=useRef({fit,zoom,undo,onImport});actions.current={fit,zoom,undo,onImport};
  useEffect(()=>{
    const editable=(target:EventTarget|null)=>target instanceof HTMLElement&&!!target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]');
    const down=(e:KeyboardEvent)=>{const {doc,update,hidden}=latest.current;if(hidden||e.isComposing||editable(e.target)||!host.current?.contains(e.target as Node))return;
      const modifier=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();
      if(e.code==="Space"){e.preventDefault();spaceRef.current=true;setSpace(true);return;}
      if(modifier){if(key==="z"||key==="y"){e.preventDefault();actions.current.undo(key==="y"||e.shiftKey);}else if(key==="a"){e.preventDefault();update(d=>{d.simple!.selectedIds=basicObjects(d).map(o=>o.id);return d;});}return;}
      if(e.key==="Escape"){gestureRef.current=null;setGesture(null);setTool("select");update(d=>{d.simple!.selectedIds=[];return d;});return;}
      if(e.key==="Delete"||e.key==="Backspace"){e.preventDefault();update(d=>deleteBasicObjects(d,d.simple!.selectedIds),true);return;}
      const delta:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
      if(delta[e.key]){e.preventDefault();const [x,y]=delta[e.key]!;update(d=>moveBasicObjects(d,d.simple!.selectedIds,x*(e.shiftKey?10:1),y*(e.shiftKey?10:1)),true);return;}
      const keys:Record<string,BasicTool>={v:"select",m:"select",h:"pan",t:"text",a:"arrow",p:"freehand",r:"rectangle"};if(keys[key])setTool(keys[key]!);
      if(key==="f")actions.current.fit();if(key==="0")actions.current.zoom(1);if(key==="+"||key==="=")actions.current.zoom(doc.canvas.viewport.scale/0.9);if(key==="-")actions.current.zoom(doc.canvas.viewport.scale*.9);
    };
    const up=(e:KeyboardEvent)=>{if(e.code==="Space"){spaceRef.current=false;setSpace(false);}};
    const paste=(e:ClipboardEvent)=>{if(latest.current.hidden||editable(e.target)||!host.current?.contains(e.target as Node))return;const files=Array.from(e.clipboardData?.items??[]).filter(i=>i.type.startsWith("image/")).map(i=>i.getAsFile()).filter((f):f is File=>!!f);if(files.length){e.preventDefault();actions.current.onImport(files);}};
    window.addEventListener("keydown",down);window.addEventListener("keyup",up);window.addEventListener("paste",paste);return()=>{window.removeEventListener("keydown",down);window.removeEventListener("keyup",up);window.removeEventListener("paste",paste);};
  },[]);
  const begin=(e:Konva.KonvaEventObject<MouseEvent>)=>{
    if(gestureRef.current||e.evt.button!==0)return;host.current?.focus();e.evt.preventDefault();
    const v=doc.canvas.viewport,point=stage.current!.getPointerPosition()!;
    const base={sx:e.evt.clientX,sy:e.evt.clientY,dx:0,dy:0,scale:v.scale,vx:v.x,vy:v.y,wx:(point.x-v.x)/v.scale,wy:(point.y-v.y)/v.scale,ids:[...ids],add:e.evt.shiftKey||e.evt.ctrlKey||e.evt.metaKey};
    let target:Konva.Node|null=e.target;while(target&&!target.getAttr("objectId")&&!target.getAttr("resizeId"))target=target.getParent();
    const resizeId=target?.getAttr("resizeId") as string|undefined,id=target?.getAttr("objectId") as string|undefined;
    if(resizeId){const o=basicObjects(doc).find(o=>o.id===resizeId)!;start({...base,kind:"resize",ids:[resizeId],width:o.width,height:o.height});return;}
    if(tool!=="select"&&tool!=="pan"){
      const common={id:`annotation_${crypto.randomUUID()}` as const,x:base.wx,y:base.wy,color};
      if(tool==="text"){const a:AnnotationState={...common,type:"text",text:"文字批注",width:300,fontSize:24};const n=annotationNode(a);update(d=>{d.canvas.nodes.push(n);d.simple!.selectedIds=[n.id];return d;},true);setEditor({id:n.id,text:a.text,kind:"annotation"});setTool("select");return;}
      const a:AnnotationState=tool==="rectangle"?{...common,type:tool,width:0,height:0}:{...common,type:tool,points:[0,0]};start({...base,kind:"draw",annotation:a});return;
    }
    if(id){if(base.add){select(ids.includes(id)?ids.filter(i=>i!==id):[...ids,id]);return;}const selected=ids.includes(id)?ids:[id];if(!ids.includes(id))select(selected);start({...base,kind:"move",ids:selected});}
    else start({...base,kind:"marquee"});
  };
  const offset=(id:string)=>gesture?.kind==="move"&&gesture.ids.includes(id)&&!objectMap.get(id)?.locked?{x:gesture.dx/gesture.scale,y:gesture.dy/gesture.scale}:{x:0,y:0};
  const visible=(o:{x:number;y:number;width:number;height:number})=>o.x*viewport.scale+viewport.x+o.width*viewport.scale>-200&&o.y*viewport.scale+viewport.y+o.height*viewport.scale>-200&&o.x*viewport.scale+viewport.x<size.width+200&&o.y*viewport.scale+viewport.y<size.height+200;
  const objects=basicObjects(doc);const objectMap=new Map(objects.map(o=>[o.id,o]));const single=ids.length===1?doc.canvas.nodes.find(n=>n.id===ids[0]):undefined;
  const download=async()=>{if(single?.type!=="image")return;const asset=doc.versions.find(v=>v.id===single.payload.imageVersionId)!.assetId;const url=await readCanvasAssetAsObjectUrl(asset,"original");try{const a=document.createElement("a");a.href=url;a.download=String(single.payload.name??"图片.png");a.click();}finally{setTimeout(()=>releaseCanvasAssetObjectUrl(url),1000);}};
  return <div ref={host} className="sg-stage" tabIndex={0} aria-label="图片画布，空白处拖框选择，中键或空格拖动平移，滚轮缩放" data-basic-canvas="true" data-pan={gesture?.kind==="pan"||undefined} style={{cursor:gesture?.kind==="pan"?"grabbing":space||tool==="pan"?"grab":tool!=="select"?"crosshair":"default"}}
    onMouseDownCapture={e=>{if(!(e.target instanceof HTMLCanvasElement)||!basicPanRequested(e.button,tool,spaceRef.current))return;e.preventDefault();e.stopPropagation();host.current?.focus();const v=doc.canvas.viewport;start({kind:"pan",sx:e.clientX,sy:e.clientY,dx:0,dy:0,scale:v.scale,vx:v.x,vy:v.y,wx:0,wy:0,ids:[],add:false});}}
    onAuxClick={e=>{if(e.button===1)e.preventDefault();}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();onImport(Array.from(e.dataTransfer.files));}}>
    <div className="sg-canvas-tools" role="toolbar" aria-label="画布基础工具">
      {([["select","选择 V"],["pan","平移 H"],["text","文字 T"],["arrow","箭头 A"],["freehand","画笔 P"],["rectangle","矩形 R"]] as const).map(([t,label])=><button key={t} aria-pressed={tool===t} onClick={()=>{setTool(t);host.current?.focus();}}>{label}</button>)}
      <input type="color" aria-label="批注颜色" value={color} onChange={e=>{setColor(e.target.value);update(d=>{for(const n of d.canvas.nodes)if(ids.includes(n.id)&&n.payload.annotation&&!n.locked)(n.payload.annotation as AnnotationState).color=e.target.value;return d;},true);}}/>
      <button disabled={!canUndo} onClick={()=>undo()}>撤销</button><button disabled={!canRedo} onClick={()=>undo(true)}>重做</button><button onClick={fit}>适合画面</button>
      <details><summary>整理 / 操作</summary><div>{([['horizontal','横向排列'],['vertical','纵向排列'],['grid','自动排版']] as const).map(([d,label])=><button key={d} onClick={()=>update(doc=>arrangeBasicObjects(doc,ids,d),true)}>{label}</button>)}<button onClick={()=>select(objects.map(o=>o.id))}>全选</button><button onClick={()=>select([])}>取消选择</button><button disabled={!ids.length} onClick={()=>update(d=>deleteBasicObjects(d,ids),true)}>删除所选</button><button disabled={!ids.length} onClick={()=>update(d=>{const nodes=d.canvas.nodes.filter(n=>ids.includes(n.id));const lock=!nodes.every(n=>n.locked);nodes.forEach(n=>n.locked=lock);return d;},true)}>锁定 / 解锁</button></div></details>
    </div>
    {!objects.length&&<div className="sg-canvas-empty"><h2>把图片放在这里</h2><p>拖入图片，或使用顶部导入按钮。也支持 Ctrl+V 粘贴图片。</p></div>}
    <Stage ref={stage} width={size.width} height={size.height} x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={viewport.scale} onMouseDown={begin} onWheel={e=>{e.evt.preventDefault();if(!gestureRef.current)zoom(viewport.scale*(e.evt.deltaY>0?.9:1/.9),stage.current!.getPointerPosition()!);}} onDblClick={e=>{let target:Konva.Node|null=e.target;while(target&&!target.getAttr("objectId"))target=target.getParent();const id=target?.getAttr("objectId");const n=doc.canvas.nodes.find(n=>n.id===id);if(n?.type==="image"){onPreview(doc.versions.find(v=>v.id===n.payload.imageVersionId)!.assetId,String(n.payload.name));}else if(n?.type==="text")setEditor({id:n.id,text:(n.payload.annotation as AnnotationState&{text:string}).text,kind:"annotation"});else if(id?.startsWith("text_card_"))onEditText(id);}}>
      <Layer listening={false}>{doc.canvas.nodes.filter(n=>n.type==="image"&&visible(n)).map(n=>{const v=doc.versions.find(v=>v.id===n.payload.imageVersionId);const p=doc.canvas.nodes.find(n=>n.payload.imageVersionId===v?.parentVersionId);return p?<Line key={n.id} points={buildCanvasRelation(p,n).points} bezier stroke="#a8b1a4" strokeWidth={1.5}/>:null;})}{children}</Layer>
      <Layer>{doc.canvas.nodes.filter(n=>n.visible!==false&&(visible(n)||ids.includes(n.id))).map(n=>{const shift=offset(n.id);let node=n;if(gesture?.kind==="resize"&&gesture.ids[0]===n.id){const d=resizeBasicObject(structuredClone(doc),n.id,gesture.width!+gesture.dx/gesture.scale,gesture.height!+gesture.dy/gesture.scale);node=d.canvas.nodes.find(o=>o.id===n.id)!;}const a=node.payload.annotation as AnnotationState|undefined;const v=doc.versions.find(v=>v.id===node.payload.imageVersionId);return <Group key={n.id} objectId={n.id} x={(a?.x??node.x)+shift.x} y={(a?.y??node.y)+shift.y}>{a?<Mark a={a}/>:v?<Bitmap node={node} assetId={v.assetId}/>:null}</Group>;})}
        {doc.workflow?.textCards.filter(c=>visible(c)||ids.includes(c.id)).map(c=>{const shift=offset(c.id),g=gesture?.kind==="resize"&&gesture.ids[0]===c.id?gesture:null;const width=g?Math.max(320,c.width+g.dx/g.scale):c.width,height=g?Math.max(240,c.height+g.dy/g.scale):c.height;return <Group key={c.id} objectId={c.id} x={c.x+shift.x} y={c.y+shift.y}><Rect width={width} height={height} fill="#faf7ec" stroke="#d5ccae"/><Text x={16} y={16} width={width-32} text={c.title} fontSize={18} fill="#4d5146"/><Text x={16} y={50} width={width-32} height={height-66} text={c.text} fontSize={14} fill="#51584c"/></Group>;})}
        {objects.filter(o=>ids.includes(o.id)).map(o=>{const shift=offset(o.id);return <Group key={o.id} x={o.x+shift.x} y={o.y+shift.y}><Rect width={Math.max(1,o.width)} height={Math.max(1,o.height)} stroke="#425c48" strokeWidth={2/viewport.scale} listening={false}/>{!o.locked&&!gesture&&<Rect resizeId={o.id} x={o.width-5/viewport.scale} y={o.height-5/viewport.scale} width={10/viewport.scale} height={10/viewport.scale} fill="#425c48" stroke="white" strokeWidth={1/viewport.scale}/>}</Group>;})}
        {gesture?.kind==="draw"&&gesture.annotation&&<Group x={gesture.annotation.x} y={gesture.annotation.y} listening={false}><Mark a={gesture.annotation}/></Group>}
        {gesture?.kind==="marquee"&&<Rect x={Math.min(gesture.wx,gesture.wx+gesture.dx/gesture.scale)} y={Math.min(gesture.wy,gesture.wy+gesture.dy/gesture.scale)} width={Math.abs(gesture.dx/gesture.scale)} height={Math.abs(gesture.dy/gesture.scale)} fill="rgba(71,103,72,.12)" stroke="#476748" strokeWidth={1/viewport.scale} listening={false}/>}
      </Layer>
    </Stage>
    {single?.type==="image"&&<div className="sg-basic-image-tools" role="toolbar" aria-label="图片基础操作"><button onClick={()=>setEditor({id:single.id,text:String(single.payload.name??"图片"),kind:"name"})}>重命名</button><button onClick={()=>void download()}>下载原图</button><button onClick={()=>update(d=>resizeBasicObject(d,single.id,single.width*.8,single.height*.8),true)}>缩小图片</button><button onClick={()=>update(d=>resizeBasicObject(d,single.id,single.width*1.25,single.height*1.25),true)}>放大图片</button><select aria-label="图片框比例" value={String(single.payload.outputRatio??"free")} onChange={e=>{const ratio=e.target.value;update(d=>{const n=d.canvas.nodes.find(n=>n.id===single.id)!;if(n.locked)return d;const a=d.assets.find(a=>a.id===d.versions.find(v=>v.id===n.payload.imageVersionId)?.assetId)!;n.payload.outputRatio=ratio;n.payload.fit=ratio==="free"?"contain":"cover";const parts=ratio.split(':').map(Number);n.height=n.width/(ratio==="free"?a.original.width/a.original.height:parts[0]!/parts[1]!);return d;},true);}}>{['free','1:1','4:3','3:2','16:9'].map(r=><option key={r} value={r}>{r==="free"?'原始比例':r}</option>)}</select></div>}
    <div className="sg-canvas-bottom"><button aria-label="缩小画布" onClick={()=>zoom(viewport.scale*.9)}>−</button><button aria-label="恢复百分之百" onClick={()=>zoom(1)}>{Math.round(viewport.scale*100)}%</button><button aria-label="放大画布" onClick={()=>zoom(viewport.scale/.9)}>＋</button><span>中键 / 空格平移 · 滚轮缩放 · 双击编辑 / 看原图</span><details><summary>对象列表（{objects.length}）</summary><div>{objects.map(o=><button key={o.id} aria-pressed={ids.includes(o.id)} onClick={()=>{select([o.id]);host.current?.focus();}}>{String(doc.canvas.nodes.find(n=>n.id===o.id)?.payload.name??doc.workflow?.textCards.find(c=>c.id===o.id)?.title??'批注')}</button>)}</div></details></div>
    {editor&&<div className="sg-basic-editor" role="dialog" aria-modal="true" aria-label={editor.kind==="name"?"图片重命名":"编辑文字批注"}><label>{editor.kind==="name"?"图片名称":"文字内容"}<textarea autoFocus value={editor.text} maxLength={editor.kind==="name"?200:20000} onChange={e=>setEditor({...editor,text:e.target.value})}/></label><button onClick={()=>{update(d=>{const n=d.canvas.nodes.find(n=>n.id===editor.id);if(n&&!n.locked){if(editor.kind==="name")n.payload.name=editor.text;else(n.payload.annotation as AnnotationState&{text:string}).text=editor.text;}return d;},true);setEditor(null);host.current?.focus();}}>保存</button><button onClick={()=>setEditor(null)}>取消</button></div>}
  </div>;
}


