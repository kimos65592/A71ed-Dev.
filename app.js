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
let objectUrls = [], generated = null, generatedPlaying = false, generatedTime = 0, generatedSpeed = 1;
let lastFrame = performance.now(), clipPlaying = false;

function status(message, error=false) { $('aiStatus').textContent = message; $('aiStatus').classList.toggle('error', error); }
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  camera.aspect = Math.max(w,1) / Math.max(h,1); camera.updateProjectionMatrix();
  renderer.setSize(w,h,false);
}
new ResizeObserver(resize).observe(stage); resize();

let groqApiKey = '';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
function updateKeyStatus(message, error=false) {
  $('keyStatus').textContent = message;
  $('keyStatus').classList.toggle('error', error);
}
$('serverStatus').textContent = 'جاهز — أدخل مفتاح Groq';
$('serverDot').classList.remove('ok');
$('saveApiKey').addEventListener('click', () => {
  const apiKey = $('apiKeyInput').value.trim();
  if (!apiKey) {
    updateKeyStatus('الصق مفتاح Groq API أولًا.', true);
    return;
  }
  if (!apiKey.startsWith('gsk_')) {
    updateKeyStatus('تأكد أن هذا مفتاح Groq API الصحيح.', true);
    return;
  }
  groqApiKey = apiKey;
  $('apiKeyInput').value = '';
  $('serverDot').classList.add('ok');
  $('serverStatus').textContent = 'مفتاح Groq مفعّل في الصفحة';
  updateKeyStatus('تم تفعيل المفتاح في ذاكرة الصفحة فقط. لن يتم حفظه بعد إغلاق الصفحة أو تحديثها.');
});
$('clearApiKey').addEventListener('click', () => {
  groqApiKey = '';
  $('apiKeyInput').value = '';
  $('serverDot').classList.remove('ok');
  $('serverStatus').textContent = 'جاهز — أدخل مفتاح Groq';
  updateKeyStatus('تم مسح المفتاح من ذاكرة الصفحة.');
});

async function createMotion(prompt, boneNames) {
  if (!groqApiKey) throw new Error('أدخل مفتاح Groq API واضغط «تفعيل المفتاح» أولًا.');
  const boneList = boneNames.map(n => JSON.stringify(n)).join(', ');
  const system = `You are a procedural 3D character animation planner. Convert an Arabic user request into a small, plausible skeletal animation for a Three.js rig.
Return ONLY valid JSON with this exact shape:
{"title":"short Arabic title","explanation":"short Arabic explanation","duration":3.0,"keyframes":[{"time":0,"bone":"EXACT_BONE_NAME","rotation":{"x":0,"y":0,"z":0}}]}
Rules:
- Use ONLY exact bone names from the supplied allowlist. Never invent a bone.
- rotation values are LOCAL Euler angles in DEGREES, offsets from the model's rest rotation, not radians.
- Make a smooth movement with enough keyframes over time; include time 0 and final time key for every bone animated; return to neutral at the end unless a held pose is requested.
- Keep duration between 1 and 10 seconds.
- Keep each axis within -80 to 80 degrees.
- Prefer moving a few relevant bones rather than the whole skeleton. If names are unclear, explain the limitation in Arabic.
- Maximum 90 keyframe entries and 12 distinct bones.
- Never output markdown fences, extra keys, or instructions. JSON only.`;
  const user = `طلب الحركة بالعربية: ${prompt}\nأسماء العظام المسموح بها (استخدم الاسم حرفيًا فقط): [${boneList}]\nأنشئ حركة قابلة للتطبيق على هذه العظام.`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${groqApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.25,
        max_tokens: 3500,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
      }),
      signal: controller.signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('انتهت مهلة الاتصال بـ Groq. حاول مرة أخرى.');
    throw new Error('تعذر الاتصال بـ Groq من المتصفح. تأكد من الإنترنت، وإذا ظهر خطأ CORS فقد لا تسمح الخدمة بالاتصال المباشر من هذه الصفحة.');
  } finally { clearTimeout(timeout); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || '';
    if (response.status === 401) throw new Error('مفتاح Groq غير صحيح أو منتهي الصلاحية.');
    if (response.status === 429) throw new Error('تم تجاوز حد الطلبات أو الرصيد المتاح في Groq. حاول لاحقًا.');
    throw new Error(`فشل Groq (HTTP ${response.status})${msg ? ': ' + msg : ''}`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  let motion;
  try { motion = JSON.parse(content); } catch { throw new Error('أعاد الذكاء الاصطناعي نتيجة غير صالحة. جرّب وصفًا أبسط.'); }
  const allowed = new Set(boneNames);
  const duration = Math.max(1, Math.min(10, Number(motion.duration) || 3));
  const keyframes = (Array.isArray(motion.keyframes) ? motion.keyframes : []).slice(0,90).flatMap(frame => {
    if (!frame || typeof frame.bone !== 'string' || !allowed.has(frame.bone)) return [];
    const time = Number(frame.time), r = frame.rotation || {};
    if (!Number.isFinite(time)) return [];
    const clamp = v => Math.max(-80, Math.min(80, Number.isFinite(Number(v)) ? Number(v) : 0));
    return [{ time: Math.max(0,Math.min(duration,time)), bone: frame.bone, rotation: { x:clamp(r.x), y:clamp(r.y), z:clamp(r.z) } }];
  }).sort((a,b)=>a.time-b.time);
  if (keyframes.length < 2) throw new Error('لم أستطع مطابقة الحركة مع عظام هذا الـ Rig. جرّب وصفًا أبسط.');
  return { title:String(motion.title || 'حركة جديدة').slice(0,100), explanation:String(motion.explanation || 'تم إنشاء الحركة.').slice(0,350), duration, keyframes };
}

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
  root=null; mixer=null; clips=[]; clipAction=null; bones=[]; original.clear(); generated=null; generatedPlaying=false; clipPlaying=false;
}
function frameModel(obj) {
  const bounds = new THREE.Box3().setFromObject(obj);
  if (bounds.isEmpty()) return;
  const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  obj.position.sub(center);
  const max = Math.max(size.x,size.y,size.z,0.1);
  camera.position.set(max*1.5,max*0.8,max*1.8);
  camera.near = max/1000; camera.far = max*100; camera.updateProjectionMatrix();
  orbit.target.set(0,0,0); orbit.update();
}
function setupModel(obj, animations, filename) {
  disposeModel(); root=obj; scene.add(root); clips=animations || [];
  frameModel(root);
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
    const data=await createMotion(prompt,bones.map(b=>b.name).filter(Boolean));
    generated=data; generatedPlaying=false; generatedTime=0;
    if (clipAction) { clipAction.stop(); clipPlaying=false; }
    // Start from the saved rest pose for predictable results.
    bones.forEach(b => { const r=original.get(b); if(r) b.rotation.copy(r); });
    $('motionTitle').textContent=data.title;
    $('motionExplanation').textContent=data.explanation;
    $('motionMeta').textContent=`المدة ${data.duration.toFixed(1)} ثانية • ${new Set(data.keyframes.map(k=>k.bone)).size} عظمة مستخدمة`;
    $('motionResult').hidden=false;
    $('playMotion').textContent='▶ تشغيل الحركة';
    status('تم إنشاء الحركة. اضغط تشغيل لمعاينتها.');
  } catch (err) { status(err.message || 'حدث خطأ غير متوقع.',true); }
  finally { $('generateBtn').disabled=!bones.length; $('generateBtn').textContent='✦ أنشئ الحركة بالذكاء الاصطناعي'; }
});

function startGenerated() {
  if (!generated) return;
  if (clipAction) { clipAction.stop(); clipPlaying=false; }
  bones.forEach(b => { const r=original.get(b); if(r) b.rotation.copy(r); });
  generatedTime=0; generatedPlaying=true; $('playMotion').textContent='❚❚ إيقاف مؤقت';
}
function stopGenerated() {
  generatedPlaying=false; generatedTime=0;
  bones.forEach(b => { const r=original.get(b); if(r) b.rotation.copy(r); });
  $('playMotion').textContent='▶ تشغيل الحركة';
}
$('playMotion').addEventListener('click', () => {
  if (!generated) return;
  if (generatedPlaying) { generatedPlaying=false; $('playMotion').textContent='▶ متابعة الحركة'; }
  else if (generatedTime>0) { generatedPlaying=true; $('playMotion').textContent='❚❚ إيقاف مؤقت'; }
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
function animateGenerated(dt) {
  if (!generated || !root) return;
  if (generatedPlaying) {
    generatedTime += dt * generatedSpeed;
    if (generatedTime >= generated.duration) {
      generatedTime = generated.duration; generatedPlaying=false;
      $('playMotion').textContent='↻ إعادة التشغيل';
    }
  }
  const t=generatedTime;
  const grouped=new Map();
  for (const frame of generated.keyframes) {
    if(!grouped.has(frame.bone)) grouped.set(frame.bone,[]);
    grouped.get(frame.bone).push(frame);
  }
  for (const [name, frames] of grouped) {
    const bone=bones.find(b=>b.name===name); if(!bone) continue;
    frames.sort((a,b)=>a.time-b.time);
    let left=frames[0], right=frames[frames.length-1];
    for(let i=0;i<frames.length-1;i++) if(t>=frames[i].time && t<=frames[i+1].time){left=frames[i];right=frames[i+1];break;}
    let u=right.time===left.time?0:THREE.MathUtils.clamp((t-left.time)/(right.time-left.time),0,1);
    // Smoothstep interpolation for less abrupt motion.
    u=u*u*(3-2*u);
    const rest=original.get(bone) || new THREE.Euler();
    const lerpAxis=(axis)=>THREE.MathUtils.degToRad(THREE.MathUtils.lerp(left.rotation[axis],right.rotation[axis],u));
    bone.rotation.set(rest.x+lerpAxis('x'),rest.y+lerpAxis('y'),rest.z+lerpAxis('z'),bone.rotation.order);
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
