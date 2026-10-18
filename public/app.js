import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const $ = id => document.getElementById(id);
const stage = $('stage');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
camera.position.set(3, 2, 5);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
stage.prepend(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xdde8ff, 0x33313a, 2));
const keyLight = new THREE.DirectionalLight(0xffffff, 3); keyLight.position.set(4, 8, 5); scene.add(keyLight);
const fill = new THREE.DirectionalLight(0x89aaff, 1.5); fill.position.set(-5, 3, -4); scene.add(fill);
scene.add(new THREE.GridHelper(10, 20, 0x35445c, 0x202a3a));
const orbit = new OrbitControls(camera, renderer.domElement); orbit.enableDamping = true; orbit.target.set(0, 0, 0);

let root = null, mixer = null, clips = [], clipAction = null, bones = [], original = new Map();
let objectUrls = [], generated = null, generatedPlaying = false, generatedStarted = false, generatedTime = 0, generatedSpeed = 1;
let lastFrame = performance.now(), clipPlaying = false, modelHeight = 1.7, baseRootPosition = new THREE.Vector3();
let transitionPose = new Map(), transitionRootPosition = new THREE.Vector3(), transitionElapsed = 0, commandHistory = [];

function status(message, error=false) { $('aiStatus').textContent = message; $('aiStatus').classList.toggle('error', error); }
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  camera.aspect = Math.max(w,1) / Math.max(h,1); camera.updateProjectionMatrix();
  renderer.setSize(w,h,false);
}
new ResizeObserver(resize).observe(stage); resize();

async function checkServer() {
  try {
    const r = await fetch('/api/health'); const d = await r.json();
    $('serverDot').classList.toggle('ok', r.ok && d.configured);
    $('serverStatus').textContent = d.configured ? `السيرفر متصل • ${d.model}` : 'السيرفر يعمل لكن مفتاح Groq غير مضبوط';
    $('keyStatus').textContent = d.configured ? 'يوجد مفتاح مضبوط في ذاكرة السيرفر.' : 'أدخل مفتاح Groq أدناه. لن يُكتب في ملفات المشروع.';
    $('keyStatus').classList.remove('error');
  } catch {
    $('serverStatus').textContent = 'شغّل السيرفر محليًا أولًا';
    $('keyStatus').textContent = 'لا يوجد اتصال بالسيرفر. شغّله من Terminal داخل Acode.';
    $('keyStatus').classList.add('error');
  }
}
checkServer();

$('saveApiKey').addEventListener('click', async () => {
  const apiKey = $('apiKeyInput').value.trim();
  if (!apiKey) {
    $('keyStatus').textContent = 'الصق مفتاح API أولًا.';
    $('keyStatus').classList.add('error');
    return;
  }
  $('saveApiKey').disabled = true;
  $('keyStatus').textContent = 'جارٍ إرسال المفتاح إلى السيرفر المحلي…';
  try {
    const r = await fetch('/api/settings/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'تعذر حفظ المفتاح.');
    $('apiKeyInput').value = '';
    $('keyStatus').textContent = 'تم ضبط المفتاح في ذاكرة السيرفر فقط. لن يظهر مرة أخرى في الحقل.';
    $('keyStatus').classList.remove('error');
    await checkServer();
  } catch (e) {
    $('keyStatus').textContent = e.message || 'تعذر الاتصال بالسيرفر.';
    $('keyStatus').classList.add('error');
  } finally {
    $('saveApiKey').disabled = false;
  }
});
$('clearApiKey').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/settings/key', { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'تعذر مسح المفتاح.');
    $('apiKeyInput').value = '';
    $('keyStatus').textContent = 'تم مسح المفتاح من ذاكرة السيرفر.';
    await checkServer();
  } catch (e) {
    $('keyStatus').textContent = e.message || 'تعذر الاتصال بالسيرفر.';
    $('keyStatus').classList.add('error');
  }
});

function disposeModel() {
  if (root) {
    scene.remove(root);
    root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
        for (const value of Object.values(m)) if (value?.isTexture) value.dispose();
        m.dispose();
      });
    });
  }
  objectUrls.forEach(URL.revokeObjectURL); objectUrls=[];
  root=null; mixer=null; clips=[]; clipAction=null; bones=[]; original.clear(); generated=null; generatedPlaying=false; generatedStarted=false; generatedTime=0; clipPlaying=false; commandHistory=[]; transitionPose.clear();
}
function frameModel(obj) {
  const bounds = new THREE.Box3().setFromObject(obj);
  if (bounds.isEmpty()) return;
  const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  modelHeight = Math.max(size.y, size.x, size.z, 0.1);
  obj.position.sub(center);
  const max = Math.max(size.x,size.y,size.z,0.1);
  camera.position.set(max*1.5,max*0.8,max*1.8);
  camera.near = max/1000; camera.far = max*100; camera.updateProjectionMatrix();
  orbit.target.set(0,0,0); orbit.update();
}
function setupModel(obj, animations, filename) {
  disposeModel(); root=obj; scene.add(root); clips=animations || [];
  frameModel(root); baseRootPosition.copy(root.position);
  root.traverse(o => { if (o.isBone) { bones.push(o); original.set(o,o.rotation.clone()); } });
  $('boneCount').textContent = bones.length;
  $('clipCount').textContent = clips.length;
  $('fileStatus').textContent = `${filename} — تم التحميل`;
  $('emptyScene').style.display = 'none';
  $('generateBtn').disabled = bones.length === 0;
  status(bones.length ? 'اكتب وصفًا للحركة باللغة العربية ثم اضغط إنشاء.' : 'تم تحميل المجسم، لكن لم يتم العثور على Rig يحتوي على عظام.', !bones.length);
  $('clips').innerHTML = '';
  if (clips.length) {
    clips.forEach((c,i) => { const op=document.createElement('option'); op.value=i; op.textContent=c.name || `Animation ${i+1}`; $('clips').append(op); });
    $('clips').disabled=false; $('playClip').disabled=false; $('stopClip').disabled=false;
    mixer=new THREE.AnimationMixer(root); clipAction=mixer.clipAction(clips[0]); clipAction.play(); clipPlaying=true;
  } else {
    $('clips').innerHTML='<option>لا توجد حركات مضمّنة</option>'; $('clips').disabled=true;
    $('playClip').disabled=true; $('stopClip').disabled=true;
  }
}
function loadFile(file) {
  if (!file) return;
  const ext=file.name.split('.').pop().toLowerCase();
  $('fileStatus').textContent='جارٍ تحميل الملف…';
  if (ext==='glb' || ext==='gltf') {
    const url=URL.createObjectURL(file); objectUrls.push(url);
    new GLTFLoader().load(url, g => setupModel(g.scene || g.scenes[0],g.animations,file.name), undefined, err => {
      console.error(err); $('fileStatus').textContent='فشل التحميل. جرّب GLB، خصوصًا إذا كان GLTF يعتمد على ملفات خارجية.';
    });
  } else if (ext==='fbx') {
    const url=URL.createObjectURL(file); objectUrls.push(url);
    new FBXLoader().load(url, obj => setupModel(obj,obj.animations,file.name), undefined, err => {
      console.error(err); $('fileStatus').textContent='فشل تحميل FBX. جرّب إعادة تصديره.';
    });
  } else $('fileStatus').textContent='الصيغ المدعومة: GLB وGLTF وFBX.';
}
$('fileInput').addEventListener('change', e => loadFile(e.target.files[0]));
document.querySelectorAll('.example').forEach(b => b.addEventListener('click', () => $('prompt').value=b.dataset.prompt));

$('generateBtn').addEventListener('click', async () => {
  if (!root || !bones.length) return;
  const prompt=$('prompt').value.trim();
  if (!prompt) { status('اكتب وصف الحركة أولًا.',true); return; }
  $('generateBtn').disabled=true; $('generateBtn').textContent='جارٍ إنشاء الحركة…';
  $('motionResult').hidden=true; status('Groq يحوّل وصفك إلى مفاتيح حركة…');
  try {
    const response=await fetch('/api/motion',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt,history:commandHistory.slice(-5),bones:bones.map(b=>({name:b.name,parent:b.parent?.isBone ? b.parent.name : null})).filter(b=>b.name)})
    });
    const data=await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر إنشاء الحركة.');
    // Keep the current pose until playback starts, so the transition can blend smoothly.
    generated=data; generatedPlaying=false; generatedStarted=false; generatedTime=0;
    if (clipAction) { clipAction.stop(); clipPlaying=false; }
    commandHistory.push(prompt); commandHistory=commandHistory.slice(-5);
    $('motionTitle').textContent=data.title;
    $('motionExplanation').textContent=data.explanation;
    $('motionMeta').textContent=`المدة ${data.duration.toFixed(1)} ثانية • ${new Set(data.keyframes.map(k=>k.bone)).size} عظمة • ${data.rootMotion?.length ? 'حركة انتقالية مفعّلة' : 'حركة في المكان'}`;
    $('motionResult').hidden=false;
    $('playMotion').textContent='▶ تشغيل الحركة';
    status('تم إنشاء الحركة. اضغط تشغيل لمعاينتها.');
  } catch (err) { status(err.message || 'حدث خطأ غير متوقع.',true); }
  finally { $('generateBtn').disabled=!bones.length; $('generateBtn').textContent='✦ أنشئ الحركة بالذكاء الاصطناعي'; }
});

function startGenerated() {
  if (!generated) return;
  if (clipAction) { clipAction.stop(); clipPlaying=false; }
  transitionPose = new Map(bones.map(b => [b, b.rotation.clone()]));
  transitionRootPosition.copy(root.position);
  transitionElapsed=0; generatedTime=0; generatedStarted=true; generatedPlaying=true;
  $('playMotion').textContent='❚❚ إيقاف مؤقت';
}
function stopGenerated() {
  generatedPlaying=false; generatedStarted=false; generatedTime=0;
  bones.forEach(b => { const r=original.get(b); if(r)b.rotation.copy(r); });
  if(root) root.position.copy(baseRootPosition);
  $('playMotion').textContent='▶ تشغيل الحركة';
}
$('playMotion').addEventListener('click', () => {
  if (!generated) return;
  if (generatedPlaying) { generatedPlaying=false; $('playMotion').textContent='▶ متابعة الحركة'; }
  else if (generatedTime>0 && generatedTime < generated.duration) { generatedPlaying=true; $('playMotion').textContent='❚❚ إيقاف مؤقت'; }
  else startGenerated();
});
$('stopMotion').addEventListener('click',stopGenerated);
$('motionSpeed').addEventListener('input',e=>{generatedSpeed=Number(e.target.value);$('speedLabel').textContent=generatedSpeed.toFixed(2)+'×';});
$('clips').addEventListener('change',()=>{
  if (!mixer) return;
  if (clipAction) clipAction.stop();
  clipAction=mixer.clipAction(clips[Number($('clips').value)]); clipAction.reset().play(); clipPlaying=true;
  generatedPlaying=false;
});
$('playClip').addEventListener('click',()=>{
  if (!clipAction) return;
  if (clipPlaying) { clipAction.paused=true; clipPlaying=false; $('playClip').textContent='▶ متابعة الأصلية'; }
  else { clipAction.paused=false; clipPlaying=true; $('playClip').textContent='❚❚ إيقاف مؤقت'; }
});
$('stopClip').addEventListener('click',()=>{
  if(clipAction) clipAction.stop(); clipPlaying=false;
  if(root) bones.forEach(b=>{const r=original.get(b);if(r)b.rotation.copy(r);});
});
function sampleTimedFrames(frames, t, valueKey) {
  if (!frames?.length) return null;
  const sorted = [...frames].sort((a,b)=>a.time-b.time);
  if (t <= sorted[0].time) return sorted[0][valueKey];
  if (t >= sorted[sorted.length-1].time) return sorted[sorted.length-1][valueKey];
  for (let i=0;i<sorted.length-1;i++) {
    const left=sorted[i], right=sorted[i+1];
    if (t < left.time || t > right.time) continue;
    let u=right.time===left.time ? 1 : THREE.MathUtils.clamp((t-left.time)/(right.time-left.time),0,1);
    u=u*u*(3-2*u);
    const a=left[valueKey], b=right[valueKey];
    return {x:THREE.MathUtils.lerp(a.x,b.x,u),y:THREE.MathUtils.lerp(a.y,b.y,u),z:THREE.MathUtils.lerp(a.z,b.z,u)};
  }
  return sorted[sorted.length-1][valueKey];
}
function animateGenerated(dt) {
  if (!generated || !root || !generatedStarted) return;
  if (generatedPlaying) {
    generatedTime += dt * generatedSpeed;
    transitionElapsed += dt;
    if (generatedTime >= generated.duration) {
      generatedTime = generated.duration; generatedPlaying=false;
      $('playMotion').textContent='↻ إعادة التشغيل';
    }
  }
  const t=generatedTime;
  const grouped=new Map();
  for (const frame of generated.keyframes || []) {
    if(!grouped.has(frame.bone)) grouped.set(frame.bone,[]);
    grouped.get(frame.bone).push(frame);
  }
  const blend=THREE.MathUtils.smoothstep(transitionElapsed,0,0.32);
  for (const [name, frames] of grouped) {
    const bone=bones.find(b=>b.name===name); if(!bone) continue;
    const offset=sampleTimedFrames(frames,t,'rotation');
    if(!offset) continue;
    const rest=original.get(bone) || new THREE.Euler();
    const target=new THREE.Euler(
      rest.x+THREE.MathUtils.degToRad(offset.x),
      rest.y+THREE.MathUtils.degToRad(offset.y),
      rest.z+THREE.MathUtils.degToRad(offset.z),
      bone.rotation.order
    );
    const from=transitionPose.get(bone) || rest;
    bone.rotation.set(
      THREE.MathUtils.lerp(from.x,target.x,blend),
      THREE.MathUtils.lerp(from.y,target.y,blend),
      THREE.MathUtils.lerp(from.z,target.z,blend),
      bone.rotation.order
    );
  }
  for (const bone of bones) {
    if(grouped.has(bone.name)) continue;
    const rest=original.get(bone); if(!rest) continue;
    const from=transitionPose.get(bone) || bone.rotation;
    bone.rotation.set(
      THREE.MathUtils.lerp(from.x,rest.x,blend),
      THREE.MathUtils.lerp(from.y,rest.y,blend),
      THREE.MathUtils.lerp(from.z,rest.z,blend),
      bone.rotation.order
    );
  }
  const rootFrames=generated.rootMotion || [];
  const offset=sampleTimedFrames(rootFrames,t,'position');
  if(offset) {
    const target=baseRootPosition.clone().add(new THREE.Vector3(offset.x,offset.y,offset.z).multiplyScalar(modelHeight));
    root.position.lerpVectors(transitionRootPosition,target,blend);
  } else {
    root.position.lerpVectors(transitionRootPosition,baseRootPosition,blend);
  }
}
function animate(now) {
  requestAnimationFrame(animate);
  const dt=Math.min((now-lastFrame)/1000,0.05); lastFrame=now;
  if (mixer && clipPlaying && !generatedPlaying) mixer.update(dt);
  if (generated) animateGenerated(dt);
  orbit.update(); renderer.render(scene,camera);
}
requestAnimationFrame(animate);

const dropHint=$('dropHint');
stage.addEventListener('dragover',e=>{e.preventDefault();dropHint.style.display='grid';});
stage.addEventListener('dragleave',e=>{if(!stage.contains(e.relatedTarget))dropHint.style.display='none';});
stage.addEventListener('drop',e=>{e.preventDefault();dropHint.style.display='none';if(e.dataTransfer.files[0])loadFile(e.dataTransfer.files[0]);});
