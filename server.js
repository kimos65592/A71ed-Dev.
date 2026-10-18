import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
// For local Acode development: a key entered in the UI stays in server memory only.
// It is never written to disk and is cleared when the server restarts.
let runtimeApiKey = process.env.GROQ_API_KEY || '';

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://unpkg.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "https://unpkg.com"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: '32kb' }));
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'طلبات كثيرة في وقت قصير. انتظر دقيقة ثم جرّب مرة أخرى.' }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, configured: Boolean(runtimeApiKey), model: MODEL });
});

// Local-development convenience: accept the key from the settings panel.
// Do not expose this endpoint on a public server without authentication.
app.post('/api/settings/key', (req, res) => {
  const key = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!key || key.length < 15 || key.length > 500 || /\s/.test(key)) {
    return res.status(400).json({ error: 'أدخل مفتاح API صالحًا.' });
  }
  runtimeApiKey = key;
  res.json({ ok: true, configured: true });
});

app.delete('/api/settings/key', (_req, res) => {
  runtimeApiKey = '';
  res.json({ ok: true, configured: false });
});

function validateInput(body) {
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  const bones = Array.isArray(body?.bones) ? body.bones : [];
  const history = Array.isArray(body?.history) ? body.history : [];
  if (!prompt || prompt.length > 700) return { error: 'اكتب وصفًا للحركة لا يتجاوز 700 حرف.' };
  if (!bones.length || bones.length > 300) return { error: 'ارفع مجسمًا يحتوي على عظام Rig أولًا.' };
  const cleanBones = [...new Set(bones.map(n => typeof n === 'string' ? n : n?.name).filter(n => typeof n === 'string').map(n => n.trim()).filter(n => n.length && n.length <= 100))].slice(0, 300);
  if (!cleanBones.length) return { error: 'لم تصل أسماء عظام صالحة من المجسم.' };
  const hierarchy = bones.filter(b => b && typeof b === 'object' && typeof b.name === 'string')
    .slice(0, 300).map(b => ({ name: b.name.slice(0,100), parent: typeof b.parent === 'string' ? b.parent.slice(0,100) : null }));
  const cleanHistory = history.filter(x => typeof x === 'string').slice(-5).map(x => x.slice(0,300));
  return { prompt, bones: cleanBones, hierarchy, history: cleanHistory };
}

app.post('/api/motion', async (req, res) => {
  if (!runtimeApiKey) {
    return res.status(503).json({ error: 'مفتاح Groq غير مضبوط. انسخ .env.example إلى .env وضع المفتاح في GROQ_API_KEY ثم أعد تشغيل السيرفر.' });
  }
  const input = validateInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  const boneList = input.bones.map(n => JSON.stringify(n)).join(', ');
  const hierarchyText = input.hierarchy.length
    ? input.hierarchy.map(b => `${b.name} <- ${b.parent || '(root)'}`).join('\\n')
    : 'No hierarchy metadata supplied.';
  const historyText = input.history.length
    ? input.history.map((x, i) => `${i + 1}. ${x}`).join('\\n')
    : 'No previous commands.';
  const system = `You are an expert character animator and procedural animation planner for Three.js. Convert the Arabic request into a coordinated, anatomically plausible FULL-BODY motion. The response format is json.
Return ONLY valid JSON with this exact shape:
{"title":"short Arabic title","explanation":"short Arabic explanation","duration":3.5,"keyframes":[{"time":0,"bone":"EXACT_BONE_NAME","rotation":{"x":0,"y":0,"z":0}}],"rootMotion":[{"time":0,"position":{"x":0,"y":0,"z":0}}]}
Rules:
- Use ONLY exact bone names from the allowlist. Never invent a bone.
- Bone rotations are LOCAL Euler offsets in DEGREES from the model's original/rest pose.
- Use the hierarchy and names to identify pelvis/hips, spine, chest, neck, head, clavicles, shoulders, upper arms, forearms, hands, fingers, thighs, calves, feet, and toes when available. Respect parent-child relationships and opposite left/right sides.
- Animate coordinated chains, not isolated bones: for a whole-body action generally use 12-24 relevant bones; for a small gesture use 4-10. Never animate every bone indiscriminately.
- Build a readable action arc: anticipation/preparation, main action, follow-through, and recovery/settle. Use 5-10 temporal samples for major body parts, with synchronized timing between torso, arms, legs, head and hands. Do not make all bones peak at the same instant.
- Return a time 0 key and final key for every animated bone. For neutral return, use zero offsets at the end; for held poses, keep the requested pose through the final key.
- Smooth, human-like timing: ease in/out; avoid sudden jumps, mirrored robotic movement, extreme twisting, and disconnected limbs. Small secondary motion in head, torso, hands, and shoulders is welcome when appropriate.
- Walk/run: alternate opposite arm/leg swing, bend knees, use hip/torso counter-rotation, subtle foot lift and body bounce. Jump: crouch/anticipate, extend legs and arms, rise, land with bent knees, recover.
- Combat: include stance/guard, torso and hip rotation, shoulder and elbow sequencing, wrist/hand follow-through, weight shift and recovery. For a punch, hips/torso initiate before shoulder/elbow; for a block, protect head/torso and set both arms appropriately.
- Interpret follow-up commands using the prior command history. If the user says "then", "after that", "continue", or refers to "it", maintain the current action/pose context and make the next motion coherent rather than starting an unrelated animation.
- rootMotion is optional. If needed for walking/running/jumping/forward/backward/sideways movement, return 3-7 samples with position x/y/z as normalized fractions of the character's total height, relative to its starting point. Keep each component within -0.8 to 0.8. Use y for jump height; use x/z for horizontal movement. For in-place actions, return [] or omit rootMotion.
- Keep duration between 1 and 12 seconds.
- Keep each rotation axis within -75 to 75 degrees; head/neck/wrist/fingers within -40 to 40 degrees.
- Maximum 240 keyframe entries, maximum 24 distinct bones, maximum 8 rootMotion entries.
- Never output code, markdown fences, extra keys, or instructions. Output json only.`; 
  const user = \`طلب الحركة الحالي بالعربية: \${input.prompt}
سياق الأوامر السابقة (من الأقدم إلى الأحدث):
\${historyText}
أسماء العظام المسموح بها (استخدم الاسم حرفيًا فقط): [\${boneList}]
علاقة العظام (اسم العظمة <- اسم الأب):
\${hierarchyText}
أنشئ حركة كاملة قابلة للتطبيق على هذا الـ Rig، مع مراعاة أن rootMotion اختياري ويجب أن يكون مصفوفة فارغة إذا لم تلزم حركة انتقالية.\`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${runtimeApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.25,
        max_tokens: 6000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      }),
      signal: AbortSignal.timeout(45000)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.error?.message || `Groq returned HTTP ${response.status}`;
      console.error('Groq API error:', response.status, detail);
      return res.status(502).json({ error: 'تعذر إنشاء الحركة من Groq. راجع المفتاح أو إعدادات الموديل، ثم حاول مرة أخرى.' });
    }
    const content = payload?.choices?.[0]?.message?.content;
    let motion;
    try { motion = JSON.parse(content); }
    catch { return res.status(502).json({ error: 'الذكاء الاصطناعي أعاد صيغة غير صالحة. أعد المحاولة بوصف أبسط.' }); }

    // Validate and clamp generated data before it reaches the browser.
    const allowed = new Set(input.bones);
    const duration = Math.max(1, Math.min(12, Number(motion.duration) || 3.5));
    const rawFrames = Array.isArray(motion.keyframes) ? motion.keyframes.slice(0, 240) : [];
    const keyframes = [];
    const usedBones = new Set();
    for (const frame of rawFrames) {
      if (!frame || typeof frame.bone !== 'string' || !allowed.has(frame.bone)) continue;
      const time = Number(frame.time);
      const r = frame.rotation || {};
      if (!Number.isFinite(time)) continue;
      if (!usedBones.has(frame.bone) && usedBones.size >= 24) continue;
      const clamp = (v) => Math.max(-75, Math.min(75, Number.isFinite(Number(v)) ? Number(v) : 0));
      keyframes.push({
        time: Math.max(0, Math.min(duration, time)),
        bone: frame.bone,
        rotation: { x: clamp(Number(r.x)), y: clamp(Number(r.y)), z: clamp(Number(r.z)) }
      });
      usedBones.add(frame.bone);
      if (keyframes.length >= 240) break;
    }
    if (keyframes.length < 2) {
      return res.status(502).json({ error: 'لم أستطع مطابقة الحركة مع عظام هذا الـ Rig. جرّب وصفًا أبسط أو أسماء عظام أوضح.' });
    }
    keyframes.sort((a, b) => a.time - b.time);
    const rawRoot = Array.isArray(motion.rootMotion) ? motion.rootMotion.slice(0, 8) : [];
    const rootMotion = rawRoot.map(f => {
      const p = f?.position || {};
      const num = v => Math.max(-0.8, Math.min(0.8, Number.isFinite(Number(v)) ? Number(v) : 0));
      return { time: Math.max(0, Math.min(duration, Number(f?.time) || 0)), position: { x: num(p.x), y: num(p.y), z: num(p.z) } };
    }).sort((a,b) => a.time-b.time);
    res.json({
      title: String(motion.title || 'حركة جديدة').slice(0, 100),
      explanation: String(motion.explanation || 'تم إنشاء الحركة.').slice(0, 350),
      duration,
      keyframes,
      rootMotion
    });
  } catch (err) {
    console.error('Motion generation failed:', err?.message || err);
    res.status(504).json({ error: 'انتهت مهلة الاتصال أو تعذر الوصول إلى Groq. تحقق من الإنترنت ثم أعد المحاولة.' });
  }
});

app.listen(PORT, () => {
  console.log(`Groq Rig Studio is running at http://localhost:${PORT}`);
  console.log(`Groq API key configured: ${Boolean(runtimeApiKey)}`);
});
