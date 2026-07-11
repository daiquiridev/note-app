export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const auth = request.headers.get("Authorization") || "";
    if (!(await safeEqual(auth, `Bearer ${env.STT_SECRET}`))) return new Response("Unauthorized", { status: 401 });

    const path = new URL(request.url).pathname;
    if (path === "/summarize") return handleSummarize(request, env);
    return handleTranscribe(request, env);
  },
};

async function handleTranscribe(request, env) {
  const lang = new URL(request.url).searchParams.get("lang") || "tr";
  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength) return new Response(JSON.stringify({ error: "Boş ses verisi" }), { status: 400 });

  const audio = arrayBufferToBase64(buffer);
  try {
    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio, language: lang, task: "transcribe",
    });
    return new Response(JSON.stringify({ text: result.transcription_info?.text || result.text || "" }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("whisper error:", e); // detay yalnızca worker loguna — istemciye sızdırma
    return new Response(JSON.stringify({ error: "STT servisi geçici olarak başarısız" }), { status: 500 });
  }
}

async function handleSummarize(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: "Geçersiz JSON" }), { status: 400 }); }
  const text = String(body?.text || "").trim();
  if (!text) return new Response(JSON.stringify({ error: "Boş metin" }), { status: 400 });
  if (text.length > 20000) return new Response(JSON.stringify({ error: "Metin çok uzun" }), { status: 400 });

  const prompt = `Aşağıdaki toplantı/not metnini Türkçe olarak özetle.

Kurallar:
- Önce 3-5 maddelik kısa bir özet yaz (madde işaretiyle, "-").
- Ardından tam olarak "AKSIYONLAR:" başlığı altında, metinde geçen somut yapılacaklar için "- [ ] " ile başlayan satırlar yaz. Hiç aksiyon yoksa bu başlığı hiç yazma.
- Başka hiçbir başlık, giriş cümlesi veya yorum ekleme.

Metin:
"""
${text}
"""`;

  try {
    const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1024,
    });
    const out = (result.response || "").trim();
    if (!out) throw new Error("boş model yanıtı");
    return new Response(JSON.stringify({ text: out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("summarize error:", e);
    return new Response(JSON.stringify({ error: "Özetleme servisi geçici olarak başarısız" }), { status: 500 });
  }
}

/* sabit-zamanlı karşılaştırma: iki değeri SHA-256'dan geçirip digest'leri XOR'la —
   uzunluk ve içerik farkı yanıt süresine yansımaz */
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
