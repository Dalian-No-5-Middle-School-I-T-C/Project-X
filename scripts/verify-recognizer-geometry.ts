import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import {createDefaultCard} from "../src/shared/defaultCard";
import {buildLayout} from "../src/shared/layout";
import {qrDarkRects} from "../src/shared/cardIdentity";
import {recognizeAnswerCard} from "../src/apps/answer-card/server/recognition";
import type {CombinedRecognitionResult,Rect} from "../src/shared/types";

const dir = await mkdtemp(path.join(os.tmpdir(),"projectx-geometry-"));
try {
  const card = createDefaultCard("91514003"); card.studentInfo.studentNumberDigits=5;
  card.bodyBlocks=[{id:"geometry",type:"objective",title:"geometry",questionStart:1,questionCount:1,optionCount:4,mode:"single",scorePerQuestion:5,density:"normal",answerKey:{1:["A"]}}];
  const layout=buildLayout(card),page=layout.pages[0],dpi=300;
  const box=(r:Rect,fill:string,stroke=0)=>`<rect x="${r.x}" y="${r.y*1.02-2}" width="${r.width}" height="${r.height*1.02}" fill="${fill}" stroke="#111" stroke-width="${stroke}"/>`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}"><rect width="100%" height="100%" fill="white"/>${page.markers.map(m=>box(m.rect,"black")).join("")}${qrDarkRects(page.header.qrCode).map(r=>box(r,"black")).join("")}${page.elements.flatMap(e=>e.type==="student_digit"?[box(e.rect,Number("12345"[e.digitIndex])===e.digit?"black":"white",.15)]:e.type==="objective_option"?[box(e.rect,e.option==="A"?"black":"white",.15)]:[]).join("")}</svg>`;
  const width=Math.round(page.width/25.4*dpi),height=Math.round(page.height/25.4*dpi);
  const base=await sharp(Buffer.from(svg)).resize(width,height).png().toBuffer();
  const layoutPath=path.join(dir,"layout.json");await writeFile(layoutPath,JSON.stringify(layout));
  for(const angle of [0,90,180,270]) {
    const imagePath=path.join(dir,`rotation-${angle}.png`);await sharp(base).rotate(angle).png().toFile(imagePath);
    const result=await recognizeAnswerCard({imagePath,layoutPath,pageNumber:1,dpi}) as CombinedRecognitionResult;
    assert.notEqual(result.status,"failed",result.message);assert.equal(result.studentId?.value,"12345");assert.deepEqual(result.questions[0].selectedOptions,["A"]);
    const geometry=result.geometry!;assert(geometry,"native output must include mapping");
    assert.equal(geometry.imageWidth,angle%180?height:width);assert.equal(geometry.imageHeight,angle%180?width:height);
    const project=(m:number[],x:number,y:number)=>{const z=m[6]*x+m[7]*y+m[8];return [(m[0]*x+m[1]*y+m[2])/z,(m[3]*x+m[4]*y+m[5])/z];};
    for(const e of page.elements.filter(e=>e.type==="student_digit"||e.type==="objective_option")) {
      const x=e.rect.x+e.rect.width/2,y=e.rect.y+e.rect.height/2;
      const px=x*width/page.width,py=(y*1.02-2)*height/page.height;
      const expected=angle===90?[height-1-py,px]:angle===180?[width-1-px,height-1-py]:angle===270?[py,width-1-px]:[px,py];
      const actual=project(geometry.layoutToImage,x,y);
      assert(Math.hypot(actual[0]-expected[0],actual[1]-expected[1])<5,`rotation ${angle}: ${e.id} must align within 5px`);
      const inverse=project(geometry.imageToLayout,...actual as [number,number]);
      assert(Math.hypot(inverse[0]-x,inverse[1]-y)<.001,"inverse returns layout millimetres");
    }
    console.log(`PASS native geometry ${angle} degrees: original-image mapping, inverse and recognized marks`);
  }
} finally {await rm(dir,{recursive:true,force:true});}
