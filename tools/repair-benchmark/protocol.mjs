import assert from 'node:assert/strict';
import sharp from 'sharp';

// Compatibility at the wire boundary, not substitutes for missing business data.
export function unwrap(value) {
  for (let i=0;i<3 && value && typeof value==='object';i++) {
    const nested=value.data ?? value.result;
    if (!nested || typeof nested!=='object' || Array.isArray(nested)) break;
    value=nested;
  }
  return value;
}

export function recognitionPayload(raw) {
  const value=unwrap(raw);
  const student=value.studentId ?? value.student_id ?? value.studentNumber;
  return {
    status:value.status ?? 'ok',
    studentId:typeof student==='object'?student:{status:'ok',value:String(student ?? '')},
    questions:value.questions ?? value.objectiveQuestions ?? [],
    subjectiveQuestions:value.subjectiveQuestions ?? [],
  };
}

export async function readableCrops(raw, loadUrl) {
  const value=unwrap(raw);
  const crops=value.cropImages ?? value.blockCrops ?? value.crops;
  assert(Array.isArray(crops)&&crops.length>0,'Recognition returned no usable crop collection (cropImages/blockCrops/crops)');
  const output=[];
  for(const crop of crops) {
    const encoded=crop.dataBase64 ?? crop.imageBase64 ?? crop.base64;
    const url=crop.imageUrl ?? crop.url;
    let bytes;
    if(typeof encoded==='string'&&encoded.trim())bytes=Buffer.from(encoded.replace(/^data:image\/[^;]+;base64,/,''),'base64');
    else if(typeof url==='string'&&url.startsWith('data:image/'))bytes=Buffer.from(url.slice(url.indexOf(',')+1),'base64');
    else if(typeof url==='string'&&url)bytes=await loadUrl(url);
    else throw new Error('Crop exists but exposes neither image bytes nor a retrievable URL');
    const metadata=await sharp(bytes).metadata();
    assert(metadata.width>0&&metadata.height>0,'Crop image is empty or undecodable');
    output.push({crop,bytes,width:metadata.width,height:metadata.height});
  }
  return output;
}

export function verifyScores(rows, students, expected) {
  assert.equal(rows.length,students.length,'Exactly one persisted total is required per student');
  const scores=new Map();
  for(const row of rows){const id=String(row.student_id ?? row.studentId);assert(!scores.has(id),'Duplicate student score');assert(row.total_score!==null&&row.totalScore!==null,'Null score');scores.set(id,Number(row.total_score ?? row.totalScore));}
  for(let i=0;i<students.length;i++)assert.equal(scores.get(String(students[i].id)),expected[i],`Wrong persisted score for student ${students[i].id}`);
  return students.map(s=>scores.get(String(s.id)));
}

export async function waitForScores(read, students, expected, {timeoutMs=60000,intervalMs=500}={}) {
  const until=Date.now()+timeoutMs;
  let last;
  do {
    const rows=await read(); // DB/connectivity errors must not become assertion failures.
    try {return {rows,scores:verifyScores(rows,students,expected)};}catch(error){last=error;}
    if(Date.now()>=until)break;
    await new Promise(resolve=>setTimeout(resolve,intervalMs));
  }while(true);
  throw new Error(`Persisted grades did not settle within ${timeoutMs} ms: ${last.message}`);
}

export function acceptRepeatCompletion(status) {
  assert((status>=200&&status<300)||status===409||status===410,`Repeated completion failed: HTTP ${status}`);
}
