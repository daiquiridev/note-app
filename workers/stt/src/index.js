export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const auth = request.headers.get("Authorization") || "";
    if (!(await safeEqual(auth, `Bearer ${env.STT_SECRET}`))) return new Response("Unauthorized", { status: 401 });

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
  },
};

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
