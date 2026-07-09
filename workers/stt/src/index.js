export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${env.STT_SECRET}`) return new Response("Unauthorized", { status: 401 });

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
      return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
    }
  },
};

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
