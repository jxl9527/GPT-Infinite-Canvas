import test from "node:test";
import assert from "node:assert/strict";
import { annotationNode, arrangeBasicObjects, basicObjects, basicPanRequested, deleteBasicObjects, moveBasicObjects, resizeBasicObject, selectBasicRect } from "../src/basic-canvas-model.js";
import { EMPTY_CANVAS_WORKFLOW, type CanvasProjectDocument } from "../src/project-state.js";

function fixture():CanvasProjectDocument {
  const annotation=annotationNode({id:"annotation_test",type:"rectangle",x:500,y:0,width:80,height:60,color:"red"});
  annotation.id="node_mark";
  return {schemaVersion:"2.0",projectId:"project_test",title:"test",createdAt:"now",updatedAt:"now",revision:0,
    canvas:{viewport:{x:0,y:0,scale:1},nodes:[{id:"node_image",type:"image",x:0,y:0,width:200,height:150,rotation:0,scaleX:1,scaleY:1,zIndex:0,locked:false,visible:true,payload:{imageVersionId:"version_test"}},annotation]},
    assets:[],versions:[{id:"version_test",assetId:"asset_test",parentVersionId:null,origin:"imported",taskId:null,createdAt:"now"}],taskLinks:[],
    workflow:{...structuredClone(EMPTY_CANVAS_WORKFLOW),textCards:[{id:"text_card_test",kind:"prompt",title:"note",text:"原文",x:240,y:0,width:320,height:240,sourceVersionId:"version_test",taskId:"task_test",createdAt:"now",updatedAt:"now"}]},
    simple:{draft:"不改渲染",concurrency:2,selectedIds:[],batch:null}};
}
test("基础画布所有工具中键均优先漫游，右键不会起框或拖动",()=>{
  for(const tool of ["select","pan","text","arrow","freehand","rectangle"] as const)assert.equal(basicPanRequested(1,tool,false),true);
  assert.equal(basicPanRequested(0,"select",true),true);assert.equal(basicPanRequested(0,"pan",false),true);
  assert.equal(basicPanRequested(2,"pan",true),false);assert.equal(basicPanRequested(0,"select",false),false);
});
test("反向混合框选包含图片文字卡批注，整体移动同步批注坐标并保留锁定项",()=>{
  const d=fixture(),ids=selectBasicRect(d,600,300,-10,-10);assert.equal(ids.length,3);
  const frozen=structuredClone(d.versions);const prompt=d.simple!.draft;
  d.canvas.nodes[0]!.locked=true;moveBasicObjects(d,ids,30,40);
  assert.equal(d.canvas.nodes[0]!.x,0);assert.equal(d.canvas.nodes[1]!.x,530);
  assert.equal((d.canvas.nodes[1]!.payload.annotation as {x:number}).x,530);assert.equal(d.workflow!.textCards[0]!.x,270);
  assert.deepEqual(d.versions,frozen);assert.equal(d.simple!.draft,prompt);
});
test("基础删除仅移除未锁定对象，不删除资产版本和任务关系",()=>{
  const d=fixture();d.canvas.nodes[0]!.locked=true;const before=structuredClone(d);
  deleteBasicObjects(d,basicObjects(d).map(o=>o.id));assert.equal(d.canvas.nodes.length,1);assert.equal(d.workflow!.textCards.length,0);
  assert.deepEqual(d.assets,before.assets);assert.deepEqual(d.versions,before.versions);assert.deepEqual(d.taskLinks,before.taskLinks);
});
test("混合横纵整理依据实际尺寸避免重叠，文字卡缩放保留最小可用尺寸",()=>{
  const d=fixture();arrangeBasicObjects(d,[],"vertical");let objects=basicObjects(d);
  for(let i=1;i<objects.length;i++)assert.ok(objects[i]!.y>=objects[i-1]!.y+objects[i-1]!.height+64);
  arrangeBasicObjects(d,[],"horizontal");objects=basicObjects(d);
  for(let i=1;i<objects.length;i++)assert.ok(objects[i]!.x>=objects[i-1]!.x+objects[i-1]!.width+64);
  resizeBasicObject(d,"text_card_test",20,20);assert.equal(d.workflow!.textCards[0]!.width,320);assert.equal(d.workflow!.textCards[0]!.height,240);
  resizeBasicObject(d,"node_mark",160,120);assert.equal(d.canvas.nodes[1]!.width,160);
});

test("自动排版复用旧版父子分栏，保留文字卡归属及锁定对象",()=>{
 const d=fixture();d.assets=[{id:"asset_test",originalName:"原图.png",kind:"imported",createdAt:"now",original:{width:1200,height:800,relativePath:"assets/originals/test.png",mime:"image/png",bytes:100,sha256:"a".repeat(64)}}];
 d.versions.push({...d.versions[0]!,id:"version_child",parentVersionId:"version_test",origin:"generated",taskId:"task_test"});
 d.canvas.nodes.push({...structuredClone(d.canvas.nodes[0]!),id:"node_child",x:-500,payload:{imageVersionId:"version_child"}});
 const before=structuredClone(d);arrangeBasicObjects(d,[],"grid");
 const parent=d.canvas.nodes[0]!,child=d.canvas.nodes.find(n=>n.id==="node_child")!;
 assert.ok(child.x>=parent.x+parent.width);assert.equal(d.workflow!.textCards[0]!.sourceVersionId,"version_test");
 assert.deepEqual(d.versions,before.versions);assert.deepEqual(d.canvas.nodes[1],before.canvas.nodes[1]);
 parent.locked=true;const frozen=structuredClone(parent);arrangeBasicObjects(d,[],"grid");assert.deepEqual(parent,frozen);
});
