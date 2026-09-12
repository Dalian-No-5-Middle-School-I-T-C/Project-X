import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {recognitionPayload,readableCrops,verifyScores,waitForScores,acceptRepeatCompletion} from './protocol.mjs';

const students=[{id:1},{id:2}], expected=[20,15];
const png=await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer();
test('recognition envelope is unwrapped and crop bytes are not sent as grading fields',()=>{
  const payload=recognitionPayload({data:{studentId:{value:'001'},questions:[{}],cropImages:[{dataBase64:'large'}]}});
  assert.equal(payload.studentId.value,'001');assert(!('cropImages' in payload));assert.deepEqual(payload.subjectiveQuestions,[]);
});
test('embedded and URL crop protocols both require decodable image bytes',async()=>{
  for(const raw of [{cropImages:[{dataBase64:png.toString('base64')}]},{result:{blockCrops:[{imageUrl:'/crop.png'}]}},{crops:[{url:`data:image/png;base64,${png.toString('base64')}`}]}]) {
    const images=await readableCrops(raw,async url=>{assert.equal(url,'/crop.png');return png;});assert.equal(images[0].width,2);
  }
});
test('empty crops, path-only metadata and invalid image bytes do not pass',async()=>{
  for(const raw of [{},{cropImages:[]},{crops:[{path:'some-file.png'}]},{crops:[{base64:'bm90IGFuIGltYWdl'}]}])await assert.rejects(()=>readableCrops(raw,async()=>png));
});
test('grades accept numeric strings and ordering differences, preserving identity',()=>{
  assert.deepEqual(verifyScores([{student_id:'2',total_score:'15.00'},{studentId:'1',totalScore:'20'}],students,expected),expected);
});
test('swapped students, missing data, duplicates and null scores do not pass',()=>{
  for(const rows of [[],[{student_id:1,total_score:15},{student_id:2,total_score:20}],[{student_id:1,total_score:20},{student_id:1,total_score:15}],[{student_id:1,total_score:null},{student_id:2,total_score:15}]])assert.throws(()=>verifyScores(rows,students,expected));
});
test('asynchronous grades are polled, rather than checked immediately',async()=>{
  let calls=0;const result=await waitForScores(async()=>++calls<3?[]:[{student_id:1,total_score:20},{student_id:2,total_score:15}],students,expected,{timeoutMs:100,intervalMs:1});assert.equal(calls,3);assert.deepEqual(result.scores,expected);
});
test('missing grades time out and database failures propagate',async()=>{
  await assert.rejects(()=>waitForScores(async()=>[],students,expected,{timeoutMs:5,intervalMs:1}),/did not settle/);
  await assert.rejects(()=>waitForScores(async()=>{throw new Error('DB offline');},students,expected),/DB offline/);
});
test('repeat completion accepts conflicts but not generic server errors',()=>{
  for(const status of [200,202,204,409,410])acceptRepeatCompletion(status);
  for(const status of [400,401,403,404,500,503])assert.throws(()=>acceptRepeatCompletion(status));
});
